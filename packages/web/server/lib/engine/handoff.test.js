import { describe, it, expect } from 'bun:test';
import { buildHandoffPrompt } from './handoff.js';

const user = (text) => ({ role: 'user', content: text, parts: [{ type: 'text', text }] });
const assistant = (parts) => ({ role: 'assistant', parts });

describe('buildHandoffPrompt', () => {
  it('sends the prompt alone when there is no history', () => {
    expect(buildHandoffPrompt([], 'hi')).toBe('hi');
  });

  it('writes text and tool calls and skips reasoning', () => {
    const prompt = buildHandoffPrompt([
      user('fix it'),
      assistant([
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'tool', tool: 'Bash', state: {} },
        { type: 'text', text: 'done' },
      ]),
    ], 'next');
    expect(prompt).toContain('User:\nfix it\n\nAssistant:\n[used tool: Bash]\ndone');
    expect(prompt).not.toContain('secret thoughts');
    expect(prompt.endsWith('\n\nnext')).toBe(true);
  });

  it('keeps the newest messages that fit and says earlier ones were left out', () => {
    const prompt = buildHandoffPrompt([user('a'.repeat(50)), user('newest')], 'go', 30);
    expect(prompt).toContain('(Earlier messages were left out.)');
    expect(prompt).toContain('newest');
    expect(prompt).not.toContain('aaaa');
  });

  it('reads a message stored without parts from its content', () => {
    expect(buildHandoffPrompt([{ role: 'user', content: 'old' }], 'go')).toContain('User:\nold');
  });
});
