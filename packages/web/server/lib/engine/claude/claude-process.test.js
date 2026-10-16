import { describe, it, expect } from 'bun:test';
import { ClaudeProcess, buildClaudeCliArgs } from './claude-process.js';

describe('buildClaudeCliArgs', () => {
  it('constructs mandatory flags for headless stream-json execution', () => {
    const args = buildClaudeCliArgs({
      sessionId: 'test-session-123',
      model: 'sonnet',
      effort: 'medium',
      permissionMode: 'auto',
      resume: true,
    });

    expect(args).toContain('-p');
    expect(args).toContain('--verbose');
    expect(args).toContain('--input-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--permission-prompts');
    expect(args).toContain('host');
    expect(args).toContain('--session-id');
    expect(args).toContain('test-session-123');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--effort');
    expect(args).toContain('medium');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('auto');
    expect(args).not.toContain('--resume');
  });

  it('adds --resume when sessionId is absent', () => {
    const args = buildClaudeCliArgs({
      resume: true,
    });
    expect(args).toContain('--resume');
  });

  it('handles plan permission mode properly', () => {
    const args = buildClaudeCliArgs({
      sessionId: 'plan-session',
      permissionMode: 'plan',
    });

    expect(args).toContain('--permission-mode');
    expect(args).toContain('plan');
  });
});

describe('ClaudeProcess stream line parsing', () => {
  it('parses system init events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('init', (payload) => {
      expect(payload.session_id).toBe('c1be619a');
      expect(payload.model).toBe('claude-sonnet-5-5');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'c1be619a',
      model: 'claude-sonnet-5-5',
      tools: ['Read', 'Write'],
    }));
  });

  it('parses thinking_delta events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('thinking_delta', (payload) => {
      expect(payload.text).toBe('Thinking about architecture...');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'thinking_delta',
          thinking: 'Thinking about architecture...',
        },
      },
    }));
  });

  it('parses text_delta events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('text_delta', (payload) => {
      expect(payload.text).toBe('Hello world!');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'text_delta',
          text: 'Hello world!',
        },
      },
    }));
  });

  it('parses control_request events for interactive approval', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('control_request', (payload) => {
      expect(payload.requestId).toBe('req-123');
      expect(payload.toolName).toBe('Bash');
      expect(payload.command).toBe('npm test');
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'control_request',
      request_id: 'req-123',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'npm test' },
      },
    }));
  });

  it('parses result events', (done) => {
    const proc = new ClaudeProcess({ sessionId: 'dummy', cwd: process.cwd() });
    proc.on('result', (payload) => {
      expect(payload.result).toBe('Done.');
      expect(payload.durationMs).toBe(1234);
      done();
    });

    proc.handleOutputLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      result: 'Done.',
      duration_ms: 1234,
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  });
});
