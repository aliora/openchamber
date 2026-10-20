import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { hostsMonitoring } from './hosts-monitoring';
import { useHostsStore } from './hosts-store';
import { useMonitoredHosts } from './useMonitoredHosts';

const unused = (): never => { throw new Error('the hook reads only the hosts API'); };
// A fixture without `hosts`, which reads as an unsupported runtime.
const apis: RuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  get terminal() { return unused(); },
  get git() { return unused(); },
  get sourceControl() { return unused(); },
  get files() { return unused(); },
  get settings() { return unused(); },
  get permissions() { return unused(); },
  get notifications() { return unused(); },
};

const Probe = () => {
  const { availability, hosts } = useMonitoredHosts();
  return (
    <ul data-availability={availability}>
      {hosts.map(({ descriptor, connection, snapshot }) => (
        <li key={descriptor.id}>{`${descriptor.label}:${connection.state}:${snapshot.status}:${[...snapshot.sessions.values()].map((row) => row.state).join(',')}`}</li>
      ))}
    </ul>
  );
};

describe('useMonitoredHosts', () => {
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    const dom = new Window({ url: 'http://localhost' });
    const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
    for (const [name, value] of Object.entries(globals)) {
      originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
      Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    hostsMonitoring.stop();
  });

  afterEach(() => {
    hostsMonitoring.stop();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
  });

  test('renders each monitored host and follows the store; no hosts API reads as unsupported', async () => {
    const { createRoot } = await import('react-dom/client');
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<RuntimeAPIContext.Provider value={apis}><Probe /></RuntimeAPIContext.Provider>));
    expect(container.innerHTML).toBe('<ul data-availability="unsupported"></ul>');

    await act(async () => {
      useHostsStore.getState().replaceHosts([{
        descriptor: { id: 'studio', label: 'Studio', kind: 'relay', displayUrl: 'relay://srv', runtimeKey: 'host:studio', monitored: true },
        connection: { state: 'live', since: 1, via: 'stream' },
        snapshot: {
          status: 'ready',
          sessions: new Map([['s1', { id: 's1', title: 'Fix', directory: '/w', updatedAt: 1, state: 'waiting-permission', work: null }]]),
          lastCompleteAt: 2,
        },
      }]);
    });
    expect(container.innerHTML).toBe('<ul data-availability="unsupported"><li>Studio:live:ready:waiting-permission</li></ul>');
    await act(async () => root.unmount());
  });
});
