import { beforeEach, describe, expect, test } from 'bun:test';

import { createHostSessionOpener, type HostOpenProblem, type HostOpenRequest, type HostSessionOpenerDependencies } from './open-host-session';
import type { HostConnection, HostDescriptor } from './types';

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
const LIVE: HostConnection = { state: 'live', since: 1, via: 'stream' };

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** What a test sets on the fake window. */
type WindowState = {
  drafts: number;
  unsentDraft: boolean;
  failSwitch: boolean;
  /** Holds every switch until released, for clicks that arrive meanwhile. */
  holdSwitch: Promise<void> | null;
};

/**
 * A window on `local`: switching moves the runtime key and resets the session
 * list like the real switch does, and `loadList` completes the new host's list.
 */
const createWindow = () => {
  let runtimeKey = 'local';
  let complete = true;
  let sessions = new Set<string>(['local-session']);
  const sessionsByHost = new Map<string, Set<string>>();
  const runtimeListeners = new Set<(next: string, previous: string) => void>();
  const storeListeners = new Set<() => void>();
  const selected: Array<{ sessionId: string; directory: string }> = [];
  const switches: string[] = [];
  const state: WindowState = { drafts: 0, unsentDraft: false, failSwitch: false, holdSwitch: null };
  const notifyStore = () => { for (const listener of storeListeners) listener(); };
  const deps: HostSessionOpenerDependencies = {
    getActiveRuntimeKey: () => runtimeKey,
    switchToHost: async (target) => {
      switches.push(target.id);
      if (state.holdSwitch) await state.holdSwitch;
      if (state.failSwitch) throw new Error('unreachable');
      const previous = runtimeKey;
      runtimeKey = target.runtimeKey;
      complete = false;
      sessions = new Set();
      for (const listener of runtimeListeners) listener(runtimeKey, previous);
      notifyStore();
    },
    subscribeRuntimeChanged: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    readGlobalSessions: () => ({ complete, hasSession: (sessionId) => sessions.has(sessionId) }),
    subscribeGlobalSessions: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    selectSession: (sessionId, directory) => { selected.push({ sessionId, directory }); },
    openDraft: () => { state.drafts += 1; },
    hasUnsentDraft: () => state.unsentDraft,
    openInHostWindow: () => true,
  };
  return {
    deps,
    state,
    selected,
    switches,
    runtimeKey: () => runtimeKey,
    listeners: () => storeListeners.size + runtimeListeners.size,
    setHostSessions: (key: string, ids: string[]) => sessionsByHost.set(key, new Set(ids)),
    /** The active host's first complete list arrives. */
    loadList: () => {
      sessions = sessionsByHost.get(runtimeKey) ?? new Set();
      complete = true;
      notifyStore();
    },
  };
};

