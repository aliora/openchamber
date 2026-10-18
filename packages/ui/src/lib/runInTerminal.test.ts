import { afterEach, describe, expect, test } from 'bun:test';
import { useUIStore } from '@/stores/useUIStore';
import { resolveTerminalTarget, revealTerminal, subscribeWorkspaceTerminalReveal, type TerminalTarget } from './runInTerminal';

const original = useUIStore.getState();

afterEach(() => {
  useUIStore.setState({
    openContextPanelTab: original.openContextPanelTab,
    setSettingsDialogOpen: original.setSettingsDialogOpen,
    setEngineSetupOpen: original.setEngineSetupOpen,
  });
});

const spyOnPanel = () => {
  const calls: string[] = [];
  useUIStore.setState({
    openContextPanelTab: (directory, tab) => { calls.push(`panel ${directory} ${tab.mode} ${tab.targetDirectory ?? '-'}`); },
    setSettingsDialogOpen: (open) => { calls.push(`settings ${open}`); },
    setEngineSetupOpen: (open) => { calls.push(`wizard ${open}`); },
  });
  return calls;
};

describe('revealTerminal', () => {
  test('without a workspace drawer it closes Settings and opens the terminal panel', () => {
    const calls = spyOnPanel();
    revealTerminal({ directory: '/repo', panelDirectory: '/repo' });
    expect(calls).toEqual(['wizard false', 'settings false', 'panel /repo terminal -']);
  });

  test('a home-folder terminal opens in the panel as its target folder', () => {
    const calls = spyOnPanel();
    revealTerminal({ directory: '/Users/me', panelDirectory: null });
    expect(calls).toEqual(['wizard false', 'settings false', 'panel /Users/me terminal -']);
  });

  test('a mounted workspace drawer takes the request instead', () => {
    const calls = spyOnPanel();
    const seen: TerminalTarget[] = [];
    const unsubscribe = subscribeWorkspaceTerminalReveal((target) => seen.push(target));
    revealTerminal({ directory: '/repo', panelDirectory: '/repo' });
    unsubscribe();
    expect(seen).toEqual([{ directory: '/repo', panelDirectory: '/repo' }]);
    expect(calls).toEqual(['wizard false']);
  });
});

describe('resolveTerminalTarget', () => {
  test('the active folder wins', () => {
    expect(resolveTerminalTarget('/repo', '/Users/me')).toEqual({ directory: '/repo', panelDirectory: '/repo' });
  });

  test('without one the home folder is used', () => {
    expect(resolveTerminalTarget(null, '/Users/me')).toEqual({ directory: '/Users/me', panelDirectory: null });
  });

  test('an unresolved home is not a folder to run in', () => {
    expect(resolveTerminalTarget(null, '/')).toBeNull();
    expect(resolveTerminalTarget(null, '')).toBeNull();
  });
});
