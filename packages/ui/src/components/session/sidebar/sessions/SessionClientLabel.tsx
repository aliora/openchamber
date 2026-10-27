import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useSessionClient } from '@/hooks/useSessionClient';
import { cn } from '@/lib/utils';

interface SessionClientLabelProps {
  providerId: string | null | undefined;
  modelId: string | null | undefined;
  /** Logo only, for rows without room for the text. */
  iconOnly?: boolean;
  className?: string;
}

export const SessionClientLabel: React.FC<SessionClientLabelProps> = ({ providerId, modelId, iconOnly = false, className }) => {
  const { engine, modelName } = useSessionClient(providerId, modelId);
  if (!providerId) return null;
  const text = [engine?.name, modelName].filter(Boolean).join(' · ');
  return (
    <span title={text} className={cn('flex min-w-0 items-center gap-1', className)}>
      <ProviderLogo providerId={providerId} className="h-3 w-3 flex-shrink-0 opacity-60" />
      {iconOnly ? null : <span dir="auto" className="min-w-0 truncate">{text}</span>}
    </span>
  );
};
