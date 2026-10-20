// Runtime keys that mean "no instance connected": the uninitialized default
// (`normalizeRuntimeUrlKey` of an empty/unparseable base URL) and the mobile
// disconnect state (`MobileApp` switches to it when the connection drops).
// Per-instance client state (e.g. the scoped theme entry) must not be read
// from or written under them.
export const MOBILE_DISCONNECTED_RUNTIME_KEY = 'mobile-disconnected';
const UNINITIALIZED_RUNTIME_KEY = 'url:default';

export const isTransientRuntimeKey = (runtimeKey: string): boolean =>
  runtimeKey === '' || runtimeKey === UNINITIALIZED_RUNTIME_KEY || runtimeKey === MOBILE_DISCONNECTED_RUNTIME_KEY;
