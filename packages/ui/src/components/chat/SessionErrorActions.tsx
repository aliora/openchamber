import React from 'react';

import { openSessionTransfer } from '@/components/session/transfer/sessionTransferStore';
import { Button } from '@/components/ui/button';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n } from '@/lib/i18n';
import { looksLikeUsageLimit } from '@/lib/sessionAutoResume';
import { useSessionSelector } from '@/sync/sync-context';
import { SessionAutoResumeControl } from './SessionAutoResumeControl';
import { useSessionAutoResume } from './useSessionAutoResume';

const selectTitle = (session: { title?: string } | undefined): string => session?.title ?? '';

/**
 * What the user can do about a stopped turn besides sending again: resume by
 * itself once a usage limit lifts, or carry on on another host.
 */
export const SessionErrorActions: React.FC<{ sessionId: string; directory?: string; detail: string }> = ({ sessionId, directory, detail }) => {
  const { t } = useI18n();
  const autoResume = useSessionAutoResume(sessionId, directory);
  const title = useSessionSelector(sessionId, directory, selectTitle);
  const { hosts } = useMonitoredHosts();
  const showAutoResume = looksLikeUsageLimit(detail) || Boolean(autoResume?.enabled) || Boolean(autoResume?.resumeAt);

  if (!showAutoResume && hosts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2 ps-[1.375rem]">
      {showAutoResume ? <SessionAutoResumeControl sessionId={sessionId} directory={directory} /> : null}
      {hosts.length > 0 ? (
        <div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => openSessionTransfer({ sessionId, title, sourceHostId: null })}
          >
            {t('sessionTransfer.action.continueElsewhere')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
