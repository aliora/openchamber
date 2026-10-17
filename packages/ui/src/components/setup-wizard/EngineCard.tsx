import React from 'react';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { EngineId, EngineSnapshot } from './engineSetupModel';

type EngineCardProps = { snapshot: EngineSnapshot; selected: boolean; onToggle: () => void };

const ENGINE_DESCRIPTION: Record<EngineId, I18nKey> = {
  claude: 'engineSetup.engine.claude',
  codex: 'engineSetup.engine.codex',
  antigravity: 'engineSetup.engine.antigravity',
};

export const EngineCard: React.FC<EngineCardProps> = ({ snapshot, selected, onToggle }) => {
  const { t } = useI18n();
  const { status } = snapshot;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onToggle}
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4 text-start transition-colors',
        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
      )}
    >
      <div className="flex items-center justify-between">
        <ProviderLogo providerId={status.providerID} className="h-8 w-8" />
        <span className={cn('h-4 w-4 rounded border', selected ? 'border-primary bg-primary' : 'border-muted-foreground')} />
      </div>
      <div>
        <div className="typography-ui-header font-semibold">{status.displayName}</div>
        <div className="typography-meta text-muted-foreground">{t(ENGINE_DESCRIPTION[status.engine])}</div>
      </div>
      {status.version ? <div className="typography-meta font-mono text-muted-foreground">{status.version}</div> : null}
    </button>
  );
};
