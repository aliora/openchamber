import { describe, expect, test } from 'bun:test';

import { createHostSessionOpener, type HostOpenProblem, type HostSessionOpenerDependencies } from '@/lib/hosts/open-host-session';
import type { HostDescriptor } from '@/lib/hosts/types';

import { connectMobileHost, withMobileConnect } from './mobileHostSessionOpener';

const MAC: HostDescriptor = {
  id: 'mac',
  label: 'Mac',
  kind: 'multi',
  displayUrl: 'http://192.168.1.57:3000/',
  runtimeKey: 'relay:srv_mac@wss://relay.example/tunnel',
  monitored: true,
};

const createPhone = () => {
  let runtimeKey = 'http://192.168.1.56:3000';
  let complete = true;
  let sessions = new Set<string>();
  const runtimeListeners = new Set<(next: string, previous: string) => void>();
  const storeListeners = new Set<() => void>();
  const calls: string[] = [];
  const desktopSwitches: string[] = [];
  const base: HostSessionOpenerDependencies = {
    getActiveRuntimeKey: () => runtimeKey,
    switchToHost: async (host) => { desktopSwitches.push(host.id); },
    subscribeRuntimeChanged: (listener) => {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    readGlobalSessions: () => ({ complete, hasSession: (sessionId) => sessions.has(sessionId) }),
    subscribeGlobalSessions: (listener) => {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
    selectSession: (sessionId) => { calls.push(`open:${sessionId}`); },
    openDraft: () => { calls.push('draft'); },
    hasUnsentDraft: () => false,
    openInHostWindow: () => true,
  };
  const connect = async (connectionId: string) => {
    calls.push(`connect:${connectionId}`);
    const previous = runtimeKey;
    runtimeKey = MAC.runtimeKey;
    complete = false;
    sessions = new Set();
    for (const listener of runtimeListeners) listener(runtimeKey, previous);
    for (const listener of storeListeners) listener();
  };
  const loadList = (ids: string[]) => {
    sessions = new Set(ids);
    complete = true;
    for (const listener of storeListeners) listener();
  };
  return { base, connect, calls, desktopSwitches, loadList, runtimeKey: () => runtimeKey };
};

describe('mobile host session opener', () => {
  test('connects to the saved connection, then opens the session once its list arrives', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect));
    const problems: HostOpenProblem[] = [];

    const result = await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: (problem) => { problems.push(problem); },
    });

    expect(result).toBe('pending');
    expect(phone.runtimeKey()).toBe(MAC.runtimeKey);
    phone.loadList(['ses_a']);
    expect(phone.calls).toEqual(['connect:mac', 'open:ses_a']);
    expect(phone.desktopSwitches).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('a connect that does not switch reports failed and opens nothing', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, async () => {
      throw new Error('unreachable');
    }));
    const problems: HostOpenProblem[] = [];

    const result = await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'poll' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: (problem) => { problems.push(problem); },
    });

    expect(result).toBe('failed');
    expect(problems).toEqual(['failed']);
    expect(phone.calls).toEqual([]);
  });

  test('the phone has no host windows', () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect));
    expect(opener.openInHostWindow(MAC, 'ses_a')).toBe(false);
  });

  test('a saved connection that does not connect rejects with its outcome', async () => {
    await expect(connectMobileHost('missing', async () => ({ status: 'no-candidate' }))).rejects.toThrow('no-candidate');
    await expect(connectMobileHost('mac', async () => ({ status: 'needs-login', label: 'Mac' }))).rejects.toThrow('needs-login');
    expect(await connectMobileHost('mac', async () => ({ status: 'connected' }))).toBeUndefined();
  });
});
