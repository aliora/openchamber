import { describe, expect, test } from 'bun:test';

import { createHostSessionOpener, type HostOpenProblem, type HostSessionOpenerDependencies } from './open-host-session';
import type { HostDescriptor } from './types';

const host = (id: string): HostDescriptor => ({
  id,
  label: id,
  kind: 'direct',
  displayUrl: `https://${id}.example`,
  runtimeKey: `host:${id}`,
  monitored: true,
});

const STUDIO = host('studio');
const LAPTOP = host('laptop');

const createWindow = () => {
  let focusedKey = 'local';
  let release: (() => void) | null = null;
  const listsByHost = new Map<string, { complete: boolean; ids: Set<string> }>([['local', { complete: true, ids: new Set(['local-session']) }]]);
  const focused: string[] = [];
  const opened: string[] = [];
  const problems: HostOpenProblem[] = [];
  const state = { refuseFocus: false, holdFocus: false };
  const deps: HostSessionOpenerDependencies = {
    getActiveRuntimeKey: () => focusedKey,
    focusHost: async (target) => {
      focused.push(target.id);
      if (state.holdFocus) await new Promise<void>((resolve) => { release = resolve; });
      if (state.refuseFocus) throw new Error('not registered');
      focusedKey = target.runtimeKey;
    },
    readGlobalSessions: () => {
      const list = listsByHost.get(focusedKey) ?? { complete: false, ids: new Set<string>() };
      return { complete: list.complete, hasSession: (sessionId) => list.ids.has(sessionId) };
    },
    selectSession: (sessionId) => { opened.push(`${focusedKey}:${sessionId}`); },
    openDraft: (directory) => { opened.push(`${focusedKey}:draft:${directory ?? ''}`); },
    openInHostWindow: () => true,
  };
  return {
    opener: createHostSessionOpener(deps),
    focused,
    opened,
    problems,
    state,
    onProblem: (problem: HostOpenProblem) => { problems.push(problem); },
    setList: (key: string, ids: string[], complete = true) => listsByHost.set(key, { complete, ids: new Set(ids) }),
    release: () => release?.(),
  };
};

describe('opening a session of another host', () => {
  test('a background host is focused and its session selected at once from its own list', async () => {
    const window = createWindow();
    window.setList(STUDIO.runtimeKey, ['ses_a']);

    const result = await window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_a', directory: '/w' }, onProblem: window.onProblem });

    expect(result).toBe('opened');
    expect(window.focused).toEqual(['studio']);
    expect(window.opened).toEqual(['host:studio:ses_a']);
  });

  test('a host whose list has not arrived (offline or connecting) still opens the session, so its chat shows why', async () => {
    const window = createWindow();
    window.setList(STUDIO.runtimeKey, [], false);

    await window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_a', directory: '/w' }, onProblem: window.onProblem });

    expect(window.opened).toEqual(['host:studio:ses_a']);
    expect(window.problems).toEqual([]);
  });

  test('a session gone from the host\'s complete list is reported and the focus stays on the host', async () => {
    const window = createWindow();
    window.setList(STUDIO.runtimeKey, ['ses_other']);

    const result = await window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_gone', directory: '/w' }, onProblem: window.onProblem });

    expect(result).toBe('missing');
    expect(window.problems).toEqual(['missing']);
    expect(window.opened).toEqual([]);
  });

  test('a focus that does not move reports failed and opens nothing', async () => {
    const window = createWindow();
    window.state.refuseFocus = true;

    const result = await window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_a', directory: '/w' }, onProblem: window.onProblem });

    expect(result).toBe('failed');
    expect(window.problems).toEqual(['failed']);
    expect(window.opened).toEqual([]);
  });

  test('the focused host opens at once without moving the focus; a draft opens there', async () => {
    const window = createWindow();

    await window.opener.open({ host: { ...STUDIO, runtimeKey: 'local' }, target: { kind: 'session', sessionId: 'local-session', directory: '/w' }, onProblem: window.onProblem });
    await window.opener.open({ host: { ...STUDIO, runtimeKey: 'local' }, target: { kind: 'draft', directory: '/w/api' }, onProblem: window.onProblem });

    expect(window.focused).toEqual([]);
    expect(window.opened).toEqual(['local:local-session', 'local:draft:/w/api']);
  });

  test('clicks while a focus move runs: the last click wins', async () => {
    const window = createWindow();
    window.setList(STUDIO.runtimeKey, ['ses_a', 'ses_b']);
    window.setList(LAPTOP.runtimeKey, ['ses_c']);
    window.state.holdFocus = true;

    const first = window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_a', directory: '/w' }, onProblem: window.onProblem });
    await Promise.resolve();
    await Promise.resolve();
    expect(window.focused).toEqual(['studio']);
    const second = window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_b', directory: '/w' }, onProblem: window.onProblem });
    const third = window.opener.open({ host: LAPTOP, target: { kind: 'session', sessionId: 'ses_c', directory: '/w' }, onProblem: window.onProblem });
    await Promise.resolve();
    window.state.holdFocus = false;
    window.release();

    expect(await Promise.all([first, second, third])).toEqual(['superseded', 'superseded', 'opened']);
    expect(window.focused).toEqual(['studio', 'laptop']);
    expect(window.opened).toEqual(['host:laptop:ses_c']);
  });

  test('a session picked on the focused host wins over an open still waiting for its focus move', async () => {
    const window = createWindow();
    window.setList(STUDIO.runtimeKey, ['ses_a']);
    window.state.holdFocus = true;

    const pending = window.opener.open({ host: STUDIO, target: { kind: 'session', sessionId: 'ses_a', directory: '/w' }, onProblem: window.onProblem });
    await Promise.resolve();
    window.opener.supersede();
    window.release();

    expect(await pending).toBe('superseded');
    expect(window.opened).toEqual([]);
  });
});
