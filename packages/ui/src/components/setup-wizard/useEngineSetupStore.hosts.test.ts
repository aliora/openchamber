import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { PortableValue } from '@/lib/settings/portable-settings';
import { hostRegistry, resolveHost } from '@/lib/hosts/runtime/app-host';
import { createHostParts } from '@/lib/hosts/runtime/host-parts';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { useEngineSetupStore } from './useEngineSetupStore';

const registerHost = (id: string): HostRuntime => hostRegistry.register({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `https://${id}.example/`, runtimeKey: id, monitored: false },
  endpoint: { kind: 'direct', apiUrl: `https://${id}.example` },
}, async () => null, createHostParts(id, { apiBaseUrl: `https://${id}.example` }, null, undefined));

const json = (body: PortableValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('engine actions on a picked host', () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const requests: string[] = [];
  let focused: HostRuntime;
  let picked: HostRuntime;

  beforeAll(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/actions/update')) return json({ error: 'Not found' }, 404);
      if (url.endsWith('/api/engines')) return json({ data: [] });
      if (url.endsWith('/api/engines/readiness')) return json({ data: [] });
      return json({ status: 'started' }, 202);
    }, { preconnect: async () => {} });
  });

  afterAll(() => {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  afterEach(() => {
    hostRegistry.focus(focused.id);
    hostRegistry.unregister(picked.id);
    requests.length = 0;
  });

  test('install, update and the reread that follows reach the picked host only', async () => {
    focused = resolveHost();
    picked = registerHost('pi');

    await useEngineSetupStore.forHost(picked.id).getState().runAction('codex', 'update');

    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.includes('https://pi.example/'))).toBe(true);
    expect(requests).toContain('POST https://pi.example/api/engines/codex/actions/update');
    expect(requests).toContain('POST https://pi.example/api/engines/codex/install');
    expect(useEngineSetupStore.forHost(picked.id).getState().loaded).toBe(true);
    expect(useEngineSetupStore.forHost(focused.id).getState().loaded).toBe(false);
  });

  test('sign out on the picked host leaves the focused host alone', async () => {
    focused = resolveHost();
    picked = registerHost('pi');

    await useEngineSetupStore.forHost(picked.id).getState().logout('claude');

    expect(requests).toContain('POST https://pi.example/api/engines/claude/auth/logout');
    expect(requests.every((request) => request.includes('https://pi.example/'))).toBe(true);
  });
});
