import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { connectionView } from '@/components/session/sidebar/hosts/hostConnectionView';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { LOCAL_HOST_ID, runtimeKeyForDesktopHost } from '@/lib/desktopCurrentHost';
import { redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';
import { HOST_ICON_CHOICES, useHostIcon, useHostIconStore } from '@/lib/hosts/host-icons';
import { useHostConnection } from '@/lib/hosts/runtime/useHostConnection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const TONE_CLASS = { muted: 'text-muted-foreground', warning: 'text-[var(--status-warning)]', error: 'text-[var(--status-error)]' } as const;

const addressOf = (host: DesktopHost, relayLabel: string): string => (
  host.relay && !host.apiUrl ? relayLabel : redactSensitiveUrl(host.apiUrl || host.url)
);

export const HostListRow: React.FC<{
  host: DesktopHost;
  disabled: boolean;
  onRename: (host: DesktopHost) => void;
  onEdit?: (host: DesktopHost) => void;
  onRemove?: (host: DesktopHost) => void;
}> = ({ host, disabled, onRename, onEdit, onRemove }) => {
  const { t } = useI18n();
  const runtimeKey = runtimeKeyForDesktopHost(host);
  const connection = useHostConnection(runtimeKey);
  const icon = useHostIcon(runtimeKey, host.id === LOCAL_HOST_ID ? 'local' : 'direct');
  const setIcon = useHostIconStore((state) => state.setIcon);
  const view = connection ? connectionView(connection) : null;
  const label = formatHostLabel({ id: host.id, label: host.label, displayUrl: host.url }, t);
  return (
    <div data-host-id={host.id} className="flex items-center justify-between gap-3 py-1.5">
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name={icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          {view ? <span role="img" aria-label={t(view.labelKey)} className={cn('h-2 w-2 shrink-0 rounded-full', view.dotClass)} /> : null}
          <p dir="auto" className="typography-ui-label text-foreground truncate">{label}</p>
          {view ? (
            <span className={cn('typography-micro shrink-0', connection?.state === 'live' ? 'text-[var(--status-success)]' : TONE_CLASS[view.tone])}>
              {t(view.labelKey)}
            </span>
          ) : null}
        </div>
        <p className={cn('typography-micro text-muted-foreground truncate', host.apiUrl && 'font-mono')}>
          {addressOf(host, t('mobile.connect.relay.badge'))}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="!font-normal" disabled={disabled}>
              <Icon name={icon} className="h-3.5 w-3.5" />
              {t('hosts.settings.actions.icon')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-0">
            <div className="grid grid-cols-4 gap-0.5">
              {HOST_ICON_CHOICES.map((choice) => (
                <DropdownMenuItem key={choice} aria-label={choice} aria-current={choice === icon} className="justify-center" onSelect={() => setIcon(runtimeKey, choice)}>
                  <Icon name={choice} className={cn('h-4 w-4', choice === icon && 'text-primary')} />
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuItem onSelect={() => setIcon(runtimeKey, null)}>{t('hosts.settings.icon.reset')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => onRename(host)} disabled={disabled}>
          <Icon name="edit" className="h-3.5 w-3.5" />
          {t('hosts.settings.actions.rename')}
        </Button>
        {onEdit ? (
          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => onEdit(host)} disabled={disabled}>
            <Icon name="pencil" className="h-3.5 w-3.5" />
            {t('desktopHostSwitcher.actions.edit')}
          </Button>
        ) : null}
        {onRemove ? (
          <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => onRemove(host)} disabled={disabled}>
            <Icon name="delete-bin" className="h-3.5 w-3.5" />
            {t('hosts.settings.actions.remove')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
