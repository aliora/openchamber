import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { connectionView } from '@/components/session/sidebar/hosts/hostConnectionView';
import { formatHostLabel } from '@/components/session/sidebar/hosts/useHostSessionActions';
import { Button } from '@/components/ui/button';
import { HostMark } from '@/components/ui/HostMark';
import { LogoChoiceGrid } from '@/components/ui/LogoChoiceGrid';
import { useHostLogo } from '@/hooks/useHostLogo';
import { HOST_LOGO_CHOICES } from '@/lib/engineAppearance';
import { LOCAL_HOST_ID, runtimeKeyForDesktopHost } from '@/lib/desktopCurrentHost';
import { redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';
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
  const connection = useHostConnection(runtimeKeyForDesktopHost(host));
  const view = connection ? connectionView(connection) : null;
  const label = formatHostLabel({ id: host.id, label: host.label, displayUrl: host.url }, t);
  const [pickingLogo, setPickingLogo] = React.useState(false);
  const markHost = { id: host.id, label };
  const { logo, setLogo } = useHostLogo(markHost);
  const defaultIcon = host.id === LOCAL_HOST_ID ? 'computer' : 'server';
  return (
    <div data-host-id={host.id} className="py-1.5">
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <HostMark host={markHost} defaultIcon={defaultIcon} className="size-3.5 shrink-0 text-muted-foreground" />
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
        <Button type="button" variant="ghost" size="xs" className="!font-normal" aria-expanded={pickingLogo} onClick={() => setPickingLogo((open) => !open)}>
          <Icon name="palette" className="h-3.5 w-3.5" />
          {t('hosts.settings.actions.logo')}
        </Button>
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
    {pickingLogo ? (
      <div className="pt-2">
        <LogoChoiceGrid
          choices={HOST_LOGO_CHOICES}
          selected={logo}
          name={label}
          ariaLabel={t('hosts.settings.actions.logo')}
          defaultLabel={t('hosts.settings.logo.default')}
          renderDefault={() => <Icon name={defaultIcon} className="size-4 text-muted-foreground" />}
          onSelect={setLogo}
        />
      </div>
    ) : null}
    </div>
  );
};
