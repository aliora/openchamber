import React from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ChatCommandResult } from '@/lib/chatCommandRun';
import { resolveTerminalTarget, runInTerminal, type TerminalCommandOptions } from '@/lib/runInTerminal';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';

export const useTerminalCommandOptions = (): TerminalCommandOptions => {
  const { currentTheme } = useThemeSystem();
  const shell = useUIStore((state) => state.terminalShell);
  const loginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  return React.useMemo(() => ({
    shell,
    loginShell,
    themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
    terminalBackground: currentTheme.colors.surface.background,
    terminalForeground: currentTheme.colors.syntax.base.foreground,
  }), [currentTheme, loginShell, shell]);
};

export type RunInTerminal = (command: string, ownerId: string) => Promise<ChatCommandResult>;

export const useRunInTerminal = (): RunInTerminal | null => {
  const { terminal, runtime } = useRuntimeAPIs();
  const effectiveDirectory = useEffectiveDirectory() ?? null;
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const createOptions = useTerminalCommandOptions();
  return React.useMemo(() => {
    const target = resolveTerminalTarget(effectiveDirectory, homeDirectory);
    if (runtime.isVSCode || !target) return null;
    return (command: string, ownerId: string) => runInTerminal({ terminal, command, target, ownerId, createOptions });
  }, [createOptions, effectiveDirectory, homeDirectory, runtime.isVSCode, terminal]);
};
