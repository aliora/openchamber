import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EngineSessionRuntime } from './session-runtime.js';
import { ControlBridge } from './control-bridge.js';
import { createFakeEngine } from './test/fake-engine.js';

test('pending forms are scoped, reply once, and clear on cancellation', async () => {
  const events = [];
  const store = { appendMessage: async () => {}, getMessages: async () => [], updateSession: async () => {} };
  const runtime = new EngineSessionRuntime({ store, controlBridge: new ControlBridge(), streamHub: { broadcast: (id, event) => events.push(event) } });
  const adapter = createFakeEngine({ reply: () => {} });
  await runtime.prompt({ session: { id: 'one', cwd: '/work' }, adapter, text: 'ask', model: 'fast', permissionMode: 'ask' });
  const proc = adapter.processes[0];
  const replies = [];
  proc.respondForm = async (id, answer) => replies.push({ id, answer });
  proc.emit('form.requested', { id: 'form-1', title: 'Choice', fields: [{ key: 'answer', type: 'string' }] });
  assert.equal(runtime.getPendingForms('one').length, 1);
  await assert.rejects(runtime.respondForm('other', 'form-1', { answer: 'yes' }), /not found/);
  await runtime.respondForm('one', 'form-1', { answer: 'yes' });
  assert.deepEqual(replies, [{ id: 'form-1', answer: { answer: 'yes' } }]);
  assert.equal(runtime.getPendingForms('one').length, 0);
  await assert.rejects(runtime.respondForm('one', 'form-1', {}), /not found/);
  proc.emit('form.requested', { id: 'form-2', title: 'Other', fields: [{ key: 'answer', type: 'string' }] });
  await runtime.abort('one');
  assert.equal(runtime.getPendingForms('one').length, 0);
  assert(events.some((event) => event.type === 'form.cancelled' && event.data.id === 'form-2'));
});
