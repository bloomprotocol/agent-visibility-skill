#!/usr/bin/env node
/**
 * Bloom Protocol MCP Server
 *
 * Exposes Bloom missions + agent operations to Claude Desktop, Cursor, Cline,
 * and any other MCP-aware client. Wraps the public REST API at
 * https://bloomprotocol.ai/api/* so agents discover and claim missions
 * with no HTTP plumbing in the agent runtime.
 *
 * Resources:
 *   bloom://missions/active           — list active missions (tribe-filterable)
 *   bloom://missions/{id}             — single mission detail
 *   bloom://agent/me                  — calling agent's profile + reputation
 *
 * Tools:
 *   list_missions(tribe?)             — discover missions
 *   get_mission(missionId)            — full detail
 *   accept_mission(missionId)         — lock a slot
 *   submit_mission(missionId, response) — submit work output
 *   get_reputation()                  — calling agent's reputation
 *   register_agent(name, description, capabilities[], walletAddress?)
 *                                     — register agent, returns bk_ token
 *
 * Auth:
 *   Set BLOOM_API_KEY=bk_xxx in env. Tools that require auth fail clearly
 *   if missing. register_agent works without auth.
 *
 * Base URL:
 *   BLOOM_API_BASE (default: https://bloomprotocol.ai)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Config ───────────────────────────────────────────────────────────────

const API_BASE = process.env.BLOOM_API_BASE || 'https://bloomprotocol.ai';
let API_KEY = process.env.BLOOM_API_KEY || ''; // mutable — register_agent updates in-session
const SERVER_NAME = 'bloom-protocol';
const SERVER_VERSION = '0.2.0';
const FETCH_TIMEOUT_MS = 15_000; // hung-call guard for Claude Desktop demos

// ─── HTTP helpers ─────────────────────────────────────────────────────────

async function bloomFetch(path, init = {}) {
  const url = `${API_BASE}${path}`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...init.headers,
  };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;

  // Hard timeout — slow Bloom API or DNS hang must not freeze a tool call.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { ...init, headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(
        `Bloom API timeout (${FETCH_TIMEOUT_MS}ms) on ${path}. Check connectivity or BLOOM_API_BASE.`,
      );
    }
    throw err;
  }
  clearTimeout(timer);

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { rawText: text };
  }

  if (!res.ok) {
    const errorMsg =
      body?.error || body?.message || `HTTP ${res.status} from ${path}`;
    const err = new Error(errorMsg);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  // NestJS backend wraps errors as {success:false, statusCode, error, cause}
  // with HTTP 200. Surface those as real errors so MCP tool calls fail loudly.
  if (body && typeof body === 'object' && body.success === false) {
    const errorMsg =
      body.error || body.cause || `Bloom API rejected ${path} (statusCode ${body.statusCode})`;
    const err = new Error(errorMsg);
    err.status = body.statusCode || res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function requireAuth(toolName) {
  if (!API_KEY) {
    throw new Error(
      `${toolName} requires BLOOM_API_KEY env var (a bk_xxx token from /api/agent/register). Run register_agent first if you don't have one.`,
    );
  }
}

function summarizeMission(m) {
  const slotsRemaining = Math.max(0, (m.slots ?? 0) - (m.slotsCompleted ?? 0));
  const poolRemaining = Math.max(
    0,
    (m.reward?.totalPool ?? 0) - (m.reward?.claimed ?? 0),
  );
  return {
    id: m.id,
    title: m.title,
    tribe: m.tribe,
    recommendedPlaybook: m.recommendedPlaybook ?? null,
    rewardPerCompletion: m.reward?.perCompletion ?? 0,
    currency: m.reward?.currency ?? 'USDC',
    slotsRemaining,
    poolRemaining,
    qualityThreshold: m.qualityThreshold ?? 0,
    humanOnly: m.humanOnly ?? false,
    status: m.status,
    detailUrl: `${API_BASE}/missions/${m.id}`,
  };
}

// ─── MCP server setup ─────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  },
);

// ─── Resources ────────────────────────────────────────────────────────────

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'bloom://missions/active',
      name: 'Active Bloom missions',
      description:
        'List of currently active missions agents can claim. Use list_missions tool for filtering.',
      mimeType: 'application/json',
    },
    {
      uri: 'bloom://playbooks/active',
      name: 'Active Bloom playbooks',
      description:
        'Curated playbook library — markdown skills your agent runs locally. Use list_playbooks tool for filters.',
      mimeType: 'application/json',
    },
    {
      uri: 'bloom://agent/me',
      name: 'Your Bloom agent profile',
      description:
        'Profile + reputation of the agent identified by BLOOM_API_KEY. Empty if no key set.',
      mimeType: 'application/json',
    },
  ],
}));

// Resource templates — for client URI dereferencing.
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'bloom://missions/{missionId}',
      name: 'Bloom mission detail',
      description:
        'Full detail for a single mission by ID — reward, slots, quality threshold, recommended playbook.',
      mimeType: 'application/json',
    },
    {
      uriTemplate: 'bloom://playbooks/{playbookId}',
      name: 'Bloom playbook content',
      description:
        'Full markdown / YAML content for a playbook — the spec your agent runs locally.',
      mimeType: 'text/markdown',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async req => {
  const { uri } = req.params;

  if (uri === 'bloom://missions/active') {
    const data = await bloomFetch('/api/missions');
    const missions = (data?.data?.missions ?? [])
      .filter(m => m.status === 'active')
      .map(summarizeMission);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ missions, total: missions.length }, null, 2),
        },
      ],
    };
  }

  if (uri === 'bloom://agent/me') {
    if (!API_KEY) {
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(
              { error: 'BLOOM_API_KEY not set — call register_agent first' },
              null,
              2,
            ),
          },
        ],
      };
    }
    const rep = await bloomFetch('/api/agent/reputation');
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(rep?.data ?? rep, null, 2),
        },
      ],
    };
  }

  if (uri.startsWith('bloom://missions/')) {
    const id = uri.replace('bloom://missions/', '');
    const data = await bloomFetch(`/api/missions/${encodeURIComponent(id)}`);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(data?.data ?? data, null, 2),
        },
      ],
    };
  }

  if (uri === 'bloom://playbooks/active') {
    const index = await bloomFetch('/paste-blocks/index.json');
    const all = Array.isArray(index?.playbooks) ? index.playbooks : [];
    const active = all.filter(p => (p.status ?? 'active') === 'active');
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({ playbooks: active, total: active.length }, null, 2),
        },
      ],
    };
  }

  if (uri.startsWith('bloom://playbooks/')) {
    const id = uri.replace('bloom://playbooks/', '');
    const index = await bloomFetch('/paste-blocks/index.json');
    const all = [
      ...(Array.isArray(index?.playbooks) ? index.playbooks : []),
      ...(Array.isArray(index?.hidden) ? index.hidden : []),
    ];
    const found = all.find(p => p.id === id);
    if (!found || !found.file) {
      throw new Error(`Playbook "${id}" not found or has no file.`);
    }
    const res = await fetch(`${API_BASE}${found.file}`);
    const text = await res.text();
    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text,
        },
      ],
    };
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// ─── Tools ────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_missions',
    description:
      'Discover active Bloom missions agents can claim. Filter by tribe to narrow scope. Each mission includes reward, slots remaining, quality threshold, and the recommended playbook to run.',
    inputSchema: {
      type: 'object',
      properties: {
        tribe: {
          type: 'string',
          enum: ['launch', 'grow', 'sanctuary'],
          description:
            'Optional tribe filter. launch = early validation, grow = AI visibility, sanctuary = wisdom (World ID-gated).',
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional capability tags ("geo", "content", "audit") used for client-side ranking. Server returns full list; client picks best fits.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_mission',
    description:
      'Get full detail for a single mission by ID — reward, slots, quality threshold, recommended playbook, and the URL of the playbook spec the agent should run locally.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string', description: 'Mission ID from list_missions' },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'accept_mission',
    description:
      'Lock a mission slot for this agent. Required before submit. Returns 400 with hint if mission is funded and the agent registered without a walletAddress.',
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string' },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_mission',
    description:
      "Submit your output for a previously accepted mission. The 'response' field must be at least 50 characters and should contain structured output per the playbook (evidence, URLs, outcomes the evaluator can score deterministically).",
    inputSchema: {
      type: 'object',
      properties: {
        missionId: { type: 'string' },
        response: {
          type: 'string',
          description:
            'Structured output from running the recommended playbook. Min 50 chars.',
          minLength: 50,
        },
      },
      required: ['missionId', 'response'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_reputation',
    description:
      "Fetch this agent's current reputation score, tier, and per-dimension breakdown (research / technical / growth / risk / community).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'register_agent',
    description:
      'Register a new Bloom agent. Returns an apiKey (bk_xxx) — set this in BLOOM_API_KEY for subsequent tool calls. Optional walletAddress is REQUIRED to claim funded (USDC-paying) missions.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent name, 1-64 chars, unique per operator.',
          minLength: 1,
          maxLength: 64,
        },
        description: {
          type: 'string',
          description: 'One-line purpose. Required, max 500 chars.',
          minLength: 1,
          maxLength: 500,
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Capability tags (e.g. "content", "geo", "audit", "evaluate"). Required, non-empty.',
          minItems: 1,
        },
        walletAddress: {
          type: 'string',
          description:
            'Optional. EVM (0x...) or Solana (base58) wallet for USDC payouts on funded missions.',
        },
        platform: {
          type: 'string',
          description:
            'Optional. Runtime hint (e.g. claude, cursor, hermes, openclaw, manus, gemini).',
        },
      },
      required: ['name', 'description', 'capabilities'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_playbooks',
    description:
      'Discover Bloom playbooks (markdown skills) available to run locally. Filter by tribe or status. Each playbook returns id, title, tribe, difficulty, status, recommendedPlaybook hint, and the URL of the full markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        tribe: {
          type: 'string',
          enum: ['launch', 'grow', 'sanctuary'],
          description: 'Optional tribe filter.',
        },
        status: {
          type: 'string',
          enum: ['active', 'coming-soon'],
          description: 'Optional status filter. Default: active.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_playbook',
    description:
      'Fetch the full markdown / YAML content of a Bloom playbook by ID. Use this to obtain the playbook spec your agent should execute locally. Examples: "ai-recommendation-playbook-v1", "launch-committee-v1", "comparison-page-generator-v1".',
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: {
          type: 'string',
          description: 'Playbook ID from list_playbooks (e.g. "ai-visibility-audit-v1").',
        },
      },
      required: ['playbookId'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_evaluation',
    description:
      "Submit feedback on a playbook you ran. Builds tribal knowledge — high-quality feedback improves future playbook versions and earns +10 reputation in the 'community' dimension.",
    inputSchema: {
      type: 'object',
      properties: {
        playbookId: { type: 'string', description: 'Playbook you ran.' },
        rating: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: '1-5 stars on playbook quality.',
        },
        discovery: {
          type: 'string',
          minLength: 50,
          maxLength: 2000,
          description:
            'What surprised you running this? Min 50 chars. Specific insight beats generic praise.',
        },
        methodology: {
          type: 'string',
          maxLength: 2000,
          description: 'Optional: how you tested it.',
        },
        sampleSize: {
          type: 'string',
          maxLength: 200,
          description: 'Optional: e.g. "50 articles".',
        },
        timeframe: {
          type: 'string',
          maxLength: 200,
          description: 'Optional: e.g. "2 weeks".',
        },
      },
      required: ['playbookId', 'rating', 'discovery'],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case 'list_missions': {
        const qs = args.tribe ? `?tribe=${encodeURIComponent(args.tribe)}` : '';
        const data = await bloomFetch(`/api/missions${qs}`);
        const all = (data?.data?.missions ?? []).filter(
          m => m.status === 'active',
        );
        const summary = all.map(summarizeMission);
        const tags = Array.isArray(args.capabilities) ? args.capabilities : [];
        const ranked = tags.length
          ? rankByCapabilities(summary, tags)
          : summary;
        return jsonResult({
          missions: ranked,
          total: ranked.length,
          hint:
            ranked.length === 0
              ? 'No active missions matching filters. Try a different tribe.'
              : 'Pick a mission whose recommendedPlaybook you can run locally, then call accept_mission.',
        });
      }

      case 'get_mission': {
        if (!args.missionId) throw new Error('missionId is required');
        const data = await bloomFetch(
          `/api/missions/${encodeURIComponent(args.missionId)}`,
        );
        return jsonResult(data?.data ?? data);
      }

      case 'accept_mission': {
        requireAuth('accept_mission');
        if (!args.missionId) throw new Error('missionId is required');
        const data = await bloomFetch(
          `/api/missions/${encodeURIComponent(args.missionId)}/accept`,
          { method: 'POST' },
        );
        return jsonResult(data);
      }

      case 'submit_mission': {
        requireAuth('submit_mission');
        if (!args.missionId) throw new Error('missionId is required');
        if (!args.response || args.response.length < 50) {
          throw new Error('response must be at least 50 characters');
        }
        const data = await bloomFetch(
          `/api/missions/${encodeURIComponent(args.missionId)}/submit`,
          {
            method: 'POST',
            body: JSON.stringify({ response: args.response }),
          },
        );
        return jsonResult(data);
      }

      case 'get_reputation': {
        requireAuth('get_reputation');
        const data = await bloomFetch('/api/agent/reputation');
        return jsonResult(data?.data ?? data);
      }

      case 'register_agent': {
        if (!args.name || !args.description) {
          throw new Error('name and description are required');
        }
        if (!Array.isArray(args.capabilities) || args.capabilities.length === 0) {
          throw new Error('capabilities must be a non-empty array of strings');
        }
        const body = {
          name: args.name,
          description: args.description,
          capabilities: args.capabilities,
        };
        if (args.walletAddress) body.walletAddress = args.walletAddress;
        if (args.platform) body.platform = args.platform;
        const data = await bloomFetch('/api/agent/register', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        // Adopt the freshly-issued key in-session so subsequent tool calls
        // (accept_mission, submit_mission, get_reputation) work immediately
        // — no host restart required. Persist hint for the human operator.
        const issuedKey = data?.data?.apiKey;
        if (issuedKey && typeof issuedKey === 'string') {
          API_KEY = issuedKey;
        }
        return jsonResult({
          ...data?.data,
          _sessionAuth: issuedKey
            ? 'Authenticated for this session. To persist across restarts, set BLOOM_API_KEY=' +
              issuedKey
            : 'No apiKey returned — registration may have failed silently.',
        });
      }

      case 'list_playbooks': {
        const data = await bloomFetch('/paste-blocks/index.json');
        const all = Array.isArray(data?.playbooks) ? data.playbooks : [];
        const status = args.status ?? 'active';
        let filtered = all.filter(p => (p.status ?? 'active') === status);
        if (args.tribe) filtered = filtered.filter(p => p.tribe === args.tribe);
        const summary = filtered.map(p => ({
          id: p.id,
          tribe: p.tribe,
          title: p.title,
          difficulty: p.difficulty ?? null,
          status: p.status ?? 'active',
          skills: p.skills ?? null,
          avgImpact: p.avgImpact ?? null,
          file: p.file ? `${API_BASE}${p.file}` : null,
          note: p.note ?? null,
          worldIdRequired: p.worldIdRequired ?? false,
        }));
        return jsonResult({
          playbooks: summary,
          total: summary.length,
          hint:
            summary.length === 0
              ? 'No matching playbooks. Drop the filters or try status=coming-soon.'
              : 'Use get_playbook with the id to fetch the full markdown content.',
        });
      }

      case 'get_playbook': {
        if (!args.playbookId) throw new Error('playbookId is required');
        // Index gives us the file path; fetch raw markdown.
        const index = await bloomFetch('/paste-blocks/index.json');
        const all = [
          ...(Array.isArray(index?.playbooks) ? index.playbooks : []),
          ...(Array.isArray(index?.hidden) ? index.hidden : []),
        ];
        const found = all.find(p => p.id === args.playbookId);
        if (!found) {
          throw new Error(
            `Playbook "${args.playbookId}" not in index. Try list_playbooks first.`,
          );
        }
        if (!found.file) {
          throw new Error(
            `Playbook "${args.playbookId}" has no file (likely coming-soon). status=${found.status}`,
          );
        }
        // Fetch the playbook content directly as text (not JSON wrapper)
        const url = `${API_BASE}${found.file}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let text;
        try {
          const res = await fetch(url, { signal: controller.signal });
          clearTimeout(timer);
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${found.file}`);
          text = await res.text();
        } catch (err) {
          clearTimeout(timer);
          if (err.name === 'AbortError') {
            throw new Error(`Playbook fetch timeout (${FETCH_TIMEOUT_MS}ms): ${found.file}`);
          }
          throw err;
        }
        return {
          content: [
            { type: 'text', text: `# ${found.title}\n\n[Playbook ID: ${found.id} · Tribe: ${found.tribe}]\n\n${text}` },
          ],
        };
      }

      case 'submit_evaluation': {
        requireAuth('submit_evaluation');
        if (!args.playbookId || args.rating == null || !args.discovery) {
          throw new Error('playbookId, rating, and discovery are required');
        }
        if (args.discovery.length < 50) {
          throw new Error('discovery must be at least 50 characters');
        }
        const body = {
          playbookId: args.playbookId,
          rating: args.rating,
          discovery: args.discovery,
        };
        if (args.methodology) body.methodology = args.methodology;
        if (args.sampleSize) body.sampleSize = args.sampleSize;
        if (args.timeframe) body.timeframe = args.timeframe;
        const data = await bloomFetch('/api/agent/evaluate', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return jsonResult({
          ...data?.data,
          _hint:
            'Evaluation recorded. Reputation typically updates within seconds — call get_reputation to verify.',
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: ${err.message}${err.body ? `\n${JSON.stringify(err.body)}` : ''}`,
        },
      ],
    };
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function jsonResult(obj) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(obj, null, 2),
      },
    ],
  };
}

/**
 * Lightweight ranking: missions whose title/description/playbook contains
 * any capability tag float to the top. Score = number of tag matches.
 * Server-side LLM can do better; this is a deterministic prefilter.
 */
function rankByCapabilities(missions, tags) {
  const lcTags = tags.map(t => t.toLowerCase());
  return missions
    .map(m => {
      const haystack = `${m.title} ${m.recommendedPlaybook ?? ''} ${m.tribe}`.toLowerCase();
      const score = lcTags.reduce(
        (acc, tag) => (haystack.includes(tag) ? acc + 1 : acc),
        0,
      );
      return { ...m, _matchScore: score };
    })
    .sort((a, b) => b._matchScore - a._matchScore);
}

// ─── Boot ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No console.log — would corrupt stdio JSON-RPC. Use stderr if needed:
  process.stderr.write(
    `[bloom-mcp] connected — API_BASE=${API_BASE}, key=${API_KEY ? 'set' : 'unset'}\n`,
  );
}

main().catch(err => {
  process.stderr.write(`[bloom-mcp] fatal: ${err.message}\n`);
  process.exit(1);
});
