#!/usr/bin/env node
/**
 * Smoke test for Bloom MCP Server.
 *
 * Spawns the server as a subprocess via stdio, sends initialize +
 * tools/list + resources/list + tool calls, asserts shape.
 *
 * Run via:
 *   npm run smoke
 *
 * Bound to prepublishOnly so a broken server can't ship to npm.
 *
 * No Bloom credentials required — all assertions exercise read-only
 * surfaces and a sandboxed BLOOM_API_BASE = preflight.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SERVER = join(__dirname, 'server.mjs');
const API_BASE = process.env.BLOOM_API_BASE || 'https://preflight.bloomprotocol.ai';

const REQUESTS = [
  { id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0.0.1' } } },
  { id: 2, method: 'tools/list', params: {} },
  { id: 3, method: 'resources/list', params: {} },
  { id: 4, method: 'resources/templates/list', params: {} },
  { id: 5, method: 'tools/call', params: { name: 'list_missions', arguments: {} } },
  { id: 6, method: 'tools/call', params: { name: 'list_playbooks', arguments: { tribe: 'grow' } } },
];

const proc = spawn('node', [SERVER], {
  env: { ...process.env, BLOOM_API_BASE: API_BASE },
  stdio: ['pipe', 'pipe', 'pipe'],
});

const responses = new Map();
let buffer = '';

proc.stdout.on('data', chunk => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.id != null) responses.set(obj.id, obj);
    } catch {
      // ignore non-JSON
    }
  }
});

proc.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

for (const req of REQUESTS) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...req }) + '\n');
}

// Wait for all responses, max 10s
await new Promise(r => setTimeout(r, 8000));

proc.stdin.end();
proc.kill('SIGTERM');

let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`✓ ${label}`);
  } catch (err) {
    console.error(`✗ ${label} — ${err.message}`);
    failed++;
  }
}

check('initialize → server v0.2.0', () => {
  const r = responses.get(1)?.result;
  if (!r) throw new Error('no result');
  if (r.serverInfo?.name !== 'bloom-protocol') throw new Error(`name=${r.serverInfo?.name}`);
  if (r.serverInfo?.version !== '0.2.0') throw new Error(`version=${r.serverInfo?.version}`);
});

check('tools/list → 9 tools', () => {
  const tools = responses.get(2)?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('no tools array');
  if (tools.length !== 9) throw new Error(`got ${tools.length}`);
  const expected = ['list_missions', 'get_mission', 'accept_mission', 'submit_mission', 'get_reputation', 'register_agent', 'list_playbooks', 'get_playbook', 'submit_evaluation'];
  for (const name of expected) {
    if (!tools.find(t => t.name === name)) throw new Error(`missing ${name}`);
  }
});

check('resources/list → 3 resources', () => {
  const resources = responses.get(3)?.result?.resources;
  if (!Array.isArray(resources) || resources.length !== 3) throw new Error(`got ${resources?.length}`);
});

check('resources/templates/list → 2 templates', () => {
  const templates = responses.get(4)?.result?.resourceTemplates;
  if (!Array.isArray(templates) || templates.length !== 2) throw new Error(`got ${templates?.length}`);
});

check('list_missions → returns array', () => {
  const r = responses.get(5)?.result;
  if (r?.isError) throw new Error('tool returned isError');
  const text = r?.content?.[0]?.text;
  if (!text) throw new Error('no content text');
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.missions)) throw new Error('missions not array');
});

check('list_playbooks(tribe=grow) → returns array', () => {
  const r = responses.get(6)?.result;
  if (r?.isError) throw new Error('tool returned isError');
  const text = r?.content?.[0]?.text;
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.playbooks)) throw new Error('playbooks not array');
  if (parsed.playbooks.length === 0) throw new Error('no grow playbooks returned');
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
process.exit(0);
