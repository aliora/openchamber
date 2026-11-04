import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenCodeEventTranslator } from './event-translator.js';
import { readFileSync } from 'node:fs';

test('replays recorded 2.0.31 permission denial as interruption, not success', () => {
  const events = JSON.parse(readFileSync(new URL('./fixtures/permission-denied.json', import.meta.url), 'utf8'));
  const sessionId = events.find((event) => event.data.sessionID)?.data.sessionID;
  const emitted = [];
  const handle = createOpenCodeEventTranslator(sessionId, (name) => emitted.push(name));
  for (const event of events) handle(event);
  assert(emitted.includes('text.delta'));
  assert(emitted.includes('permission.requested'));
  assert(emitted.includes('turn.interrupted'));
  assert.equal(emitted.filter((name) => name === 'turn.completed').length, 1);
});

test('preserves text/tool order, final-call context and interrupted outcome', () => {
  const emitted = [];
  const handle = createOpenCodeEventTranslator('session', (name, data) => emitted.push({ name, data }));
  const send = (type, data) => handle({ type, data: { sessionID: 'session', ...data } });
  handle({ type: 'session.text.delta', data: { sessionID: 'other', delta: 'wrong' } });
  send('session.text.delta', { delta: 'hello' });
  send('session.tool.input.started', { id: 'call', name: 'bash' });
  send('session.tool.called', { id: 'call', input: { command: 'pwd' } });
  send('session.tool.success', { id: 'call', content: [{ type: 'text', text: '/work' }] });
  send('session.step.ended', { tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 3 } } });
  send('session.step.ended', { tokens: { input: 20, output: 3, reasoning: 2, cache: { read: 8, write: 4 } } });
  send('session.execution.interrupted', {});
  assert.deepEqual(emitted.map((event) => event.name), ['text.delta', 'tool.started', 'tool.called', 'tool.completed', 'turn.interrupted']);
  assert.equal(emitted[3].data.output, '/work');
});

test('success uses nonoverlapping aggregate usage and last-call context', () => {
  let completed;
  const handle = createOpenCodeEventTranslator('s', (name, data) => { if (name === 'turn.completed') completed = data; });
  for (const input of [10, 20]) handle({ type: 'session.step.ended', data: { sessionID: 's', tokens: { input, output: 2, reasoning: 0, cache: { read: 5, write: 0 } } } });
  handle({ type: 'session.execution.succeeded', data: { sessionID: 's' } });
  assert.equal(completed.outcome, 'succeeded');
  assert.equal(completed.usage.input, 30);
  assert.equal(completed.usage.total, 27);
});
