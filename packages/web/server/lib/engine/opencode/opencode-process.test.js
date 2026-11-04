import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, on, once } from 'node:events';
import { OpenCodeProcess } from './opencode-process.js';

const fixture = () => {
  const bus = new EventEmitter(); const calls = []; const service = new EventEmitter();
  const client = {
    event: { subscribe: ({ signal }) => (async function* () { const iterator = on(bus, 'event', { signal }); queueMicrotask(() => bus.emit('event', { type: 'server.connected', data: {} })); for await (const [event] of iterator) yield event; })() },
    session: {
      create: async () => ({ id: 'upstream' }), get: async ({ sessionID }) => ({ id: sessionID }),
      switchModel: async (input) => calls.push(['model', input]),
      prompt: async (input) => calls.push(['prompt', input]),
      interrupt: async () => calls.push(['interrupt']),
    },
    permission: { reply: async (input) => calls.push(['permission', input]) },
  };
  service.start = async () => client; service.stop = async () => calls.push(['stop']);
  return { bus, calls, service };
};

test('resumes mapped conversation and serializes queued prompts', async () => {
  const { bus, calls, service } = fixture();
  const proc = new OpenCodeProcess({ sessionId: 'local', cwd: '/work', model: 'vendor/model', engineState: { sessionId: 'saved' }, createService: () => service, idleMs: 10000 });
  proc.on('error', (error) => { throw error; });
  await proc.start();
  proc.sendUserMessage('one'); proc.sendUserMessage('two');
  await new Promise(setImmediate);
  assert.equal(calls.filter(([name]) => name === 'prompt').length, 1);
  assert.equal(calls.find(([name]) => name === 'prompt')[1].sessionID, 'saved');
  bus.emit('event', { type: 'session.execution.succeeded', data: { sessionID: 'saved' } });
  await new Promise(setImmediate);
  assert.equal(calls.filter(([name]) => name === 'prompt').length, 2);
  await proc.abort();
  assert.equal(proc.isAlive, false);
  assert.equal(calls.at(-1)[0], 'stop');
});

test('idle retirement does not interrupt a pending turn', async () => {
  const { calls, service } = fixture();
  const proc = new OpenCodeProcess({ sessionId: 'local', cwd: '/work', model: 'vendor/model', createService: () => service, idleMs: 15 });
  proc.on('error', (error) => { throw error; });
  await proc.start(); proc.sendUserMessage('waiting');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(proc.isAlive, true);
  assert.equal(calls.some(([name]) => name === 'stop'), false);
  await proc.abort();
});

test('idle process releases the service and emits exit', async () => {
  const { service } = fixture();
  const proc = new OpenCodeProcess({ sessionId: 'local', cwd: '/work', model: 'vendor/model', createService: () => service, idleMs: 5 });
  proc.on('error', () => {});
  await proc.start();
  await once(proc, 'exit');
  assert.equal(proc.isAlive, false);
});

test('a reconnected stream fails an active turn instead of silently losing deltas', async () => {
  const { bus, service } = fixture();
  const proc = new OpenCodeProcess({ sessionId: 'local', cwd: '/work', model: 'vendor/model', createService: () => service });
  await proc.start(); proc.sendUserMessage('active');
  const failed = once(proc, 'error');
  bus.emit('event', { type: 'server.connected', data: {} });
  try {
    const [error] = await Promise.race([failed, new Promise((resolve, reject) => setTimeout(() => reject(new Error('No reconnect failure emitted')), 50))]);
    assert.match(error.message, /reconnected/);
  } finally { await proc.abort(); }
  assert.equal(proc.isAlive, false);
});
