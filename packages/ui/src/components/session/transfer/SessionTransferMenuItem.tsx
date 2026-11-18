import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useMonitoredHosts } from '@/lib/hosts/useMonitoredHosts';
import { useI18n } from '@/lib/i18n';
import { openSessionTransfer } from './sessionTransferStore';

/**
 * "Move to another host…" in a session's menu. Hidden where the window runs
 * a single host, or when the session's host is the only one saved.
 */
export const SessionTransferMenuItem: React.FC<{
  sessionId: string;
  title: string;
  sourceHostId: string | null;
  Item: React.ElementType;
}> = ({ sessionId, title, sourceHostId, Item }) => {
  const { t } = useI18n();
  const { hosts, activeHost } = useMonitoredHosts();
  const otherHosts = hosts.filter((host) => host.descriptor.id !== sourceHostId).length + (sourceHostId !== null && activeHost ? 1 : 0);
  if (otherHosts === 0) return null;
  return (
    <Item onClick={() => openSessionTransfer({ sessionId, title, sourceHostId })} className="[&>svg]:me-1">
      <Icon name="send-plane" className="me-1 h-4 w-4" />
      {t('sessionTransfer.action.moveToHost')}
    </Item>
  );
};