describe('opening a session of another host', () => {
  let win: ReturnType<typeof createWindow>;
  let problems: HostOpenProblem[];
  const request = (target: HostDescriptor, sessionId: string, connection: HostConnection = LIVE): HostOpenRequest => ({
    host: target,
    connection,
    target: { kind: 'session', sessionId, directory: `/work/${sessionId}` },
    confirmLeavingDraft: async () => false,
    onProblem: (problem: HostOpenProblem) => { problems.push(problem); },
  });

  beforeEach(() => {
    win = createWindow();
    problems = [];
  });

  test('switches, then opens the session once the host\'s first complete list arrives', async () => {
    const opener = createHostSessionOpener(win.deps);
    win.setHostSessions('host:studio', ['ses_a']);
    expect(await opener.open(request(STUDIO, 'ses_a'))).toBe('pending');
    expect(win.runtimeKey()).toBe('host:studio');
    // The previous host's complete list never counts: nothing opens before the new one.
    expect(win.selected).toEqual([]);

    win.loadList();
    expect(win.selected).toEqual([{ sessionId: 'ses_a', directory: '/work/ses_a' }]);
    expect(win.listeners()).toBe(0);
    win.loadList();
    expect(win.selected).toHaveLength(1);
  });

  test('a session gone from the host is reported and the window stays on the host', async () => {
    const opener = createHostSessionOpener(win.deps);
    win.setHostSessions('host:studio', ['other']);
    await opener.open(request(STUDIO, 'ses_gone'));
    win.loadList();
    expect(problems).toEqual(['missing']);
    expect(win.selected).toEqual([]);
    expect(win.runtimeKey()).toBe('host:studio');
  });

  test('a failed switch keeps the current host and opens nothing later', async () => {
    const opener = createHostSessionOpener(win.deps);
    win.state.failSwitch = true;
    expect(await opener.open(request(STUDIO, 'ses_a'))).toBe('failed');
    expect(problems).toEqual(['failed']);
    expect(win.runtimeKey()).toBe('local');
    expect(win.listeners()).toBe(0);
    win.loadList();
    expect(win.selected).toEqual([]);
  });

  test('a host that does not answer is not switched to', async () => {
    const opener = createHostSessionOpener(win.deps);
    const offline: HostConnection = { state: 'backoff', failure: 'unreachable', retryAt: 9 };
    expect(await opener.open(request(STUDIO, 'ses_a', offline))).toBe('unreachable');
    expect(await opener.open(request(STUDIO, 'ses_a', { state: 'connecting' }))).toBe('connecting');
    expect(await opener.open(request(STUDIO, 'ses_a', { state: 'relay-limit' }))).toBe('unreachable');
    expect(win.switches).toEqual([]);
    expect(problems).toEqual(['unreachable', 'connecting', 'unreachable']);
  });

  test('an unsent draft asks first; keeping it cancels the switch', async () => {
    const opener = createHostSessionOpener(win.deps);
    win.state.unsentDraft = true;
    expect(await opener.open(request(STUDIO, 'ses_a'))).toBe('cancelled');
    expect(win.switches).toEqual([]);

    win.setHostSessions('host:studio', ['ses_a']);
    expect(await opener.open({ ...request(STUDIO, 'ses_a'), confirmLeavingDraft: async () => true })).toBe('pending');
    win.loadList();
    expect(win.selected.map((entry) => entry.sessionId)).toEqual(['ses_a']);
  });

  test('a second click during the switch changes what opens without switching twice', async () => {
    const opener = createHostSessionOpener(win.deps);
    let release: () => void = () => {};
    win.state.holdSwitch = new Promise<void>((resolve) => { release = resolve; });
    win.setHostSessions('host:studio', ['ses_a', 'ses_b']);
    const first = opener.open(request(STUDIO, 'ses_a'));
    await flush();
    expect(await opener.open(request(STUDIO, 'ses_b'))).toBe('pending');
    release();
    expect(await first).toBe('pending');
    win.loadList();
    expect(win.switches).toEqual(['studio']);
    expect(win.selected.map((entry) => entry.sessionId)).toEqual(['ses_b']);
  });

  test('clicks on two hosts switch one after another and the last one opens', async () => {
    const opener = createHostSessionOpener(win.deps);
    let release: () => void = () => {};
    win.state.holdSwitch = new Promise<void>((resolve) => { release = resolve; });
    win.setHostSessions('host:laptop', ['ses_l']);
    const first = opener.open(request(STUDIO, 'ses_a'));
    await flush();
    const second = opener.open(request(LAPTOP, 'ses_l'));
    release();
    expect(await first).toBe('pending');
    expect(await second).toBe('pending');
    expect(win.switches).toEqual(['studio', 'laptop']);
    expect(win.runtimeKey()).toBe('host:laptop');
    win.loadList();
    expect(win.selected.map((entry) => entry.sessionId)).toEqual(['ses_l']);
  });

  test('a session of the host the window is on opens at once; a draft target opens a draft there', async () => {
    const opener = createHostSessionOpener(win.deps);
    expect(await opener.open({ ...request({ ...STUDIO, runtimeKey: 'local' }, 'local-session') })).toBe('opened');
    expect(win.selected.map((entry) => entry.sessionId)).toEqual(['local-session']);
    expect(win.switches).toEqual([]);

    expect(await opener.open({ ...request(STUDIO, 'unused'), target: { kind: 'draft' } })).toBe('pending');
    expect(win.state.drafts).toBe(0);
    win.loadList();
    expect(win.state.drafts).toBe(1);
  });
});
