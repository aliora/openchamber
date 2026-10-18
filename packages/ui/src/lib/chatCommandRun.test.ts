import { describe, expect, test } from 'bun:test';
import { useTerminalStore } from '@/stores/useTerminalStore';
import type { TerminalAPI, TerminalHandlers } from './api/types';
import {
  buildChatCommandContext,
  runChatCommand,
  summarizeCommand,
  tailTerminalOutput,
  toPlainTerminalText,
} from './chatCommandRun';

const ESC = String.fromCharCode(27);

const fakeCommandTerminal = () => {
  let handlers: TerminalHandlers | null = null;
  let closed = false;
  const commands: string[] = [];
  const terminal: TerminalAPI = {
    createSession: async (options) => {
      if (options.mode === 'command') commands.push(options.command);
      return { sessionId: options.sessionId ?? 'term-1', cols: 80, rows: 24, status: 'running', mode: 'command', purpose: options.purpose };
    },
    connect: (_id, nextHandlers) => { handlers = nextHandlers; return { close: () => { closed = true; } }; },
    sendInput: async () => {}, resize: async () => {}, close: async () => {},
  };
  return {
    terminal,
    commands,
    emit: (event: Parameters<TerminalHandlers['onEvent']>[0]) => handlers?.onEvent(event),
    fail: () => handlers?.onError?.(new Error('lost'), true),
    isClosed: () => closed,
  };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('chat command run', () => {
  test('strips terminal escapes and keeps the last carriage-return frame', () => {
    const raw = `${ESC}]0;title${String.fromCharCode(7)}${ESC}[32mok${ESC}[0m\r\n10%\r50%\r100%\r\ndone`;
    expect(toPlainTerminalText(raw)).toBe('ok\n100%\ndone');
  });

  test('keeps only the tail of long output', () => {
    const raw = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\r\n');
    const tail = tailTerminalOutput(`${raw}\r\n\r\n`).split('\n');
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe('line 60');
    expect(tail[39]).toBe('line 99');
  });

  test('describes a failed run for the next message', () => {
    const context = buildChatCommandContext({ command: 'npm test', terminalSessionId: 't1', exitCode: 1, signal: null, output: 'ok\r\nFAIL src/a.test.ts\r\n' });
    expect(context).toEqual({ label: '$ npm test (exit code 1)', output: 'ok\nFAIL src/a.test.ts', lineCount: 2 });
  });

  test('a silent success still carries its exit code', () => {
    expect(buildChatCommandContext({ command: 'true', terminalSessionId: 't1', exitCode: 0, signal: null, output: '' }))
      .toEqual({ label: '$ true (exit code 0)', output: '(no output)', lineCount: 1 });
  });

  test('a killed command reports its signal', () => {
    expect(buildChatCommandContext({ command: 'sleep 9', terminalSessionId: 't1', exitCode: null, signal: 15, output: '' }).label)
      .toBe('$ sleep 9 (signal 15)');
  });

  test('labels a tab with the first real command line', () => {
    expect(summarizeCommand('# check disk\ndf -h\nls')).toBe('df -h …');
    expect(summarizeCommand('git status')).toBe('git status');
    expect(summarizeCommand('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  test('runs the command in a new terminal tab and resolves with its exit', async () => {
    const directory = '/repo-chat-run';
    const fake = fakeCommandTerminal();
    let revealed = false;
    const run = runChatCommand({
      terminal: fake.terminal,
      ownerId: 'chat-1',
      command: '  npm test  ',
      directory,
      createOptions: {},
      revealTerminal: () => { revealed = true; },
    });
    await flush();
    const tab = useTerminalStore.getState().getDirectoryState(directory)?.tabs.at(-1);
    expect(revealed).toBe(true);
    expect(fake.commands).toEqual(['npm test']);
    expect(tab?.label).toBe('npm test');
    expect(tab?.lifecycle).toBe('running');
    expect(tab?.terminalSessionId).not.toBeNull();

    fake.emit({ type: 'snapshot', sequence: 1, status: 'running', data: 'start\r\n' });
    fake.emit({ type: 'data', sequence: 2, data: 'FAIL\r\n' });
    fake.emit({ type: 'exit', sequence: 3, exitCode: 2, signal: null });

    expect(await run).toEqual({ command: 'npm test', terminalSessionId: tab?.terminalSessionId ?? '', exitCode: 2, signal: null, output: 'start\r\nFAIL\r\n' });
    expect(fake.isClosed()).toBe(true);
    expect(useTerminalStore.getState().getDirectoryState(directory)?.tabs.at(-1)?.lifecycle).toBe('exited');
  });

  test('resolves from a snapshot when the command already exited', async () => {
    const fake = fakeCommandTerminal();
    const run = runChatCommand({ terminal: fake.terminal, ownerId: 'chat-1', command: 'true', directory: '/repo-chat-run-fast', createOptions: {}, revealTerminal: () => {} });
    await flush();
    fake.emit({ type: 'snapshot', sequence: 1, status: 'exited', exitCode: 0, data: '' });
    expect((await run).exitCode).toBe(0);
  });

  test('rejects when the stream is lost before an exit', async () => {
    const fake = fakeCommandTerminal();
    const run = runChatCommand({ terminal: fake.terminal, ownerId: 'chat-1', command: 'sleep 9', directory: '/repo-chat-run-lost', createOptions: {}, revealTerminal: () => {} });
    await flush();
    fake.fail();
    await expect(run).rejects.toThrow('lost');
  });

  test('shows why the command could not start inside its tab', async () => {
    const directory = '/repo-chat-run-start-failure';
    const fake = fakeCommandTerminal();
    const terminal: TerminalAPI = { ...fake.terminal, createSession: async () => { throw new Error('Terminal shell "fish" is not available'); } };
    await expect(runChatCommand({ terminal, ownerId: 'chat-1', command: 'claude auth login', directory, createOptions: {}, revealTerminal: () => {} })).rejects.toThrow('not available');
    const tab = useTerminalStore.getState().getDirectoryState(directory)?.tabs.at(-1);
    expect(tab?.lifecycle).toBe('exited');
    const buffer = useTerminalStore.getState().getBuffer(directory, tab?.id ?? '');
    expect(toPlainTerminalText(buffer.chunks.map((chunk) => chunk.data).join(''))).toBe('$ claude auth login\nTerminal shell "fish" is not available\n');
  });

  test('refuses an empty command', async () => {
    const fake = fakeCommandTerminal();
    await expect(runChatCommand({ terminal: fake.terminal, ownerId: 'chat-1', command: ' \n ', directory: '/repo-chat-run-empty', createOptions: {}, revealTerminal: () => {} })).rejects.toThrow('Empty command');
  });

  test('runs again in the same tab of the chat and stops a run still going', async () => {
    const directory = '/repo-chat-run-reuse';
    const fake = fakeCommandTerminal();
    const closedSessions: string[] = [];
    fake.terminal.close = async (sessionId) => { closedSessions.push(sessionId); };
    const tabsOf = () => useTerminalStore.getState().getDirectoryState(directory)?.tabs ?? [];
    const options = { terminal: fake.terminal, ownerId: 'chat-9', directory, createOptions: {}, revealTerminal: () => {} };

    void runChatCommand({ ...options, command: 'sleep 9' });
    await flush();
    const firstTab = tabsOf().at(-1);
    const second = runChatCommand({ ...options, command: 'ls' });
    await flush();

    expect(closedSessions).toEqual([firstTab?.terminalSessionId ?? '']);
    expect(tabsOf().filter((tab) => tab.purpose.type === 'project-action')).toHaveLength(1);
    expect(tabsOf().at(-1)?.id).toBe(firstTab?.id);
    expect(tabsOf().at(-1)?.label).toBe('ls');
    fake.emit({ type: 'exit', sequence: 1, exitCode: 0, signal: null });
    expect((await second).exitCode).toBe(0);
  });

  test('chats get separate tabs', async () => {
    const directory = '/repo-chat-run-owners';
    const fake = fakeCommandTerminal();
    void runChatCommand({ terminal: fake.terminal, ownerId: 'chat-a', command: 'ls', directory, createOptions: {}, revealTerminal: () => {} });
    void runChatCommand({ terminal: fake.terminal, ownerId: 'chat-b', command: 'ls', directory, createOptions: {}, revealTerminal: () => {} });
    await flush();
    expect(useTerminalStore.getState().getDirectoryState(directory)?.tabs.filter((tab) => tab.purpose.type === 'project-action')).toHaveLength(2);
  });
});
