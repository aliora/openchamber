import { hasCompatibleManagedDesktopOpenCode } from '@/lib/desktop';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';
import { fetchCodeCliCompatibility, type CodeCliCompatibility } from '@/lib/codecli/compatibility';

/** `null` when the desktop shell already knows its managed Code CLI is compatible. */
export type CompatibilityCheck = Promise<CodeCliCompatibility | null>;

class StaleCompatibilityCheck extends Error {}

export const runCompatibilityCheck = async (): CompatibilityCheck => {
  const runtimeKey = getRuntimeKey();
  const apiBaseUrl = getRuntimeApiBaseUrl();
  if (await hasCompatibleManagedDesktopOpenCode()) return null;
  if (getRuntimeKey() !== runtimeKey || getRuntimeApiBaseUrl() !== apiBaseUrl) throw new StaleCompatibilityCheck();
  return fetchCodeCliCompatibility();
};

let prefetchedCheck: { runtimeKey: string; check: CompatibilityCheck } | null = null;

export const prefetchCodeCliCompatibility = (): void => {
  const check = runCompatibilityCheck();
  check.catch(() => undefined);
  prefetchedCheck = { runtimeKey: getRuntimeKey(), check };
};
export const prefetchOpenCodeCompatibility = prefetchCodeCliCompatibility;

export const takeCompatibilityCheck = (): CompatibilityCheck => {
  const prefetched = prefetchedCheck;
  prefetchedCheck = null;
  if (prefetched && prefetched.runtimeKey === getRuntimeKey()) {
    return prefetched.check.catch(runCompatibilityCheck);
  }
  return runCompatibilityCheck();
};
