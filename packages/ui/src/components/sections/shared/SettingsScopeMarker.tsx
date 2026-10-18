import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { useI18n } from '@/lib/i18n';
import { getSettingsItemScope } from '@/lib/settings/scope-markers';
import type { SettingsScope } from '@/lib/settings/registry';
import { SettingsPageScopeContext } from './settingsPageScope';

const SCOPE_ICONS: Record<SettingsScope, IconName> = {
  profile: 'global',
  instance: 'server',
  device: 'computer',
};

const useScopeLabel = (scope: SettingsScope): string | null => {
  const { t } = useI18n();
  const watchesOtherHosts = useHostsStore((state) => state.availability === 'ready' && state.hosts.length > 0);
  const hostLabel = useHostsStore((state) => state.activeHost?.label ?? null);
  if (!watchesOtherHosts) return null;
  if (scope === 'profile') return t('settings.scope.allServers');
  if (scope === 'device') return t('settings.scope.thisDeviceOnly');
  return hostLabel ? t('settings.scope.hostOnly', { host: hostLabel }) : t('settings.scope.thisServerOnly');
};

export const SettingsScopeBadge: React.FC<{ scope: SettingsScope }> = ({ scope }) => {
  const label = useScopeLabel(scope);
  if (!label) return null;
  return (
    <span data-settings-scope={scope} className="inline-flex min-w-0 max-w-[14rem] items-center gap-1 typography-micro text-muted-foreground">
      <Icon name={SCOPE_ICONS[scope]} className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
};

export const SettingsPageScopeBadge: React.FC = () => {
  const scope = React.useContext(SettingsPageScopeContext);
  return scope ? <SettingsScopeBadge scope={scope} /> : null;
};

export const SettingsItemScopeMarker: React.FC<{ settingsItem?: string }> = ({ settingsItem }) => {
  const pageScope = React.useContext(SettingsPageScopeContext);
  const scope = settingsItem ? getSettingsItemScope(settingsItem) : null;
  if (!scope || scope === pageScope) return null;
  return <SettingsScopeBadge scope={scope} />;
};
