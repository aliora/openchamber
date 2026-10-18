import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RowMarkTooltip } from './RowMarkTooltip';

const CHIP_CLASS = 'inline-flex h-4 flex-shrink-0 items-center rounded bg-[var(--surface-muted)] px-1 typography-micro leading-none text-muted-foreground';

export const SessionProjectChip: React.FC<{ label: string }> = ({ label }) => (
  <RowMarkTooltip label={label}>
    <span dir="auto" className={cn(CHIP_CLASS, 'min-w-0 max-w-24 truncate')}>{label}</span>
  </RowMarkTooltip>
);

export const SubsessionCountBadge: React.FC<{ count: number }> = ({ count }) => {
  const { t } = useI18n();
  const label = count === 1
    ? t('sessions.sidebar.session.subsessions.countSingle', { count })
    : t('sessions.sidebar.session.subsessions.countPlural', { count });
  return <RowMarkTooltip label={label}>
    <span role="img" aria-label={label} className={cn(CHIP_CLASS, 'tabular-nums')}>{count}</span>
  </RowMarkTooltip>;
};
