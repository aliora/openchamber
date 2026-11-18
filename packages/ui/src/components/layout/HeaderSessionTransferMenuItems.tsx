import React from 'react';

import { useSessionAutoResume } from '@/components/chat/useSessionAutoResume';
import { Icon } from '@/components/icon/Icon';
import { openSessionTransfer } from '@/components/session/transfer/sessionTransferStore';
import { toast } from '@/components/ui';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { setSessionAutoResume } from '@/lib/sessionAutoResume';
import type { SessionTabMenuComponents } from './SessionTabsStrip';

/** The header's session menu entries for an automatic resume and for moving the session to another host. */
export function HeaderSessionTransferMenuItems({ sessionId, title, Item }: {
  sessionId: string;
  title: string;
  Item: SessionTabMenuComponents['Item'];
}) {
  const { t } = useI18n();
  const autoResume = useSessionAutoResume(sessionId);
  const { hosts } = useMonitoredHosts();
  const enabled = Boolean(autoResume?.enabled);

  const toggleAutoResume = async () => {
    try {
      await setSessionAutoResume(runtimeFetch, sessionId, { enabled: !enabled });
    } catch (error) {
      toast.error(t('chat.autoResume.saveFailed', { reason: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <>
      <Item onClick={() => { void toggleAutoResume(); }}>
        <Icon name="timer" className="me-1 size-4" />
        {t(enabled ? 'chat.autoResume.menuOn' : 'chat.autoResume.menuOff')}
      </Item>
      {hosts.length > 0 ? (
        <Item onClick={() => openSessionTransfer({ sessionId, title, sourceHostId: null })}>
          <Icon name="send-plane" className="me-1 size-4" />
          {t('sessionTransfer.action.moveToHost')}
        </Item>
      ) : null}
    </>
  );
}
