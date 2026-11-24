import { beforeEach, describe, expect, test } from 'bun:test';

import {
  formatHostLabel,
  migrateHostAppearanceToServerId,
  saveSharedHostLabel,
} from './useHostSessionActions';
import { LOCAL_HOST_DEFAULT_LABEL, LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import { desktopHostsGet } from '@/lib/desktopHosts';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useUIStore } from '@/stores/useUIStore';

const t: Parameters<typeof formatHostLabel>[1] = (key) => key;

describe('shared host labels, icons, and offline serverId resilience', () => {
  beforeEach(() => {
    useHostsStore.getState().reset();
    useUIStore.setState({
      hostLabels: {},
      hostLogos: {},
      hostAppearanceStamps: {},
    });
  });

  test('resolves shared hostLabel by serverId across devices regardless of local URL or fallback label', () => {
    useHostsStore.getState().setServerId('host-lan', 'srv_msi_01');
    useUIStore.getState().setHostLabel('server:srv_msi_01', 'MSI Workstation');

    expect(
      formatHostLabel(
        { id: 'host-lan', label: 'http://192.168.1.108:3000', displayUrl: 'http://192.168.1.108:3000' },
        t,
      ),
    ).toBe('MSI Workstation');

    expect(
      formatHostLabel(
        { id: 'host-tailscale', label: '100.64.0.9:3000', displayUrl: 'http://100.64.0.9:3000', serverId: 'srv_msi_01' },
        t,
      ),
    ).toBe('MSI Workstation');
  });

  test('saveSharedHostLabel stores under server:<serverId> and clears stale label:<name> keys', () => {
    useUIStore.getState().setHostLabel('label:msi', 'Old MSI');
    useHostsStore.getState().setServerId('host-1', 'srv_msi_01');

    saveSharedHostLabel({ id: 'host-1', label: 'MSI' }, 'MSI Gaming');

    expect(useUIStore.getState().hostLabels).toEqual({
      'server:srv_msi_01': 'MSI Gaming',
    });
  });

  test('migrates existing custom local host label and label-keyed logo to server:<serverId> without overwriting existing shared values', () => {
    useUIStore.setState({
      hostLabels: {},
      hostLogos: { 'label:msi': 'icon:computer' },
    });

    migrateHostAppearanceToServerId(
      { id: 'host-1', label: 'MSI', displayUrl: 'http://192.168.1.108:3000' },
      'srv_msi_01',
    );

    expect(useUIStore.getState().hostLabels).toEqual({
      'server:srv_msi_01': 'MSI',
    });
    expect(useUIStore.getState().hostLogos['server:srv_msi_01']).toBe('icon:computer');
    expect(useUIStore.getState().hostAppearanceStamps['logos:server:srv_msi_01']).toEqual({ at: 1 });

    migrateHostAppearanceToServerId(
      { id: 'host-1', label: 'Different Local Name', displayUrl: 'http://192.168.1.108:3000' },
      'srv_msi_01',
    );
    expect(useUIStore.getState().hostLabels['server:srv_msi_01']).toBe('MSI');
  });

  test('does not migrate default placeholder or URL-only labels as custom shared labels', () => {
    migrateHostAppearanceToServerId(
      { id: LOCAL_HOST_ID, label: LOCAL_HOST_DEFAULT_LABEL, displayUrl: 'http://127.0.0.1:3000' },
      'srv_local_01',
    );
    migrateHostAppearanceToServerId(
      { id: 'host-2', label: 'http://192.168.1.50:3000', displayUrl: 'http://192.168.1.50:3000' },
      'srv_remote_02',
    );

    expect(useUIStore.getState().hostLabels).toEqual({});
  });

  test('migrates a logo and label left under the localized local-host name, not only the raw label', () => {
    useUIStore.setState({
      hostLabels: { 'label:this mac': 'Studio' },
      hostLogos: { 'label:this mac': 'dot:blue' },
    });

    migrateHostAppearanceToServerId(
      { id: LOCAL_HOST_ID, label: LOCAL_HOST_DEFAULT_LABEL, displayUrl: 'http://127.0.0.1:3000' },
      'srv_local_01',
      ['This Mac'],
    );

    expect(useUIStore.getState().hostLogos['server:srv_local_01']).toBe('dot:blue');
    expect(useUIStore.getState().hostLabels['server:srv_local_01']).toBe('Studio');
  });

  test('a cleared shared name is not seeded back from the device label', () => {
    useUIStore.getState().setHostLabel('server:srv_a', 'Pi5 Ana');
    useUIStore.getState().setHostLabel('server:srv_a', '');

    migrateHostAppearanceToServerId({ id: 'host-a', label: 'Pi5', displayUrl: 'http://192.168.1.149:3000' }, 'srv_a');

    expect(useUIStore.getState().hostLabels).toEqual({});
    expect(useUIStore.getState().hostAppearanceStamps['labels:server:srv_a']?.removed).toBe(true);
  });

  test('two hosts sharing one legacy name both receive its icon', () => {
    useUIStore.setState({ hostLogos: { 'label:pi': 'dot:green' } });

    migrateHostAppearanceToServerId({ id: 'host-1', label: 'Pi', displayUrl: 'http://10.0.0.1' }, 'srv_1');
    migrateHostAppearanceToServerId({ id: 'host-2', label: 'Pi', displayUrl: 'http://10.0.0.2' }, 'srv_2');

    expect(useUIStore.getState().hostLogos['server:srv_1']).toBe('dot:green');
    expect(useUIStore.getState().hostLogos['server:srv_2']).toBe('dot:green');
  });

  test('a seeded name never outranks a name another device set later', () => {
    migrateHostAppearanceToServerId({ id: 'host-a', label: 'Pi5', displayUrl: 'http://10.0.0.1' }, 'srv_a');

    expect(useUIStore.getState().hostAppearanceStamps['labels:server:srv_a']).toEqual({ at: 1 });
  });

  test('a host whose own device name is only the same server as a default-named local host is not seeded', () => {
    migrateHostAppearanceToServerId({ id: 'host-mac', label: 'Mac', displayUrl: 'http://192.168.1.10:3000' }, 'srv_mac', [], false);

    expect(useUIStore.getState().hostLabels).toEqual({});
  });

  test('an address is never written to the shared store as a name', () => {
    saveSharedHostLabel({ id: 'host-1', label: 'Pi', displayUrl: 'http://192.168.1.149:3000', serverId: 'srv_1' }, 'http://192.168.1.149:3000');
    saveSharedHostLabel({ id: 'host-1', label: 'Pi', serverId: 'srv_1' }, 'relay://srv_1');

    expect(useUIStore.getState().hostLabels).toEqual({});
  });

  test('preserves serverId on parsed DesktopHost for offline direct hosts without exposing clientToken to shared state', async () => {
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
        __OPENCHAMBER_DESKTOP__: {
          invoke: async () => ({
            hosts: [
              {
                id: 'host-direct',
                label: 'Pi5',
                url: 'http://192.168.1.149:3000',
                clientToken: 'oc_tok_secret_123',
                serverId: 'srv_pi5_99',
              },
            ],
            defaultHostId: 'local',
          }),
        },
      },
    });
    try {
      const cfg = await desktopHostsGet();
      const parsed = cfg.hosts[0];
      if (!parsed) throw new Error('host was not parsed');
      expect(parsed.serverId).toBe('srv_pi5_99');
      expect(
        formatHostLabel(
          { id: parsed.id, label: parsed.label, displayUrl: parsed.url, serverId: parsed.serverId },
          t,
        ),
      ).toBe('Pi5');
    } finally {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        writable: true,
        value: previousWindow,
      });
    }
  });
});
