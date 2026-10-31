import { describe, it, expect } from 'bun:test';
import { readHistoryPage, toWireFinish, toWireHistory } from './wire-messages.js';

const adapter = { id: 'claude', providerID: 'anthropic', modelCatalog: () => ({ models: [{ id: 'sonnet', name: 'Claude Sonnet' }], defaultModel: 'sonnet' }) };
const session = { id: 'ses_1', model: 'opus' };
const history = (stored, running = []) => toWireHistory({ stored, running, session, adapter });

describe('toWireHistory', () => {
  it('reads records stored before outcomes, times and tool ids were kept', () => {
    // What the runtime stored before this format: no completion, outcome,
    // tokens or part times, and text under `content` from the plural routes.
    const messages = history([
      { id: 'msg_u', role: 'user', content: 'Explain code', createdAt: 100, parts: [{ type: 'text', content: 'Explain code' }] },
      {
        id: 'msg_a',
        role: 'assistant',
        createdAt: 200,
        parts: [
          { id: 'msg_a_r0', type: 'reasoning', text: 'Analyzing...' },
          { id: 'toolu_1', type: 'tool', callID: 'toolu_1', tool: 'Read', state: { status: 'completed', input: { file_path: 'a.js' }, output: 'code' } },
          { type: 'text', content: 'Here is the explanation.' },
        ],
      },
    ]);

    expect(messages).toEqual([
      { id: 'msg_u', time: { created: 100 }, type: 'user', text: 'Explain code' },
      {
        id: 'msg_a',
        time: { created: 200, completed: 200 },
        type: 'assistant',
        agent: 'claude',
        model: { providerID: 'anthropic', id: 'opus' },
        content: [
          { type: 'reasoning', text: 'Analyzing...', time: { created: 200, completed: 200 } },
          {
            type: 'tool',
            id: 'toolu_1',
            name: 'Read',
            state: { status: 'completed', input: { file_path: 'a.js' }, content: [{ type: 'text', text: 'code' }] },
            time: { created: 200, completed: 200 },
          },
          { type: 'text', text: 'Here is the explanation.' },
        ],
        finish: 'stop',
        cost: 0,
      },
      { id: 'msg_a_idle', time: { created: 200 }, type: 'idle', outcome: 'succeeded' },
    ]);
  });

  it('serves each stored run of text or reasoning as its own item, in the stored order', () => {
    const tool = (callID) => ({ type: 'tool', callID, tool: 'Read', executed: true, state: { status: 'completed', input: {}, output: 'x' } });
    const [assistant] = history([{
      id: 'msg_a',
      role: 'assistant',
      createdAt: 1,
      completedAt: 9,
      parts: [
        { id: 'msg_a_t0', type: 'text', text: 'ALPHA' },
        tool('toolu_1'),
        { id: 'msg_a_t1', type: 'text', text: 'BETA' },
        { id: 'msg_a_r0', type: 'reasoning', text: 'Think.', time: { created: 4, completed: 5 } },
        tool('toolu_2'),
        { id: 'msg_a_t2', type: 'text', text: 'OMEGA' },
      ],
    }]);
    expect(assistant.content.map((item) => item.text ?? item.id)).toEqual(['ALPHA', 'toolu_1', 'BETA', 'Think.', 'toolu_2', 'OMEGA']);
  });

  it('reads a record without parts from its text', () => {
    const [user, assistant] = history([
      { id: 'msg_u', role: 'user', content: '', createdAt: 1, parts: [{ type: 'text', text: 'From the part' }] },
      { id: 'msg_a', role: 'assistant', content: 'Only text', createdAt: 2 },
    ]);
    expect(user.text).toBe('From the part');
    expect(assistant.content).toEqual([{ type: 'text', text: 'Only text' }]);
  });

  it('leaves out an unreadable message or part and keeps the rest', () => {
    const messages = history([
      { id: 'msg_1', role: 'user', content: 'kept', createdAt: 1 },
      { role: 'user', content: 'no id', createdAt: 2 },
      { id: 'msg_2', role: 'system', content: 'unknown role', createdAt: 3 },
      {
        id: 'msg_3',
        role: 'assistant',
        createdAt: 4,
        parts: [
          { type: 'tool', tool: 'Read', state: { status: 'completed', input: {} } },
          { type: 'image', url: 'x' },
          'not a part',
          { type: 'text', text: 'kept too' },
        ],
      },
    ]);
    expect(messages.map((message) => message.id)).toEqual(['msg_1', 'msg_3', 'msg_3_idle']);
    expect(messages[1].content).toEqual([{ type: 'text', text: 'kept too' }]);
  });

  it('reads each tool state as the wire state the UI projects', () => {
    const tool = (callID, state) => ({ type: 'tool', callID, tool: 'Bash', executed: true, state, time: { created: 10, ran: 11, completed: 12 } });
    const [assistant] = history([{
      id: 'msg_a',
      role: 'assistant',
      createdAt: 5,
      completedAt: 20,
      outcome: 'failed',
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 0 } },
      parts: [
        tool('ok', { status: 'completed', input: { command: 'ls' }, output: '', metadata: { openchamber: { ok: true } } }),
        tool('failed', { status: 'error', input: { command: 'false' }, output: 'exit 1', error: 'exit 1' }),
        tool('stopped', { status: 'error', input: { command: 'sleep 9' }, error: 'The turn ended before this tool finished' }),
        tool('odd input', { status: 'completed', input: 'not an object', output: 'x' }),
      ],
    }]);

    expect(assistant.finish).toBe('error');
    expect(assistant.tokens).toEqual({ input: 1, output: 2, reasoning: 0, cache: { read: 3, write: 0 } });
    expect(assistant.time).toEqual({ created: 5, completed: 20 });
    expect(assistant.content.map((item) => item.state)).toEqual([
      { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: '' }], metadata: { openchamber: { ok: true } } },
      { status: 'error', input: { command: 'false' }, error: { type: 'tool', message: 'exit 1' }, content: [{ type: 'text', text: 'exit 1' }] },
      { status: 'error', input: { command: 'sleep 9' }, error: { type: 'tool', message: 'The turn ended before this tool finished' } },
      { status: 'completed', input: {}, content: [{ type: 'text', text: 'x' }] },
    ]);
    expect(assistant.content[0]).toMatchObject({ id: 'ok', name: 'Bash', executed: true, time: { created: 10, ran: 11, completed: 12 } });
  });

  it('serves the context a turn ended with, and drops a malformed one without the other counts', () => {
    const counts = { input: 8, output: 493, reasoning: 0, cache: { read: 109032, write: 36699 } };
    const answer = (id, tokens) => ({ id, role: 'assistant', content: 'x', createdAt: 1, tokens });
    const [measured, older, malformed] = history([
      answer('msg_measured', { ...counts, total: 36705 }),
      // Stored before turns kept their context.
      answer('msg_older', counts),
      answer('msg_malformed', { ...counts, total: 'many' }),
    ]).filter((message) => message.type === 'assistant');
    expect(measured.tokens).toEqual({ ...counts, total: 36705 });
    expect(older.tokens).toStrictEqual(counts);
    // Undefined, so absent once served.
    expect(malformed.tokens).toEqual(counts);
    expect(malformed.tokens.total).toBeUndefined();
  });

  it('serves a running turn without completion, finish or cost, with its open calls', () => {
    const [assistant] = history([], [{
      id: 'msg_live',
      role: 'assistant',
      agent: 'claude',
      model: 'sonnet',
      createdAt: 50,
      parts: [
        { type: 'reasoning', text: 'Thinking', time: { created: 51 } },
        { type: 'tool', callID: 'page', tool: 'openchamber_render', executed: true, state: { status: 'running', input: { action: 'render.page' } }, time: { created: 52, ran: 53 } },
        { type: 'tool', callID: 'cmd', tool: 'shell', executed: false, state: { status: 'pending', input: {} }, time: { created: 54 } },
      ],
    }]);

    expect(assistant.time).toEqual({ created: 50, completed: undefined });
    expect(assistant.finish).toBeUndefined();
    expect(assistant.cost).toBeUndefined();
    expect(assistant.model).toEqual({ providerID: 'anthropic', id: 'sonnet' });
    expect(assistant.content).toEqual([
      { type: 'reasoning', text: 'Thinking', time: { created: 51 } },
      { type: 'tool', id: 'page', name: 'openchamber_render', executed: true, state: { status: 'running', input: { action: 'render.page' }, metadata: {} }, time: { created: 52, ran: 53 } },
      { type: 'tool', id: 'cmd', name: 'shell', executed: false, state: { status: 'streaming', input: '' }, time: { created: 54 } },
    ]);
  });

  it('orders the transcript by creation time and keeps the stored order of a tie', () => {
    const messages = history([
      { id: 'msg_u1', role: 'user', content: 'one', createdAt: 10 },
      // Queued while the first turn ran, stored before that turn's answer.
      { id: 'msg_u2', role: 'user', content: 'two', createdAt: 30 },
      { id: 'msg_a1', role: 'assistant', content: 'answer one', createdAt: 10, completedAt: 40 },
    ], [{ id: 'msg_a2', role: 'assistant', content: '', createdAt: 40, parts: [] }]);
    expect(messages.map((message) => message.id)).toEqual(['msg_u1', 'msg_a1', 'msg_a1_idle', 'msg_u2', 'msg_a2']);
  });

  it('ends each finished turn with an idle record and serves a context-only prompt as its synthetic messages', () => {
    const error = { type: 'EngineFailed', message: 'boom' };
    const messages = history([
      { id: 'msg_a', role: 'assistant', content: 'x', createdAt: 10, completedAt: 20, outcome: 'failed', error },
    ], [{ id: 'msg_live', role: 'assistant', content: '', createdAt: 30, parts: [] }]);
    expect(messages.map((message) => message.id)).toEqual(['msg_a', 'msg_a_idle', 'msg_live']);
    expect(messages[1]).toEqual({ id: 'msg_a_idle', time: { created: 20 }, type: 'idle', outcome: 'failed', error });

    const contextOnly = history([
      { id: 'msg_u', role: 'user', content: '', createdAt: 5, context: [{ id: 'msg_u_ctx', text: 'terminal block' }] },
    ]);
    expect(contextOnly.map((message) => message.type)).toEqual(['synthetic']);
    expect(contextOnly[0].text).toBe('terminal block');
  });

  it('maps every turn outcome to a finish the client knows', () => {
    expect(['succeeded', 'failed', 'interrupted', 'other'].map(toWireFinish)).toEqual(['stop', 'error', 'unknown', 'unknown']);
  });
});

