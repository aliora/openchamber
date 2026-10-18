import { describe, expect, test } from 'bun:test';

import type { HostFetchOptions, HostFetchResult } from '@/lib/hosts/host-transport';
import { createProfileFanOut, type ProfileFanOutTarget } from './profile-fan-out';

type SentRequest = { path: string; options: HostFetchOptions };

const fakeTimers = () => {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; ms: number }>();
  return {
    setTimer(callback: () => void, ms: number) {
      nextId += 1;
      const id = nextId;
      timers.set(id, { callback, ms });
      return () => {
        timers.delete(id);
      };
    },
    pending: () => [...timers.values()],
    fire(ms: number) {
      for (const [id, timer] of [...timers]) {
        if (timer.ms !== ms) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
};

const target = (result: () => Promise<HostFetchResult>) => {
  const sent: SentRequest[] = [];
  const transport: ProfileFanOutTarget = {
    fetch: (path, options) => {
      sent.push({ path, options });
      return result();
    },
  };
  return { transport, sent };
};

const ok = (): Promise<HostFetchResult> => Promise.resolve({ ok: true, response: new Response('{}') });

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const setup = (targets: ProfileFanOutTarget[]) => {
  const timers = fakeTimers();
  const fanOut = createProfileFanOut({
    getTargets: () => targets,
    getSurface: () => 'desktop',
    setTimer: timers.setTimer,
    debounceMs: 1_000,
    requestTimeoutMs: 5_000,
  });
  return { fanOut, timers };
};

describe('profile fan-out', () => {
  test('batches changes inside the debounce window into one PUT per watched host, stamps included', async () => {
    const studio = target(ok);
    const laptop = target(ok);
    const { fanOut, timers } = setup([studio.transport, laptop.transport]);

    fanOut.queue({ fontSize: 16 }, { fontSize: 10 });
    fanOut.queue({ fontSize: 18, uiFont: 'inter' }, { fontSize: 20, uiFont: 21 });
    expect(timers.pending()).toHaveLength(1);
    expect(studio.sent).toHaveLength(0);

    timers.fire(1_000);
    await settle();

    for (const host of [studio, laptop]) {
      expect(host.sent).toHaveLength(1);
      expect(host.sent[0].path).toBe('/api/config/settings?surface=desktop');
      expect(host.sent[0].options.method).toBe('PUT');
      expect(JSON.parse(host.sent[0].options.body ?? '')).toEqual({
        fontSize: 18,
        uiFont: 'inter',
        _profileUpdatedAt: { fontSize: 20, uiFont: 21 },
      });
    }
  });

  test('a host that fails does not stop the others and nothing is retried', async () => {
    const down = target(() => Promise.resolve({ ok: false, reason: 'unreachable' }));
    const broken = target(() => Promise.reject(new Error('boom')));
    const up = target(ok);
    const { fanOut } = setup([down.transport, broken.transport, up.transport]);

    fanOut.queue({ fontSize: 18 }, { fontSize: 1 });
    await fanOut.flush();
    await fanOut.flush();

    expect(down.sent).toHaveLength(1);
    expect(broken.sent).toHaveLength(1);
    expect(up.sent).toHaveLength(1);
  });

  test('nothing is sent without watched hosts or without changes', async () => {
    const { fanOut, timers } = setup([]);
    fanOut.queue({}, {});
    expect(timers.pending()).toHaveLength(0);
    fanOut.queue({ fontSize: 18 }, { fontSize: 1 });
    await fanOut.flush();
    expect(timers.pending()).toHaveLength(0);
  });

  test('cancel drops what is queued', async () => {
    const host = target(ok);
    const { fanOut, timers } = setup([host.transport]);
    fanOut.queue({ fontSize: 18 }, { fontSize: 1 });
    fanOut.cancel();
    expect(timers.pending()).toHaveLength(0);
    await fanOut.flush();
    expect(host.sent).toHaveLength(0);
  });
});
