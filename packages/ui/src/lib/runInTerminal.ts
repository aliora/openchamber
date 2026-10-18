import { useUIStore } from '@/stores/useUIStore';
import { runChatCommand, type ChatCommandResult } from './chatCommandRun';
import type { CreateTerminalOptions, TerminalAPI } from './api/types';

export type TerminalCommandOptions = Omit<Extract<CreateTerminalOptions, { mode: 'command' }>, 'mode' | 'command' | 'sessionId' | 'cwd' | 'purpose'>;

export type TerminalTarget = { directory: string; panelDirectory: string | null };

type RevealListener = (target: TerminalTarget) => void;

const workspaceRevealListeners = new Set<RevealListener>();

export const subscribeWorkspaceTerminalReveal = (listener: RevealListener): (() => void) => {
  workspaceRevealListeners.add(listener);
  return () => {
    workspaceRevealListeners.delete(listener);
  };
};

export const revealTerminal = (target: TerminalTarget): void => {
  const ui = useUIStore.getState();
  ui.setEngineSetupOpen(false);
  if (workspaceRevealListeners.size > 0) {
    for (const listener of workspaceRevealListeners) listener(target);
    return;
  }
  ui.setSettingsDialogOpen(false);
  const panelDirectory = target.panelDirectory ?? target.directory;
  ui.openContextPanelTab(panelDirectory, {
    mode: 'terminal',
    targetDirectory: panelDirectory === target.directory ? null : target.directory,
  });
};

type RunInTerminalOptions = {
  terminal: TerminalAPI;
  command: string;
  target: TerminalTarget;
  ownerId: string;
  createOptions: TerminalCommandOptions;
};

export const runInTerminal = ({ terminal, command, target, ownerId, createOptions }: RunInTerminalOptions): Promise<ChatCommandResult> => runChatCommand({
  terminal,
  ownerId,
  command,
  directory: target.directory,
  createOptions,
  revealTerminal: () => revealTerminal(target),
});

export const resolveTerminalTarget = (effectiveDirectory: string | null, homeDirectory: string | null): TerminalTarget | null => {
  if (effectiveDirectory) return { directory: effectiveDirectory, panelDirectory: effectiveDirectory };
  const home = homeDirectory && homeDirectory !== '/' ? homeDirectory : null;
  return home ? { directory: home, panelDirectory: null } : null;
};
