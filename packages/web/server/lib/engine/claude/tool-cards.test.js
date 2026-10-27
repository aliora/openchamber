import { describe, it, expect } from 'bun:test';
import { describeActivity, toCardTool } from './tool-cards.js';

describe('toCardTool', () => {
  it('draws Task and Agent calls as a subagent with its description, agent and prompt', () => {
    const input = { description: 'Scan repo', subagent_type: 'Explore', prompt: 'List files' };
    const card = { name: 'subagent', input: { description: 'Scan repo', agent: 'Explore', prompt: 'List files' } };
    expect(toCardTool('Task', input)).toEqual(card);
    expect(toCardTool('Agent', input)).toEqual(card);
  });

  it('draws TodoWrite as a todo list and leaves other tools alone', () => {
    const input = { todos: [{ content: 'A', status: 'pending' }] };
    expect(toCardTool('TodoWrite', input)).toEqual({ name: 'todo', input });
    expect(toCardTool('Bash', { command: 'ls' })).toEqual({ name: 'Bash', input: { command: 'ls' } });
  });
});

describe('describeActivity', () => {
  it('names the call and its first detail on one line', () => {
    expect(describeActivity('Read', { file_path: 'src/a.js' })).toBe('Read src/a.js');
    expect(describeActivity('Bash', { command: 'npm test\nnpm run lint' })).toBe('Bash npm test');
    expect(describeActivity('Think', {})).toBe('Think');
  });
});
