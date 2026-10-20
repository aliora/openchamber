import React from 'react';

import { hostRegistry } from '@/lib/hosts/runtime/host-bindings';
import { HostScopeContext } from '@/lib/hosts/runtime/HostScope';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { useFocusedHostId } from '@/lib/hosts/runtime/useFocusedHostId';

export const useScopedHostRuntime = (): HostRuntime => {
  const scopedId = React.useContext(HostScopeContext);
  const focusedId = useFocusedHostId();
  const scoped = scopedId === null ? undefined : hostRegistry.get(scopedId);
  return scoped ?? hostRegistry.get(focusedId) ?? hostRegistry.focused();
};
