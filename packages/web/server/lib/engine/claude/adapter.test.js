import { describe, it, expect } from 'bun:test';
import { createClaudeEngine, logoutClaude } from './adapter.js';
import { createFakeEngine } from '../test/fake-engine.js';

const engine = createClaudeEngine({
  installer: createFakeEngine().installer,
  authStatusProvider: async () => ({ loggedIn: true }),
});

// Feeds one stream-json line through the real parser and returns what the
// engine process reports for the turn. Nothing is spawned.
const completeTurn = (line) => {
  const proc = engine.createProcess({ sessionId: 'session-1', cwd: process.cwd() });
  let completed = null;
  proc.on('turn.completed', (payload) => { completed = payload; });
  proc.inner.handleOutputLine(JSON.stringify({ type: 'result', usage: { input_tokens: 2, output_tokens: 3 }, ...line }));
  return completed;
};

describe('Claude engine turn results', () => {
  it('reports a successful result as succeeded', () => {
    expect(completeTurn({ subtype: 'success', result: 'Done.' })).toEqual({
      outcome: 'succeeded',
      usage: { input: 2, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('reports an API error, which the CLI marks only with is_error, as failed', () => {
    expect(completeTurn({ subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded' })).toMatchObject({
      outcome: 'failed',
      error: { type: 'api_error', message: 'API Error: 529 Overloaded' },
    });
  });

  it('reports a signed-out CLI as AuthRequired so the chat can offer sign-in', () => {
    for (const result of ['Not logged in · Please run /login', 'Invalid API key · Please run /login', 'OAuth token has expired. Please obtain a new token or refresh your existing token.']) {
      expect(completeTurn({ subtype: 'success', is_error: true, result })).toMatchObject({
        outcome: 'failed',
        error: { type: 'AuthRequired' },
      });
    }
  });

  it('reports an error subtype as failed with a fallback message', () => {
    expect(completeTurn({ subtype: 'error_max_turns' })).toMatchObject({
      outcome: 'failed',
      error: { type: 'error_max_turns', message: 'Claude Code ended the turn with an error.' },
    });
  });
});

// The usage events of one model call as Claude Code 2.1.302 streams them:
// `message_start` with what the call read and a partial output count, then
// `message_delta` with the final counts.
const modelCall = ({ read, write, output }, extra = {}) => [
  { type: 'stream_event', parent_tool_use_id: null, ...extra, event: { type: 'message_start', message: { usage: { input_tokens: 2, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: 6 } } } },
  { type: 'stream_event', parent_tool_use_id: null, ...extra, event: { type: 'message_delta', usage: { input_tokens: 2, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output } } },
];

describe('Claude engine turn usage', () => {
  const runTurns = (...turns) => {
    const proc = engine.createProcess({ sessionId: 'session-1', cwd: process.cwd() });
    const completed = [];
    proc.on('turn.completed', (payload) => completed.push(payload.usage));
    for (const lines of turns) {
      for (const line of lines) proc.inner.handleOutputLine(JSON.stringify(line));
    }
    return completed;
  };

  it('keeps the counts the turn added up and reports the context its last call ended with', () => {
    // Recorded from a turn that read three files, one Read call at a time.
    const [usage] = runTurns([
      ...modelCall({ read: 0, write: 36092, output: 259 }),
      ...modelCall({ read: 36092, write: 302, output: 115 }),
      ...modelCall({ read: 36394, write: 152, output: 115 }),
      ...modelCall({ read: 36546, write: 153, output: 4 }),
      { type: 'result', subtype: 'success', usage: { input_tokens: 8, cache_creation_input_tokens: 36699, cache_read_input_tokens: 109032, output_tokens: 493 } },
    ]);
    // The counts add up to 146232, every call re-reading the conversation.
    // The conversation holds what the last call read and wrote: 2 + 36546 + 153 + 4.
    expect(usage).toEqual({ input: 8, output: 493, reasoning: 0, cacheRead: 109032, cacheWrite: 36699, total: 36705 });
  });

  it('leaves a subagent\'s calls out and reads a count the final event leaves null from the call\'s start', () => {
    const [startEvent, deltaEvent] = modelCall({ read: 1000, write: 50, output: 0 });
    deltaEvent.event.usage = { input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens: 40 };
    const [usage] = runTurns([
      startEvent,
      deltaEvent,
      ...modelCall({ read: 90000, write: 0, output: 900 }, { parent_tool_use_id: 'toolu_task' }),
      { type: 'result', subtype: 'success', usage: { input_tokens: 4, output_tokens: 940 } },
    ]);
    expect(usage.total).toBe(2 + 1000 + 50 + 40);
  });

  it('reports no context for a turn without a finished call, so an earlier turn\'s is not repeated', () => {
    const [first, second] = runTurns(
      [...modelCall({ read: 500, write: 0, output: 10 }), { type: 'result', subtype: 'success', usage: { input_tokens: 2, output_tokens: 10 } }],
      [{ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded', usage: { input_tokens: 0, output_tokens: 0 } }],
    );
    expect(first.total).toBe(512);
    expect(second).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe('Claude sign-out', () => {
  it('passes when the CLI signs out and throws its exit code otherwise', () => {
    const calls = [];
    expect(() => logoutClaude((args) => { calls.push(args); return { status: 0 }; })).not.toThrow();
    expect(calls).toEqual([['auth', 'logout']]);
    expect(() => logoutClaude(() => ({ status: 1 }))).toThrow('claude auth logout did not finish (exit code 1)');
    expect(() => logoutClaude(() => ({ status: null, error: new Error('spawnSync claude ETIMEDOUT') }))).toThrow('ETIMEDOUT');
  });

  it('names the terminal commands to sign in and out', () => {
    expect(engine.auth).toMatchObject({ loginCommand: 'claude auth login', logoutCommand: 'claude auth logout' });
    expect(engine.auth.loginProcess()).toMatchObject({ args: ['auth', 'login'] });
  });
});
