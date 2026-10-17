import { useTerminalStore } from '@/stores/useTerminalStore';
import { createProjectActionTerminalSession, normalizeProjectActionCommand } from './projectActionTerminal';
import type { CreateTerminalOptions, TerminalAPI } from './api/types';

const CHAT_COMMAND_ACTION_PREFIX = 'chat-command-';
const OUTPUT_BUFFER_CHARS = 65536;
const OUTPUT_TAIL_LINES = 40;
const OUTPUT_TAIL_CHARS = 4000;
const TAB_LABEL_CHARS = 32;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, 'g');
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const SHORT_ESCAPE_PATTERN = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g');

export type ChatCommandResult = {
  command: string;
  terminalSessionId: string;
  exitCode: number | null;
  signal: number | null;
  output: string;
};

type ChatCommandCreateOptions = Omit<Extract<CreateTerminalOptions, { mode: 'command' }>, 'mode' | 'command' | 'sessionId' | 'cwd' | 'purpose'>;

type RunChatCommandOptions = {
  terminal: TerminalAPI;
  ownerId: string;
  command: string;
  directory: string;
  createOptions: ChatCommandCreateOptions;
  revealTerminal: () => void;
};

const lastCarriageReturnSegment = (line: string): string => {
  const segments = line.split('\r').filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? '';
};

export const isChatCommandActionId = (actionId: string): boolean => actionId.startsWith(CHAT_COMMAND_ACTION_PREFIX);

export const toPlainTerminalText = (raw: string): string => raw
  .replace(OSC_PATTERN, '')
  .replace(CSI_PATTERN, '')
  .replace(SHORT_ESCAPE_PATTERN, '')
  .split(/\r*\n/)
  .map(lastCarriageReturnSegment)
  .join('\n');

export const tailTerminalOutput = (raw: string): string => {
  const lines = toPlainTerminalText(raw).split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const tail = lines.slice(-OUTPUT_TAIL_LINES).join('\n');
  return tail.length > OUTPUT_TAIL_CHARS ? tail.slice(-OUTPUT_TAIL_CHARS) : tail;
};

const NO_OUTPUT = '(no output)';
const CONTEXT_COMMAND_CHARS = 80;

const describeExit = ({ exitCode, signal }: ChatCommandResult): string => {
  if (exitCode !== null) return `exit code ${exitCode}`;
  if (signal !== null) return `signal ${signal}`;
  return 'stopped';
};

export type ChatCommandContext = {
  label: string;
  output: string;
  lineCount: number;
};

export const buildChatCommandContext = (result: ChatCommandResult): ChatCommandContext => {
  const output = tailTerminalOutput(result.output) || NO_OUTPUT;
  return {
    label: `$ ${summarizeCommand(result.command, CONTEXT_COMMAND_CHARS)} (${describeExit(result)})`,
    output,
    lineCount: output.split('\n').length,
  };
};

export const summarizeCommand = (command: string, maxChars = TAB_LABEL_CHARS): string => {
  const firstLine = command.split('\n').map((line) => line.trim()).find((line) => line && !line.startsWith('#')) ?? command.trim();
  const hasMore = command.trim() !== firstLine;
  const clipped = firstLine.length > maxChars ? `${firstLine.slice(0, maxChars - 1)}…` : firstLine;
  return hasMore && !clipped.endsWith('…') ? `${clipped} …` : clipped;
};

const appendBounded = (buffer: string, chunk: string): string => {
  const next = buffer + chunk;
  return next.length > OUTPUT_BUFFER_CHARS ? next.slice(-OUTPUT_BUFFER_CHARS) : next;
};

export const runChatCommand = async ({
  terminal,
  command,
  directory,
  createOptions,
  revealTerminal,
  ownerId,
}: RunChatCommandOptions): Promise<ChatCommandResult> => {
  const normalizedCommand = normalizeProjectActionCommand(command);
  if (!normalizedCommand) throw new Error('Empty command');

  const executionId = crypto.randomUUID();
  const actionId = `${CHAT_COMMAND_ACTION_PREFIX}${ownerId}`;
  const store = useTerminalStore.getState();
  store.ensureDirectory(directory);
  const ownTab = store.getDirectoryState(directory)?.tabs.find((tab) => tab.purpose.type === 'project-action' && tab.purpose.actionId === actionId);
  if (ownTab?.terminalSessionId && ownTab.lifecycle !== 'exited' && ownTab.lifecycle !== 'idle') {
    await terminal.close(ownTab.terminalSessionId).catch(() => undefined);
  }
  const tabId = ownTab?.id ?? store.createTab(directory);
  store.setTabLabel(directory, tabId, summarizeCommand(normalizedCommand));
  store.setTabIconKey(directory, tabId, 'play');
  store.setTabPurpose(directory, tabId, { type: 'project-action', actionId, executionId });
  store.setActiveTab(directory, tabId);
  store.setConnecting(directory, tabId, true, { expectedExecutionId: executionId });
  revealTerminal();

  const isTabStillOpen = () => Boolean(useTerminalStore.getState().getDirectoryState(directory)?.tabs.some((tab) => tab.id === tabId));
  let sessionId: string;
  try {
    const created = await createProjectActionTerminalSession({
      terminal,
      createOptions: { ...createOptions, cwd: directory },
      command: normalizedCommand,
      isRunStillExpected: isTabStillOpen,
      purpose: { type: 'project-action', actionId, executionId },
    });
    sessionId = created.sessionId;
  } catch (error) {
    useTerminalStore.getState().setConnecting(directory, tabId, false, { expectedExecutionId: executionId });
    useTerminalStore.getState().setTabLifecycle(directory, tabId, 'exited', { expectedExecutionId: executionId });
    throw error;
  }

  const current = useTerminalStore.getState();
  current.setTabSessionId(directory, tabId, sessionId, { expectedExecutionId: executionId });
  current.setTabLifecycle(directory, tabId, 'running', { expectedExecutionId: executionId });
  current.setConnecting(directory, tabId, false, { expectedExecutionId: executionId });

  return new Promise<ChatCommandResult>((resolve, reject) => {
    let output = '';
    let settled = false;
    let subscription: { close: () => void } | null = null;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      subscription?.close();
      useTerminalStore.getState().setTabLifecycle(directory, tabId, 'exited', { expectedExecutionId: executionId });
      finish();
    };
    const finishWithExit = (exitCode: number | undefined, signal: number | null | undefined) => settle(() => resolve({
      command: normalizedCommand,
      terminalSessionId: sessionId,
      exitCode: exitCode ?? null,
      signal: signal ?? null,
      output,
    }));
    subscription = terminal.connect(sessionId, {
      onEvent: (event) => {
        if (event.type === 'snapshot') {
          output = appendBounded('', event.data ?? '');
          if (event.status === 'exited') finishWithExit(event.exitCode, event.signal);
          return;
        }
        if (event.type === 'data') {
          output = appendBounded(output, event.data ?? '');
          return;
        }
        if (event.type === 'exit') finishWithExit(event.exitCode, event.signal);
      },
      onError: (error, fatal) => {
        if (fatal) settle(() => reject(error));
      },
    }, directory);
    if (settled) subscription.close();
  });
};
