import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OpenCode } from '@opencode/client';
import { EventEmitter, once } from 'node:events';
import { stopOpenCodeChild } from '../packages/web/server/lib/engine/opencode/platform.js';

// Run explicitly with a CLI path. Output contains capability metadata only;
// no credentials, model responses, raw server logs or user configuration.
const binary = process.argv[2];
if (!binary) throw new Error('Usage: node scripts/probe-opencode-engine.mjs <opencode-binary>');
const directory = await mkdtemp(path.join(os.tmpdir(), 'openchamber-opencode-probe-'));
const password = randomUUID();
const report = { cli: execFileSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), client: '2.0.29', checks: {} };
const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
  cwd: directory,
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const endpoint = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Service startup exceeded 15 seconds')), 15000);
  const receive = (data) => {
    output = (output + data.toString()).slice(-16000);
    const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (url) { clearTimeout(timer); resolve(url); }
  };
  child.stdout.on('data', receive);
  child.stderr.on('data', receive);
  child.once('error', (error) => { clearTimeout(timer); reject(error); });
  child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Service exited during startup (${code})`)); });
}).catch(async (error) => { await stopOpenCodeChild(child); throw error; });
const headers = {
  Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
  'x-opencode-directory': encodeURIComponent(directory),
};
const client = OpenCode.make({ baseUrl: endpoint, headers });
const events = [];
const signals = new EventEmitter();
let observedSessionId;
const controller = new AbortController();
const listen = async () => {
  try {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      signals.emit(event.type, event);
      if (observedSessionId && (event.data?.sessionID === observedSessionId || event.data?.sessionID === undefined && event.type === 'form.created')) events.push(event);
      if (event.type === 'permission.asked' && event.data.sessionID === observedSessionId) {
        await client.permission.reply({ sessionID: observedSessionId, requestID: event.data.id, decision: 'reject' });
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
};
const listening = listen();
const runPrompt = async (sessionID, text) => {
  const terminalTypes = ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'];
  const completed = new Promise((resolve, reject) => {
    const finish = (type) => { clearTimeout(timer); for (const name of terminalTypes) signals.off(name, handlers[name]); resolve(type); };
    const handlers = Object.fromEntries(terminalTypes.map((name) => [name, (event) => { if (event.data.sessionID === sessionID) finish(name); }]));
    for (const name of terminalTypes) signals.on(name, handlers[name]);
    const timer = setTimeout(() => { for (const name of terminalTypes) signals.off(name, handlers[name]); reject(new Error('No execution terminal event within 45 seconds')); }, 45000);
  });
  const [, outcome] = await Promise.all([client.session.prompt({ sessionID, text }, { signal: AbortSignal.timeout(45000) }), completed]);
  return outcome;
};
try {
  const models = await client.model.list({ location: { directory } });
  report.checks.catalog = { count: models.data.length, enabled: models.data.filter((m) => m.enabled).length };
  const defaultModel = await client.model.default({ location: { directory } });
  report.checks.default = defaultModel.data ? { providerID: defaultModel.data.providerID, id: defaultModel.data.id } : null;
  const session = await client.session.create({ title: 'OpenChamber protocol probe', location: { directory }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] });
  observedSessionId = session.id;
  report.checks.sessionCreate = { hasId: Boolean(session.id) };
  const forms = await client.form.list({ location: { directory } });
  report.checks.forms = { keys: Object.keys(forms) };
  const form = await client.session.form.create({ sessionID: session.id, title: 'Probe choice', fields: [{ key: 'choice', title: 'Choice', type: 'string', required: true }] });
  await client.session.form.reply({ sessionID: session.id, formID: form.id, answer: { choice: 'probe' } });
  const cancelled = await client.session.form.create({ sessionID: session.id, title: 'Probe cancellation', fields: [{ key: 'choice', type: 'string' }] });
  await client.session.form.cancel({ sessionID: session.id, formID: cancelled.id });
  report.checks.formReplyAndCancel = true;
  const permissionReplied = once(signals, 'permission.replied', { signal: AbortSignal.timeout(15000) });
  const permission = await client.permission.create({ sessionID: session.id, action: `openchamber_probe_${randomUUID()}`, resources: ['probe'] }, { signal: AbortSignal.timeout(15000) });
  await permissionReplied;
  report.checks.permission = { effect: permission.effect };
  if (process.argv.includes('--prompt')) {
    report.checks.textOutcome = await runPrompt(session.id, 'Reply with PROBE_OK only. Do not use tools or read any files.');
    report.checks.toolOutcome = await runPrompt(session.id, 'Use the bash tool to run pwd. Do not read any files. If permission is denied, reply DENIED and stop.');
    report.checks.eventTypes = [...new Set(events.map((event) => event.type))];
    const fixture = events.map((event) => JSON.parse(JSON.stringify(event).replaceAll(directory.replaceAll('\\', '\\\\'), '<probe-directory>').replaceAll(directory.replaceAll('\\', '/'), '<probe-directory>')));
    await writeFile(path.join(directory, 'events.json'), JSON.stringify(fixture, null, 2));
    report.fixture = path.join(directory, 'events.json');
  }
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.name, eventTypes: [...new Set(events.map((event) => event.type))] }) + '\n');
  throw error;
} finally {
  controller.abort();
  await stopOpenCodeChild(child);
  await listening.catch(() => {});
  await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once('exit', resolve));
}
