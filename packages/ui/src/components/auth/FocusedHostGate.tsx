import React from 'react';
import type { StoreApi } from 'zustand';

import { Icon } from '@/components/icon/Icon';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { Button } from '@/components/ui/button';
import { hostsMonitoring } from '@/lib/hosts/hosts-monitoring';
import { useHostsStore } from '@/lib/hosts/hosts-store';
import { hostRegistry } from '@/lib/hosts/runtime/host-bindings';
import { windowHostKey } from '@/lib/hosts/runtime/window-host';
import { isMultiHostRuntimeEnabled } from '@/lib/hosts/runtime/multi-host-flag';
import type { HostRuntime, HostStatus } from '@/lib/hosts/runtime/types';
import type { HostConnection } from '@/lib/hosts/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { authSessionStoreOf, type AuthSessionState } from '@/lib/runtime-auth-expiry';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { SessionAuthGate } from './SessionAuthGate';

const readConnection = (status: HostStatus) => status.connection;

const readAuthSessionState = (session: { state: AuthSessionState }) => session.state;

const readHasLoaded = (sessions: { hasLoaded: boolean }) => sessions.hasLoaded;

const ignoreChanges = () => () => {};

const useHostSelection = <S, V>(store: StoreApi<S> | undefined, select: (state: S) => V, fallback: V): V =>
  React.useSyncExternalStore(store?.subscribe ?? ignoreChanges, () => (store ? select(store.getState()) : fallback));

type OfflineCopy = { titleKey: I18nKey; descriptionKey: I18nKey; busy: boolean };

const offlineCopyOf = (connection: HostConnection): OfflineCopy | null => {
  switch (connection.state) {
    case 'connecting':
      return { titleKey: 'hosts.offline.connectingTitle', descriptionKey: 'hosts.offline.description', busy: true };
    case 'backoff':
      return connection.failure === 'unreachable'
        ? { titleKey: 'hosts.offline.offlineTitle', descriptionKey: 'hosts.offline.description', busy: false }
        : { titleKey: 'hosts.offline.unavailableTitle', descriptionKey: 'hosts.offline.description', busy: false };
    case 'relay-limit':
      return { titleKey: 'hosts.offline.relayLimitTitle', descriptionKey: 'hosts.offline.relayLimitDescription', busy: false };
    default:
      return null;
  }
};

const useHostLabel = (host: HostRuntime): string => {
  const { t } = useI18n();
  const saved = useHostsStore((state) => state.activeHost);
  return formatHostLabel(saved?.runtimeKey === host.id ? saved : host.descriptor, t);
};

const HostOfflinePanel: React.FC<{ host: HostRuntime; copy: OfflineCopy }> = ({ host, copy }) => {
  const { t } = useI18n();
  const label = useHostLabel(host);
  return (
    <div role="status" data-host-offline={host.id} className="flex h-full items-center justify-center bg-background px-6 text-center">
      <div className="flex max-w-sm flex-col items-center gap-3">
        <Icon name={copy.busy ? 'loader-4' : 'cloud-off'} className={copy.busy ? 'size-6 animate-spin text-muted-foreground' : 'size-6 text-muted-foreground'} />
        <h2 dir="auto" className="typography-ui-header font-semibold text-foreground">{t(copy.titleKey, { host: label })}</h2>
        <p className="typography-meta text-muted-foreground">{t(copy.descriptionKey)}</p>
        {copy.busy ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => hostsMonitoring.refresh()}>
            {t('hosts.offline.retry')}
          </Button>
        )}
      </div>
    </div>
  );
};

const HostOfflineIndicator: React.FC<{ host: HostRuntime; copy: OfflineCopy }> = ({ host, copy }) => {
  const { t } = useI18n();
  const label = useHostLabel(host);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-4">
      <div role="status" data-host-offline-indicator={host.id} className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-[var(--surface-elevated)] px-3 py-1 shadow-sm typography-meta text-muted-foreground">
        <Icon name={copy.busy ? 'loader-4' : 'cloud-off'} className={copy.busy ? 'size-3.5 shrink-0 animate-spin' : 'size-3.5 shrink-0'} />
        <span dir="auto" className="truncate">{t(copy.titleKey, { host: label })}</span>
        {copy.busy ? null : (
          <Button type="button" variant="ghost" size="xs" className="-me-1.5 shrink-0" onClick={() => hostsMonitoring.refresh()}>
            {t('hosts.offline.retry')}
          </Button>
        )}
      </div>
    </div>
  );
};

const HostGate: React.FC<{ host: HostRuntime | undefined; children: React.ReactNode }> = ({ host, children }) => {
  const connection = useHostSelection(host?.status, readConnection, null);
  const authSession = useHostSelection(host && authSessionStoreOf(host.transport), readAuthSessionState, 'ok');
  const hasSessions = useHostSelection(host && useGlobalSessionsStore.forHost(host.id), readHasLoaded, false);
  if (connection?.state === 'auth-required' || authSession === 'reauthenticating') return <SessionAuthGate embedded>{children}</SessionAuthGate>;
  const offline = host && connection ? offlineCopyOf(connection) : null;
  if (host && offline && !hasSessions) return <HostOfflinePanel host={host} copy={offline} />;
  return (
    <>
      {children}
      {host && offline ? <HostOfflineIndicator host={host} copy={offline} /> : null}
    </>
  );
};

export const FocusedHostGate: React.FC<{ hostId: string; children: React.ReactNode }> = ({ hostId, children }) => {
  const host = hostRegistry.get(hostId);
  const gated = Boolean(host) && isMultiHostRuntimeEnabled() && hostId !== windowHostKey();
  return <HostGate host={gated ? host : undefined}>{children}</HostGate>;
};
