import type { HostConnection } from '@/lib/hosts/types';
import type { I18nKey } from '@/lib/i18n';

type ConnectionView = { dotClass: string; labelKey: I18nKey; tone: 'muted' | 'warning' | 'error' };

const LIVE_VIEW: ConnectionView = { dotClass: 'bg-status-success', labelKey: 'sessions.sidebar.hosts.connection.live', tone: 'muted' };

export const CONNECTING_VIEW: ConnectionView = { dotClass: 'bg-status-info', labelKey: 'sessions.sidebar.hosts.connection.connecting', tone: 'muted' };

/** How a header's dot and the line under it read a watched host's connection. */
export const connectionView = (connection: HostConnection): ConnectionView => {
  switch (connection.state) {
    case 'live':
      return LIVE_VIEW;
    case 'connecting':
      return CONNECTING_VIEW;
    case 'backoff':
      return connection.failure === 'unreachable'
        ? { dotClass: 'bg-muted-foreground/50', labelKey: 'sessions.sidebar.hosts.status.offline', tone: 'muted' }
        : { dotClass: 'bg-status-error', labelKey: 'sessions.sidebar.hosts.status.unavailable', tone: 'error' };
    case 'auth-required':
      return { dotClass: 'bg-status-warning', labelKey: 'sessions.sidebar.hosts.status.signIn', tone: 'warning' };
    case 'incompatible':
      return { dotClass: 'bg-status-warning', labelKey: 'sessions.sidebar.hosts.status.update', tone: 'warning' };
    case 'relay-limit':
      return { dotClass: 'bg-status-error', labelKey: 'sessions.sidebar.hosts.status.relayLimit', tone: 'error' };
  }
};