describe('readHistoryPage', () => {
  const messages = ['u1', 'a1', 'u2', 'a2', 'u3'].map((id, index) => ({
    id: `msg_${id}`,
    type: id.startsWith('u') ? 'user' : 'assistant',
    time: { created: index },
  }));
  const ids = (page) => page.data.map((message) => message.id);

  it('pages newest first by default and gives a cursor only while messages remain', () => {
    const first = readHistoryPage(messages, { limit: 2 });
    expect(ids(first)).toEqual(['msg_u3', 'msg_a2']);
    expect(first.next).toEqual(expect.any(String));

    const second = readHistoryPage(messages, { limit: 2, cursor: first.next });
    expect(ids(second)).toEqual(['msg_u2', 'msg_a1']);
    const last = readHistoryPage(messages, { limit: 2, cursor: second.next });
    expect(ids(last)).toEqual(['msg_u1']);
    expect(last.next).toBeNull();
  });

  it('has no cursor when the page holds exactly what remains, or when there is no limit', () => {
    const first = readHistoryPage(messages, { limit: 3, order: 'asc' });
    expect(ids(first)).toEqual(['msg_u1', 'msg_a1', 'msg_u2']);
    const rest = readHistoryPage(messages, { limit: 2, cursor: first.next });
    expect(ids(rest)).toEqual(['msg_a2', 'msg_u3']);
    expect(rest.next).toBeNull();
    expect(readHistoryPage(messages, {}).next).toBeNull();
    expect(readHistoryPage([], { limit: 5 })).toEqual({ data: [], next: null });
  });

  it('filters by message type before paging', () => {
    const page = readHistoryPage(messages, { type: 'user', limit: 2 });
    expect(ids(page)).toEqual(['msg_u3', 'msg_u2']);
    expect(ids(readHistoryPage(messages, { type: 'user', cursor: page.next }))).toEqual(['msg_u1']);
  });

  it('refuses a cursor it did not hand out or whose message is gone', () => {
    expect(readHistoryPage(messages, { cursor: 'not-a-cursor' })).toBeNull();
    const elsewhere = readHistoryPage([...messages, { id: 'msg_x', type: 'user', time: { created: 9 } }], { limit: 1, order: 'asc' }).next;
    expect(readHistoryPage(messages.slice(1), { cursor: elsewhere })).toBeNull();
  });
});
