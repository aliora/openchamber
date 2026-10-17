import { describe, it, expect } from 'bun:test';
import { createTurnTranslator } from './turn-translator.js';

const MESSAGE_ID = 'msg_answer';

const startTurn = () => {
  const events = [];
  const turn = createTurnTranslator({
    sessionId: 'ses_1',
    assistantMessageID: MESSAGE_ID,
    agent: 'claude',
    providerID: 'anthropic',
    modelID: 'sonnet',
    broadcast: (event) => events.push(event),
  });
  turn.begin();
  return { turn, events };
};

// One line per event: its type and the part it names, a text or reasoning
// part by ordinal and a call by id, plus the text an `ended` event closes with.
const describeEvents = (events) => events.map(({ type, data }) => {
  if ('ordinal' in data) return [type, data.ordinal, ...(type.endsWith('.ended') ? [data.text] : [])];
  if ('id' in data) return [type, data.id];
  return [type];
});

describe('createTurnTranslator', () => {
  it('streams each run of text or reasoning as a part of its own, numbered per type', () => {
    const { turn, events } = startTurn();
    turn.handle('text.delta', { text: 'Let me look.' });
    turn.handle('text.delta', { text: ' First the file.' });
    turn.handle('tool.started', { id: 'toolu_read', name: 'Read', input: {} });
    turn.handle('tool.called', { id: 'toolu_read', name: 'Read', input: { file_path: 'a.js' } });
    turn.handle('tool.completed', { id: 'toolu_read', output: 'code', isError: false });
    turn.handle('text.delta', { text: 'Found it.' });
    turn.handle('reasoning.delta', { text: 'Now the test.' });
    // A CLI that reports a call only whole starts it here.
    turn.handle('tool.called', { id: 'toolu_test', name: 'Bash', input: { command: 'npm test' } });
    turn.handle('text.delta', { text: '' });
    turn.handle('tool.completed', { id: 'toolu_test', output: 'ok', isError: false });
    turn.handle('text.delta', { text: 'Done.' });
    const message = turn.finish({ outcome: 'succeeded' });

    expect(describeEvents(events)).toEqual([
      ['session.step.started'],
      ['session.text.started', 0],
      ['session.text.delta', 0],
      ['session.text.delta', 0],
      ['session.text.ended', 0, 'Let me look. First the file.'],
      ['session.tool.input.started', 'toolu_read'],
      ['session.tool.called', 'toolu_read'],
      ['session.tool.success', 'toolu_read'],
      ['session.text.started', 1],
      ['session.text.delta', 1],
      ['session.text.ended', 1, 'Found it.'],
      ['session.reasoning.started', 0],
      ['session.reasoning.delta', 0],
      ['session.reasoning.ended', 0, 'Now the test.'],
      ['session.tool.input.started', 'toolu_test'],
      ['session.tool.called', 'toolu_test'],
      ['session.tool.success', 'toolu_test'],
      ['session.text.started', 2],
      ['session.text.delta', 2],
      ['session.text.ended', 2, 'Done.'],
      ['session.step.ended'],
    ]);

    // The stored message keeps the same parts in the same order, so the n-th
    // text part read back is the one the stream numbered n.
    expect(message.parts.map((part) => [part.type, part.text ?? part.callID])).toEqual([
      ['text', 'Let me look. First the file.'],
      ['tool', 'toolu_read'],
      ['text', 'Found it.'],
      ['reasoning', 'Now the test.'],
      ['tool', 'toolu_test'],
      ['text', 'Done.'],
    ]);
    expect(message.parts.filter((part) => part.type !== 'tool').map((part) => part.id))
      .toEqual([`${MESSAGE_ID}_t0`, `${MESSAGE_ID}_t1`, `${MESSAGE_ID}_r0`, `${MESSAGE_ID}_t2`]);
    expect(message.content).toBe('Let me look. First the file.Found it.Done.');
  });

  it('gives each reasoning run its own times and leaves a call that only started out of the stored parts', () => {
    const { turn, events } = startTurn();
    turn.handle('reasoning.delta', { text: 'Plan.' });
    turn.handle('tool.started', { id: 'toolu_pending', name: 'Read', input: {} });
    turn.handle('reasoning.delta', { text: 'Replan.' });
    turn.handle('text.delta', { text: 'Answer.' });

    // A history read mid-turn sees the open run and the call only started.
    expect(turn.snapshot().parts.map((part) => [part.type, part.id])).toEqual([
      ['reasoning', `${MESSAGE_ID}_r0`],
      ['tool', 'toolu_pending'],
      ['reasoning', `${MESSAGE_ID}_r1`],
      ['text', `${MESSAGE_ID}_t0`],
    ]);

    const message = turn.finish({ outcome: 'interrupted' });
    const ended = events.filter((event) => event.type === 'session.reasoning.ended');
    expect(ended.map((event) => [event.data.ordinal, event.data.text])).toEqual([[0, 'Plan.'], [1, 'Replan.']]);
    const started = events.filter((event) => event.type === 'session.reasoning.started');
    expect(message.parts.map((part) => [part.type, part.id])).toEqual([
      ['reasoning', `${MESSAGE_ID}_r0`],
      ['reasoning', `${MESSAGE_ID}_r1`],
      ['text', `${MESSAGE_ID}_t0`],
    ]);
    expect(message.parts.slice(0, 2).map((part) => part.time)).toEqual([
      { created: started[0].created, completed: ended[0].created },
      { created: started[1].created, completed: ended[1].created },
    ]);
  });

  it('ends the step with the turn\'s counts and the context it ended with, and stores both', () => {
    const { turn, events } = startTurn();
    turn.handle('text.delta', { text: 'Read them.' });
    const message = turn.finish({ outcome: 'succeeded', usage: { input: 8, output: 493, reasoning: 0, cacheRead: 109032, cacheWrite: 36699, total: 36705 } });
    const tokens = { input: 8, output: 493, reasoning: 0, cache: { read: 109032, write: 36699 }, total: 36705 };
    expect(events.at(-1)).toMatchObject({ type: 'session.step.ended', data: { finish: 'stop', cost: 0, tokens } });
    expect(message.tokens).toEqual(tokens);

    // An adapter that cannot say leaves `total` out, and the UI adds up the counts.
    const other = startTurn();
    other.turn.handle('text.delta', { text: 'Hi.' });
    expect(other.turn.finish({ outcome: 'succeeded', usage: { input: 3, output: 2 } }).tokens)
      .toStrictEqual({ input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  it('opens no part for an empty delta, so a turn of empty deltas stores nothing', () => {
    const { turn, events } = startTurn();
    turn.handle('text.delta', { text: '' });
    turn.handle('reasoning.delta', { text: '' });
    expect(turn.finish({ outcome: 'succeeded' })).toBeNull();
    expect(events.map((event) => event.type)).toEqual(['session.step.started', 'session.step.ended']);
  });
});
