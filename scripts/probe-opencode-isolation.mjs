import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { OpenCode } from '@opencode/client';
import { stopOpenCodeChild } from '../packages/web/server/lib/engine/opencode/platform.js';

const binary = process.argv[2];
if (!binary) throw new Error('Pass the OpenCode binary path');
const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-isolation-'));
const children = [];
const seen = new Set();
const requests = new EventEmitter();
const mcp = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  seen.add(`${req.url}|${req.headers.authorization}`);
  requests.emit('authorization');
  if (!('id' in message)) { res.writeHead(202).end(); return; }
  const result = message.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
    : { tools: [] };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
});
mcp.listen(0, '127.0.0.1');
await once(mcp, 'listening');
const mcpUrl = `http://127.0.0.1:${mcp.address().port}/mcp`;
const waitForToken = async (token, label) => {
  while (!seen.has(`/mcp/${label}|${token}`)) await once(requests, 'authorization', { signal: AbortSignal.timeout(15000) });
};
const start = async (token, label) => {
  const password = randomUUID();
  const config = path.join(directory, `${randomUUID()}.json`);
  await writeFile(config, JSON.stringify({ mcp: { servers: { openchamber_probe: { type: 'remote', url: `${mcpUrl}/${label}`, headers: { Authorization: token } } } } }));
  const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, env: { ...process.env, OPENCODE_CONFIG: config, OPENCODE_SERVER_PASSWORD: password }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Startup timed out')), 15000);
    const receive = (chunk) => { output += chunk; const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) { clearTimeout(timer); resolve(url); } };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', reject);
  });
  return OpenCode.make({ baseUrl: endpoint, headers: { 'x-opencode-directory': encodeURIComponent(directory), Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
};
try {
  const tokenA = `Bearer ${randomUUID()}`;
  const tokenB = `Bearer ${randomUUID()}`;
  const a = await start(tokenA, 'a');
  const sessionA = await a.session.create({ title: 'Isolation A', location: { directory } });
  await a.mcp.list({ location: { directory } });
  await waitForToken(tokenA, 'a');
  assert(seen.has(`/mcp/a|${tokenA}`), 'First service must load its MCP authorization');
  seen.clear();
  const b = await start(tokenB, 'b');
  const sessionB = await b.session.create({ title: 'Isolation B', location: { directory } });
  await b.mcp.list({ location: { directory } });
  await waitForToken(tokenB, 'b');
  assert(seen.has(`/mcp/b|${tokenB}`), 'Second service must load its own MCP authorization');
  assert(!seen.has(`/mcp/b|${tokenA}`), 'Second endpoint must not receive first service authorization');
  assert.notEqual(sessionA.id, sessionB.id);
  const resumed = await b.session.get({ sessionID: sessionA.id });
  assert.equal(resumed.id, sessionA.id, 'A second process can read the stored conversation');
  process.stdout.write(JSON.stringify({ configIsolation: true, concurrentSessionStorage: true, crossProcessResumeLookup: true }) + '\n');
} finally {
  await Promise.all(children.map(stopOpenCodeChild));
  await Promise.all(children.map((child) => child.exitCode !== null ? undefined : once(child, 'exit')));
  mcp.closeAllConnections();
  mcp.close();
}
