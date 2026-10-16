import { describe, it, expect } from 'bun:test';
import { createClaudeEngine } from './adapter.js';
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

  it('reports an error subtype as failed with a fallback message', () => {
    expect(completeTurn({ subtype: 'error_max_turns' })).toMatchObject({
      outcome: 'failed',
      error: { type: 'error_max_turns', message: 'Claude Code ended the turn with an error.' },
    });
  });
});
