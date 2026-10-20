import { defineHostValue, hostRegistry, resolveHost } from './host-bindings';

const deferredWork = defineHostValue(() => new Map<string, () => void>());

let runningDeferredWorkOnFocus = false;

const runDeferredWorkOnFocus = (): void => {
  if (runningDeferredWorkOnFocus) return;
  runningDeferredWorkOnFocus = true;
  hostRegistry.subscribe(() => {
    if (hostRegistry.list().length === 0) return;
    const host = hostRegistry.focused();
    const pending = host.run(deferredWork);
    if (pending.size === 0) return;
    const work = [...pending.values()];
    pending.clear();
    for (const run of work) host.run(run);
  });
};

export const runWhenFocused = <T,>(key: string, work: () => T): T | undefined => {
  const host = resolveHost();
  if (host.id === hostRegistry.focused().id) return host.run(work);
  host.run(deferredWork).set(key, work);
  runDeferredWorkOnFocus();
  return undefined;
};
