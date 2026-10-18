import { describe, expect, test } from 'bun:test';

import {
  createHostSessionOpener,
  type HostOpenRequest,
  type HostOpenProblem,
  type HostSessionOpener,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';

import { connectMobileHost, openSessionOnSavedConnection, withMobileConnect } from './mobileHostSessionOpener';

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
    openDraft: (directory) => { calls.push(directory ? `draft:${directory}` : 'draft'); },
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
  let expire: (() => void) | null = null;
  const scheduleSessionsTimeout = (onTimeout: () => void) => {
    expire = onTimeout;
    return () => { expire = null; };
  };
  return {
    base,
    connect,
    calls,
    desktopSwitches,
    loadList,
    scheduleSessionsTimeout,
    expire: () => expire?.(),
    runtimeKey: () => runtimeKey,
  };
};

const noLoad = async () => {};

describe('mobile host session opener', () => {
  test('connects to the saved connection, then opens the session once its list arrives', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect, noLoad));
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

  test('after connecting, the phone loads the new server list itself and opens the session', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect, async () => {
      phone.calls.push('load');
      phone.loadList(['ses_a']);
    }));

    const result = await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: () => {},
    });

    expect(result).toBe('pending');
    expect(phone.calls).toEqual(['connect:mac', 'load', 'open:ses_a']);
  });

  test('a session gone from the loaded list reports missing', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect, async () => {
      phone.loadList(['ses_b']);
    }));
    const problems: HostOpenProblem[] = [];

    await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: (problem) => { problems.push(problem); },
    });

    expect(problems).toEqual(['missing']);
    expect(phone.calls).toEqual(['connect:mac']);
  });

  test('a list that does not arrive in time still opens the session', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener({
      ...withMobileConnect(phone.base, phone.connect, noLoad),
      scheduleSessionsTimeout: phone.scheduleSessionsTimeout,
    });

    await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: () => {},
    });

    expect(phone.calls).toEqual(['connect:mac']);
    phone.expire();
    expect(phone.calls).toEqual(['connect:mac', 'open:ses_a']);
    phone.loadList(['ses_a']);
    expect(phone.calls).toEqual(['connect:mac', 'open:ses_a']);
  });

  test('a list that arrives in time cancels the timeout', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener({
      ...withMobileConnect(phone.base, phone.connect, async () => { phone.loadList(['ses_a']); }),
      scheduleSessionsTimeout: phone.scheduleSessionsTimeout,
    });

    await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' },
      confirmLeavingDraft: async () => true,
      onProblem: () => {},
    });

    phone.expire();
    expect(phone.calls).toEqual(['connect:mac', 'open:ses_a']);
  });

  test('a connect that does not switch reports failed and opens nothing', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, async () => {
      throw new Error('unreachable');
    }, noLoad));
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

  test('a new session in a project of another server connects, loads the list, then opens the draft in that folder', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect, async () => {
      phone.calls.push('load');
      phone.loadList([]);
    }));

    const result = await opener.open({
      host: MAC,
      connection: { state: 'live', since: 1, via: 'stream' },
      target: { kind: 'draft', directory: '/work/api' },
      confirmLeavingDraft: async () => true,
      onProblem: () => {},
    });

    expect(result).toBe('pending');
    expect(phone.calls).toEqual(['connect:mac', 'load', 'draft:/work/api']);
  });

  test('the phone has no host windows', () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileConnect(phone.base, phone.connect, noLoad));
    expect(opener.openInHostWindow(MAC, 'ses_a')).toBe(false);
  });

  test('a saved connection that does not connect rejects with its outcome', async () => {
    await expect(connectMobileHost('missing', async () => ({ status: 'no-candidate' }))).rejects.toThrow('no-candidate');
    await expect(connectMobileHost('mac', async () => ({ status: 'needs-login', label: 'Mac' }))).rejects.toThrow('needs-login');
    expect(await connectMobileHost('mac', async () => ({ status: 'connected' }))).toBeUndefined();
  });
});

describe('opening a pushed session on the server that sent it', () => {
  const PI: MonitoredHost = {
    descriptor: { ...MAC, id: 'pi', label: 'Pi', runtimeKey: 'http://192.168.1.56:3000' },
    connection: { state: 'live', since: 1, via: 'stream' },
    snapshot: {
      status: 'ready',
      sessions: new Map([['ses_pi', { id: 'ses_pi', title: 'Pi work', directory: '/srv/pi', engine: 'opencode', updatedAt: 1, state: 'idle' }]]),
      lastCompleteAt: 1,
      generation: 1,
    },
  };

  const recordingOpener = () => {
    const requests: HostOpenRequest[] = [];
    const opener: HostSessionOpener = {
      open: async (request) => {
        requests.push(request);
        return 'pending';
      },
      openInHostWindow: () => false,
    };
    return { requests, opener };
  };

  test('switches to the saved connection and opens the session in its folder', () => {
    const { requests, opener } = recordingOpener();

    expect(openSessionOnSavedConnection('pi', 'ses_pi', [PI], opener)).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0].host).toBe(PI.descriptor);
    expect(requests[0].connection).toBe(PI.connection);
    expect(requests[0].target).toEqual({ kind: 'session', sessionId: 'ses_pi', directory: '/srv/pi' });
  });

  test('a session the monitor has not listed yet opens without a folder', () => {
    const { requests, opener } = recordingOpener();

    openSessionOnSavedConnection('pi', 'ses_new', [PI], opener);

    expect(requests[0].target).toEqual({ kind: 'session', sessionId: 'ses_new', directory: '' });
  });

  test('a connection that is the active one, or not saved, is left to the caller', () => {
    const { requests, opener } = recordingOpener();

    expect(openSessionOnSavedConnection('mac', 'ses_pi', [PI], opener)).toBe(false);
    expect(requests).toEqual([]);
  });
});
