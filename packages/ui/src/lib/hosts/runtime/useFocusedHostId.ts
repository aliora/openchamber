import React from 'react';

import { hostRegistry } from './host-bindings';
import type { HostId } from './types';

const subscribeHosts = (notify: () => void): (() => void) => hostRegistry.subscribe(notify);

const readFocusedHostId = (): HostId => hostRegistry.focused().id;

export const useFocusedHostId = (): HostId => React.useSyncExternalStore(subscribeHosts, readFocusedHostId, readFocusedHostId);
