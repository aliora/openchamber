import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAgentProcessRegistry, createAgentScope } from './agent-scope.js';

const probe = (status) => {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    return { status };
  };
  return { calls, run };
};

describe('createAgentScope', () => {
  it('starts a CLI in its own systemd scope when the server runs as a systemd unit', () => {
    const { calls, run } = probe(0);
    const scope = createAgentScope({ platform: 'linux', env: { INVOCATION_ID: 'abc' }, run });

    expect(scope('/usr/bin/claude', ['-p', '--verbose'])).toEqual([
      'systemd-run',
      ['--user', '--scope', '--quiet', '--collect', '--', '/usr/bin/claude', '-p', '--verbose'],
    ]);
    scope('/usr/bin/codex', ['app-server']);
    // systemd-run is checked once per server.
    expect(calls).toEqual([['systemd-run', '--user', '--scope', '--quiet', '--collect', 'true']]);
  });

  it('spawns the CLI directly when systemd-run cannot start a scope', () => {
    const scope = createAgentScope({ platform: 'linux', env: { INVOCATION_ID: 'abc' }, run: probe(1).run });

    expect(scope('/usr/bin/claude', ['-p'])).toEqual(['/usr/bin/claude', ['-p']]);
  });

  it('spawns the CLI directly outside a systemd unit and off Linux', () => {
    const notInUnit = probe(0);
    const mac = probe(0);

    expect(createAgentScope({ platform: 'linux', env: {}, run: notInUnit.run })('claude', [])).toEqual(['claude', []]);
    expect(createAgentScope({ platform: 'darwin', env: { INVOCATION_ID: 'abc' }, run: mac.run })('claude', [])).toEqual(['claude', []]);
    expect([...notInUnit.calls, ...mac.calls]).toEqual([]);
  });
});

describe('createAgentProcessRegistry', () => {
  let dir;
  let file;
  let processes;
  let signals;

  // A fake process table: pid -> identity, and how each pid answers a signal.
  const registry = (options = {}) => createAgentProcessRegistry({
    file,
    readIdentity: (pid) => processes.get(pid)?.identity ?? null,
    signal: (pid, name) => {
      signals.push([pid, name]);
      if (processes.get(pid)?.exitsOn === name || name === 'SIGKILL') processes.delete(pid);
    },
    sleep: async () => {},
    exitWaitMs: 300,
    ...options,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-agent-scope-'));
    file = path.join(dir, 'agent-processes.json');
    processes = new Map();
    signals = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lets a new server stop the CLI the old one left running for the session', async () => {
    processes.set(41, { identity: 'boot:100', exitsOn: 'SIGINT' });
    await registry().record('ses_1', 41);

    // A restart: the next server reads the same file.
    const next = registry();
    await next.stopLeftover('ses_1');

    expect(signals).toEqual([[41, 'SIGINT']]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('kills a leftover that does not stop on SIGINT', async () => {
    processes.set(41, { identity: 'boot:100' });
    await registry().record('ses_1', 41);

    await registry().stopLeftover('ses_1');

    expect(signals).toEqual([[41, 'SIGINT'], [41, 'SIGKILL']]);
  });

  it('leaves alone a pid that now belongs to another process', async () => {
    processes.set(41, { identity: 'boot:100' });
    await registry().record('ses_1', 41);
    processes.set(41, { identity: 'boot:900' });

    await registry().stopLeftover('ses_1');

    expect(signals).toEqual([]);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('forgets a process only while it is still the one recorded for the session', async () => {
    processes.set(41, { identity: 'boot:100' });
    processes.set(42, { identity: 'boot:200' });
    const agents = registry();
    await agents.record('ses_1', 41);
    await agents.record('ses_1', 42);

    await agents.forget('ses_1', 41);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ ses_1: { pid: 42, identity: 'boot:200' } });

    await agents.forget('ses_1', 42);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({});
  });

  it('keeps no record where a process has no identity, as off Linux', async () => {
    await registry().record('ses_1', 41);

    expect(fs.existsSync(file)).toBe(false);
  });
});
