import React from 'react';

import type { HostId } from './types';

export const HostScopeContext = React.createContext<HostId | null>(null);
