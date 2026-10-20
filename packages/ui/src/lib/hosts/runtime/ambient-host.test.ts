import { describe, expect, test } from 'bun:test';

import { opencodeClient } from '@/lib/opencode/client';
import { createRelayTunnelClient } from '@/lib/relay/tunnel-client';
import { getAmbientHost, runWithHost } from './ambient-host';
import { createHostRegistry } from './host-registry';
import { createRuntimeTransport } from './runtime-transport';
import type { HostRuntime } from './types';

const registry = createHostRegistry(() => ({
  transport: createRuntimeTransport({
    bootInjection: false,
    fetch: async () => new Response(null, { status: 204 }),
    createTunnel: createRelayTunnelClient,
  }),
  client: opencodeClient,
}));
const host = (id: string) => registry.register({
  descriptor: { id, label: id, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: false },
  endpoint: { kind: 'direct', apiUrl: `https://${id}.example` },
}, async () => null);

const a = host('a');
const b = host('b');

describe('ambient host', () => {
  test('is set for the synchronous call, nested calls restore the outer host, and a throw restores it too', () => {
    expect(getAmbientHost()).toBeNull();
    const seen = runWithHost(a, () => {
      const outer = getAmbientHost();
      const inner = runWithHost(b, () => getAmbientHost());
      return [outer, inner, getAmbientHost()];
    });
    expect(seen).toEqual([a, b, a]);
    expect(() => runWithHost(a, () => { throw new Error('boom'); })).toThrow('boom');
    expect(getAmbientHost()).toBeNull();
  });

  test('does not reach code after an await', async () => {
    const seen: Array<HostRuntime | null> = [];
    const pending = runWithHost(a, async () => {
      seen.push(getAmbientHost());
      await Promise.resolve();
      seen.push(getAmbientHost());
    });
    expect(getAmbientHost()).toBeNull();
    await pending;
    expect(seen).toEqual([a, null]);
  });

  test('does not reach a queued microtask or a promise callback', async () => {
    const seen: Array<HostRuntime | null> = [];
    let settled = Promise.resolve();
    runWithHost(a, () => {
      queueMicrotask(() => { seen.push(getAmbientHost()); });
      settled = Promise.resolve().then(() => { seen.push(getAmbientHost()); });
    });
    await settled;
    expect(seen).toEqual([null, null]);
  });
});
