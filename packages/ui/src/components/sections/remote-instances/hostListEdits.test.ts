import { afterEach, describe, expect, test } from 'bun:test';

import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { LOCAL_HOST_ID, withLocalDesktopHost } from '@/lib/desktopCurrentHost';
import type { DesktopHost } from '@/lib/desktopHosts';
import { addHostTo, removeHostFrom, renameHostIn, type HostListState } from './hostListEdits';

const LOCAL_ORIGIN = 'http://127.0.0.1:4100';
const english = new Map([['hosts.local.thisMac', 'This Mac'], ['hosts.local.thisComputer', 'This computer']]);
const t = (key: string) => english.get(key) ?? key;
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const pi: DesktopHost = { id: 'pi', label: 'Pi5', url: 'http://192.168.1.56:3000', apiUrl: 'http://192.168.1.56:3000', clientToken: 'oc_client_pi' };
const msi: DesktopHost = { id: 'msi', label: 'MSI', url: 'http://192.168.1.54:3000', apiUrl: 'http://192.168.1.54:3000' };

const listed = (state: HostListState): string[] => withLocalDesktopHost(state.hosts, LOCAL_ORIGIN, state.localHostLabel)
  .map((host) => formatHostLabel({ id: host.id, label: host.label, displayUrl: host.url }, t));

describe('the Hosts list edits', () => {
  afterEach(() => {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
  });

  test('add, rename and remove round-trip through what the list shows, this machine first', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', platform: 'MacIntel' } });
    let state: HostListState = { hosts: [msi], defaultHostId: 'msi', localHostLabel: null };
    expect(listed(state)).toEqual(['This Mac', 'MSI']);

    state = addHostTo(state, pi);
    expect(listed(state)).toEqual(['This Mac', 'Pi5', 'MSI']);
    expect(state.hosts[0].clientToken).toBe('oc_client_pi');

    state = renameHostIn(state, 'pi', '  Raspberry  ');
    state = renameHostIn(state, LOCAL_HOST_ID, 'Studio');
    expect(listed(state)).toEqual(['Studio', 'Raspberry', 'MSI']);
    expect(state.localHostLabel).toBe('Studio');

    state = renameHostIn(state, 'pi', ' ');
    state = renameHostIn(state, LOCAL_HOST_ID, '');
    expect(listed(state)).toEqual(['This Mac', 'http://192.168.1.56:3000/', 'MSI']);
    expect(state.localHostLabel).toBeNull();

    state = removeHostFrom(state, 'msi');
    expect(listed(state)).toEqual(['This Mac', 'http://192.168.1.56:3000/']);
    expect(state.defaultHostId).toBe(LOCAL_HOST_ID);
  });

  test('this machine is "This computer" away from a Mac, and removing another host keeps the last focused one', () => {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)', platform: 'Win32' } });
    const state = removeHostFrom({ hosts: [pi, msi], defaultHostId: 'pi', localHostLabel: null }, 'msi');
    expect(listed(state)).toEqual(['This computer', 'Pi5']);
    expect(state.defaultHostId).toBe('pi');
  });
});
