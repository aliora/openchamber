import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useHostSessionOpener } from '@/lib/hosts/hostSessionOpenerContext';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n } from '@/lib/i18n';
import { getSessionTransferredTo, type SessionTransferredTo } from '@/lib/sessionAutoResume';
import { useSessionSelector } from '@/sync/sync-context';

const sameTransfer = (left: SessionTransferredTo | null, right: SessionTransferredTo | null): boolean => (
  left?.targetSessionId === right?.targetSessionId && left?.transferredAt === right?.transferredAt
);

/** Under a session that moved to another host: where it went, and a way there. */
export const SessionTransferredNotice: React.FC<{ sessionId: string; directory?: string }> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const transferredTo = useSessionSelector(sessionId, directory, getSessionTransferredTo, sameTransfer);
  const { hosts, activeHost } = useMonitoredHosts();
  const opener = useHostSessionOpener();
  if (!transferredTo) return null;

  const host = [...hosts.map((entry) => entry.descriptor), ...(activeHost ? [activeHost] : [])]
    .find((descriptor) => descriptor.runtimeKey === transferredTo.runtimeKey) ?? null;
  const targetDirectory = transferredTo.targetDirectory;

  return (
    <div className="chat-message-column">
      <div role="status" className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-[var(--surface-muted)] px-3 py-2">
        <Icon name="send-plane" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="typography-meta text-foreground">{t('sessionTransfer.notice.movedTo', { host: transferredTo.hostLabel })}</span>
        {host && targetDirectory ? (
          <Button
            variant="link"
            size="xs"
            className="normal-case"
            onClick={() => {
              void opener.open({
                host,
                target: { kind: 'session', sessionId: transferredTo.targetSessionId, directory: targetDirectory },
                onProblem: () => toast.error(t('sessionTransfer.toast.openFailed', { host: transferredTo.hostLabel })),
              });
            }}
          >
            {t('sessionTransfer.notice.open')}
          </Button>
        ) : null}
      </div>
    </div>
  );
};
