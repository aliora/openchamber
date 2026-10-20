import { defineHostValue, hostStoresLive, resolveHost } from '@/lib/hosts/runtime/host-bindings';
import { currentHostKey } from '@/lib/hosts/runtime/host-key';
import { getPinnedSessionKey, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { forgetLegacyPins, getLegacyPins, setPendingPin, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { setSessionPinned } from './session-actions';

type PinTarget = { directory: string; sessionId: string };

// Clicks on one session run in order, so the last one wins on the server too.
const pinQueuesOf = defineHostValue(() => new Map<string, { tail: Promise<void>; count: number }>());

/**
 * Pin or unpin a session. The row flips at once; the pin is stored in the
 * session's metadata on the server, which tells every other client. Rejects
 * when the server could not store it, and the row flips back.
 */
export function toggleSessionPin(target: PinTarget): Promise<void> {
  const host = resolveHost();
  const key = getPinnedSessionKey(currentHostKey(), target.directory, target.sessionId);
  if (!key) return Promise.resolve();
  const pinned = !useSessionPinnedStore.getState().ids.has(key);
  setPendingPin(key, pinned);

  const pinQueues = pinQueuesOf();
  const queue = pinQueues.get(key) ?? { tail: Promise.resolve(), count: 0 };
  queue.count += 1;
  pinQueues.set(key, queue);
  const run = queue.tail.then(async () => {
    try {
      await host.run(() => setSessionPinned(target.sessionId, target.directory, pinned));
      // An old local pin must not bring back a session the user just unpinned.
      if (!pinned) host.run(() => forgetLegacyPins([key]));
    } finally {
      queue.count -= 1;
      if (queue.count === 0) {
        pinQueues.delete(key);
        host.run(() => setPendingPin(key, null));
      }
    }
  });
  queue.tail = run.catch(() => undefined);
  return run;
}

const migratingRuntimes = new Set<string>();

/**
 * Pins used to live on each device only. Once the server's session list is
 * complete, this device's old pins for that server move into session
 * metadata; a pin whose session is gone is dropped, and one that fails to
 * write stays local and is tried again on the next complete load.
 */
async function migrateLegacyPins(): Promise<void> {
  const host = resolveHost();
  const state = useGlobalSessionsStore.getState();
  if (!state.hasLoaded || state.status !== 'ready') return;
  const runtimeKey = currentHostKey();
  const pins = getLegacyPins(runtimeKey);
  if (pins.length === 0 || migratingRuntimes.has(runtimeKey)) return;
  migratingRuntimes.add(runtimeKey);
  try {
    for (const pin of pins) {
      if (!hostStoresLive(host)) return;
      const session = host.run(() => useGlobalSessionsStore.getState().entityById.get(pin.sessionId));
      if (!session || isSessionPinnedInMetadata(session)) {
        host.run(() => forgetLegacyPins([pin.key]));
        continue;
      }
      try {
        if (await host.run(() => setSessionPinned(pin.sessionId, session.directory ?? pin.directory, true))) host.run(() => forgetLegacyPins([pin.key]));
      } catch (error) {
        console.warn('[session-pins] could not move a local pin to the server', error);
      }
    }
  } finally {
    migratingRuntimes.delete(runtimeKey);
  }
}

useGlobalSessionsStore.subscribeEveryHost((state, previous) => {
  if (state.hasLoaded && state.status === 'ready' && (previous.status !== 'ready' || !previous.hasLoaded)) {
    void migrateLegacyPins();
  }
});
void migrateLegacyPins();
