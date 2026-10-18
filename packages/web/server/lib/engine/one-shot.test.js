import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createOneShotGenerator, smallModelFor } from './one-shot.js';

const engineAdapter = (id, models, defaultModel = models[0]) => ({
  id,
  displayName: id,
  modelCatalog: () => ({ models: models.map((model) => ({ id: model })), defaultModel }),
});

const claude = engineAdapter('claude', ['opus', 'sonnet', 'haiku', 'claude-haiku-4-5'], 'sonnet');
const codex = engineAdapter('codex', ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-luna'], 'gpt-6.1-sol');
const antigravity = engineAdapter('antigravity', ['default', 'gemini-4-argon', 'gemini-3.8-flash'], 'default');

const createFakeChildren = (answer) => {
  const calls = [];
  const spawn = (engine, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => child.killed.push(signal);
    const call = { args, input: undefined, child };
    child.stdin = Object.assign(new EventEmitter(), {
      end: (input) => {
        call.input = input;
        queueMicrotask(() => answer(child, call));
      },
    });
    calls.push(call);
    return child;
  };
  return { calls, spawn };
};

const reply = (output, code = 0, stderr = '') => (child) => {
  if (output) child.stdout.emit('data', Buffer.from(output));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', code);
};

describe('smallModelFor', () => {
  it('picks the cheapest family each engine lists', () => {
    expect(smallModelFor(claude)).toBe('haiku');
    expect(smallModelFor(codex)).toBe('gpt-6-luna');
    expect(smallModelFor(antigravity)).toBe('gemini-3.8-flash');
  });

  it('falls back to the default model', () => {
    expect(smallModelFor(engineAdapter('claude', ['opus', 'sonnet'], 'sonnet'))).toBe('sonnet');
    expect(smallModelFor(engineAdapter('fake', ['fast', 'slow-mini'], 'fast'))).toBe('fast');
  });
});

describe('one-shot generator', () => {
  it('asks Claude through stdin in print mode without tools or a saved session', async () => {
    const { calls, spawn } = createFakeChildren(reply(JSON.stringify({ result: ' Session titles \n', is_error: false })));
    const text = await createOneShotGenerator({ spawn }).generateText({ adapter: claude, prompt: 'Title this' });

    expect(text).toBe('Session titles');
    expect(calls[0].input).toBe('Title this');
    const { args } = calls[0];
    expect(args.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(args).toContain('--no-session-persistence');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).not.toContain('Title this');
  });

  it('reports a Claude error result as a failure', async () => {
    const { spawn } = createFakeChildren(reply(JSON.stringify({ result: 'Not logged in · Please run /login', is_error: true }), 1));
    await expect(createOneShotGenerator({ spawn }).generateText({ adapter: claude, prompt: 'x' })).rejects.toThrow('Not logged in');
  });

  it('runs codex exec on the requested model and reads its final message', async () => {
    const { calls, spawn } = createFakeChildren(reply('Oturum başlıkları\n'));
    const text = await createOneShotGenerator({ spawn }).generateText({ adapter: codex, model: 'gpt-5.6-luna', prompt: 'Başlık' });

    expect(text).toBe('Oturum başlıkları');
    expect(calls[0].input).toBe('Başlık');
    expect(calls[0].args.slice(0, 3)).toEqual(['exec', '-m', 'gpt-5.6-luna']);
    expect(calls[0].args).toContain('--ephemeral');
    expect(calls[0].args.at(-1)).toBe('-');
  });

  it('passes the prompt to agy as its print argument and reads the response', async () => {
    const { calls, spawn } = createFakeChildren(reply(JSON.stringify({ status: 'SUCCESS', response: 'Session titles\n' })));
    const text = await createOneShotGenerator({ spawn }).generateText({ adapter: antigravity, prompt: 'Title this' });

    expect(text).toBe('Session titles');
    expect(calls[0].args.slice(0, 4)).toEqual(['-p', 'Title this', '--model', 'gemini-3.8-flash']);
    expect(calls[0].input).toBeUndefined();
  });

  it('fails with the last stderr line when the CLI exits with an error', async () => {
    const { spawn } = createFakeChildren(reply('', 1, 'starting\nError: not signed in\n'));
    await expect(createOneShotGenerator({ spawn }).generateText({ adapter: codex, prompt: 'x' })).rejects.toThrow('Error: not signed in');
  });

  it('fails on an empty answer', async () => {
    const { spawn } = createFakeChildren(reply(''));
    await expect(createOneShotGenerator({ spawn }).generateText({ adapter: codex, prompt: 'x' })).rejects.toThrow('The answer was empty');
  });

  it('kills a CLI that does not answer in time', async () => {
    const { calls, spawn } = createFakeChildren(() => {});
    await expect(createOneShotGenerator({ spawn, timeoutMs: 10 }).generateText({ adapter: claude, prompt: 'x' })).rejects.toThrow('No answer within 10 ms');
    expect(calls[0].child.killed).toEqual(['SIGKILL']);
  });

  it('kills the CLI when the caller cancels', async () => {
    const { calls, spawn } = createFakeChildren(() => {});
    const controller = new AbortController();
    const pending = createOneShotGenerator({ spawn }).generateText({ adapter: claude, prompt: 'x', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('cancelled');
    expect(calls[0].child.killed).toEqual(['SIGKILL']);
  });

  it('refuses an engine it has no CLI recipe for', async () => {
    const { calls, spawn } = createFakeChildren(reply('never'));
    await expect(createOneShotGenerator({ spawn }).generateText({ adapter: engineAdapter('fake', ['fast']), prompt: 'x' })).rejects.toThrow('cannot answer');
    expect(calls).toHaveLength(0);
  });
});
