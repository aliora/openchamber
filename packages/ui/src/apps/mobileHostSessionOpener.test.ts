import { describe, expect, test } from 'bun:test';

import {
  createHostSessionOpener,
  type HostOpenRequest,
  type HostOpenProblem,
  type HostSessionOpener,
  type HostSessionOpenerDependencies,
} from '@/lib/hosts/open-host-session';
import type { HostDescriptor, MonitoredHost } from '@/lib/hosts/types';

import { connectMobileHost, openSessionOnSavedConnection, withMobileFocus } from './mobileHostSessionOpener';

const MAC: HostDescriptor = {
  id: 'mac',
  label: 'Mac',
  kind: 'multi',
  displayUrl: 'http://192.168.1.57:3000/',
  runtimeKey: 'relay:srv_mac@wss://relay.example/tunnel',
  monitored: true,
};

const createPhone = (registered: ReadonlySet<string> = new Set()) => {
  let runtimeKey = 'http://192.168.1.56:3000';
  let sessions = new Set<string>(['ses_a']);
  const calls: string[] = [];
  const base: HostSessionOpenerDependencies = {
    getActiveRuntimeKey: () => runtimeKey,
    focusHost: async (host) => { calls.push(`desktop:${host.id}`); },
    readGlobalSessions: () => ({ complete: true, hasSession: (sessionId) => sessions.has(sessionId) }),
    selectSession: (sessionId) => { calls.push(`open:${sessionId}`); },
    openDraft: (directory) => { calls.push(directory ? `draft:${directory}` : 'draft'); },
    openInHostWindow: () => true,
  };
  const focusRegistered = (key: string): boolean => {
    if (!registered.has(key)) return false;
    calls.push(`focus:${key}`);
    runtimeKey = key;
    return true;
  };
  const connect = async (connectionId: string) => {
    calls.push(`connect:${connectionId}`);
    runtimeKey = MAC.runtimeKey;
  };
  return { base, calls, focusRegistered, connect, setSessions: (ids: string[]) => { sessions = new Set(ids); } };
};

describe('mobile host session opener', () => {
  test('a device that runs beside the others is focused without connecting, and its session opens', async () => {
    const phone = createPhone(new Set([MAC.runtimeKey]));
    const opener = createHostSessionOpener(withMobileFocus(phone.base, phone.focusRegistered, phone.connect));

    const result = await opener.open({ host: MAC, target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' }, onProblem: () => {} });

    expect(result).toBe('opened');
    expect(phone.calls).toEqual([`focus:${MAC.runtimeKey}`, 'open:ses_a']);
  });

  test('a device not running yet is connected first, then the session opens', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileFocus(phone.base, phone.focusRegistered, phone.connect));

    await opener.open({ host: MAC, target: { kind: 'draft', directory: '/work/api' }, onProblem: () => {} });

    expect(phone.calls).toEqual(['connect:mac', 'draft:/work/api']);
  });

  test('a session gone from the device\'s list reports missing', async () => {
    const phone = createPhone(new Set([MAC.runtimeKey]));
    phone.setSessions(['ses_b']);
    const opener = createHostSessionOpener(withMobileFocus(phone.base, phone.focusRegistered, phone.connect));
    const problems: HostOpenProblem[] = [];

    await opener.open({ host: MAC, target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' }, onProblem: (problem) => { problems.push(problem); } });

    expect(problems).toEqual(['missing']);
  });

  test('a connect that does not switch reports failed and opens nothing', async () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileFocus(phone.base, phone.focusRegistered, async () => {
      throw new Error('unreachable');
    }));
    const problems: HostOpenProblem[] = [];

    const result = await opener.open({ host: MAC, target: { kind: 'session', sessionId: 'ses_a', directory: '/work/a' }, onProblem: (problem) => { problems.push(problem); } });

    expect(result).toBe('failed');
    expect(problems).toEqual(['failed']);
    expect(phone.calls).toEqual([]);
  });

  test('the phone has no host windows', () => {
    const phone = createPhone();
    const opener = createHostSessionOpener(withMobileFocus(phone.base, phone.focusRegistered, phone.connect));
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
      sessions: new Map([['ses_pi', { id: 'ses_pi', title: 'Pi work', directory: '/srv/pi', updatedAt: 1, state: 'idle', work: null }]]),
      lastCompleteAt: 1,
    },
  };

  const recordingOpener = () => {
    const requests: HostOpenRequest[] = [];
    const opener: HostSessionOpener = {
      open: async (request) => {
        requests.push(request);
        return 'opened';
      },
      openInHostWindow: () => false,
      supersede: () => undefined,
    };
    return { requests, opener };
  };

  test('switches to the saved connection and opens the session in its folder', () => {
    const { requests, opener } = recordingOpener();

    expect(openSessionOnSavedConnection('pi', 'ses_pi', [PI], opener)).toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0].host).toBe(PI.descriptor);
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
