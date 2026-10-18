import React from 'react';
import type { SettingsScope } from '@/lib/settings/registry';

export const SettingsPageScopeContext = React.createContext<SettingsScope | null>(null);
