import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { useRunInTerminal } from '@/hooks/useRunInTerminal';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { DefaultModelStep, type ModelOption, type ModelSelection } from './DefaultModelStep';
import { EngineCard } from './EngineCard';
import { EngineChecklist, type RunCommand } from './EngineChecklist';
import { canContinueFromChecklist, deriveChecklist, isEngineReady, type EngineId } from './engineSetupModel';
import { useEngineSetupPolling, useEngineSetupStore } from './useEngineSetupStore';

type Step = 'choose' | 'prepare' | 'default';

type SetupWizardProps = { open: boolean; enterpriseMode: boolean; onClose: () => void };

const STEP_DESCRIPTION: Record<Step, I18nKey> = {
  choose: 'engineSetup.choose.description',
  prepare: 'engineSetup.prepare.description',
  default: 'engineSetup.default.description',
};

type SetupChanges = { engineSetupCompleted: true; defaultModel?: string; defaultVariant?: string };

export const SetupWizard: React.FC<SetupWizardProps> = ({ open, enterpriseMode, onClose }) => {
  const { t } = useI18n();
  const [step, setStep] = React.useState<Step>('choose');
  const [chosen, setChosen] = React.useState<Set<EngineId> | null>(null);
  const [selection, setSelection] = React.useState<ModelSelection | null>(null);
  const { snapshots, loaded, error, runAction, refresh } = useEngineSetupStore();
  const runInTerminal = useRunInTerminal();
  const providers = useConfigStore((state) => state.providers);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  useEngineSetupPolling(open);

  const all = [...snapshots.values()];
  const selected = chosen ?? new Set(all.filter((snapshot) => snapshot.status.installed).map((snapshot) => snapshot.status.engine));
  const selectedSnapshots = all.filter((snapshot) => selected.has(snapshot.status.engine));
  const readySnapshots = selectedSnapshots.filter(isEngineReady);
  const validSelection = selection && readySnapshots.some((snapshot) => snapshot.status.providerID === selection.providerID) ? selection : null;
  const modelsByProvider = new Map<string, ModelOption[]>(
    providers.map((provider) => [provider.id, provider.models.map((model) => ({ id: model.id, name: model.name ?? model.id }))]),
  );

  const runFor = (engine: EngineId): RunCommand | null => {
    if (!runInTerminal) return null;
    return (command, kind) => {
      runInTerminal(command, `engine-${engine}-${kind}`)
        .then(() => {
          void refresh();
          useUIStore.getState().setEngineSetupOpen(true);
        })
        .catch((runError: unknown) => {
          toast.error(t('engines.terminal.failed'), { description: runError instanceof Error ? runError.message : undefined });
        });
    };
  };

  const toggle = (engine: EngineId) => {
    const next = new Set(selected);
    if (next.has(engine)) next.delete(engine);
    else next.add(engine);
    setChosen(next);
  };

  const finish = async (withDefault: boolean) => {
    const changes: SetupChanges = { engineSetupCompleted: true };
    const value = withDefault && validSelection ? `${validSelection.providerID}/${validSelection.modelID}` : null;
    if (value) {
      changes.defaultModel = value;
      changes.defaultVariant = '';
    }
    try {
      const result = await updateDesktopSettings(changes);
      if (value && result.ok) setSettingsDefaultModel(value);
    } catch (error) {
      console.warn('Failed to save engine setup:', error);
    } finally {
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) void finish(false); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t('engineSetup.title')}</DialogTitle>
          <DialogDescription>{t(STEP_DESCRIPTION[step])}</DialogDescription>
        </DialogHeader>

        {step === 'choose' && loaded ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {all.map((snapshot) => (
              <EngineCard
                key={snapshot.status.engine}
                snapshot={snapshot}
                selected={selected.has(snapshot.status.engine)}
                onToggle={() => toggle(snapshot.status.engine)}
              />
            ))}
          </div>
        ) : null}

        {step === 'prepare' ? (
          <div className="flex flex-col gap-3">
            {selectedSnapshots.map((snapshot) => (
              <EngineChecklist
                key={snapshot.status.engine}
                snapshot={snapshot}
                checklist={deriveChecklist(snapshot, { enterpriseMode })}
                modelCount={modelsByProvider.get(snapshot.status.providerID)?.length ?? 0}
                enterpriseMode={enterpriseMode}
                onInstall={() => void runAction(snapshot.status.engine, 'install')}
                onUpdate={() => void runAction(snapshot.status.engine, 'update')}
                onRun={runFor(snapshot.status.engine)}
              />
            ))}
            {error ? <p className="typography-meta text-destructive">{error}</p> : null}
            {readySnapshots.length < selectedSnapshots.length ? (
              <p className="typography-meta text-muted-foreground">{t('engineSetup.notReady')}</p>
            ) : null}
          </div>
        ) : null}

        {step === 'default' ? (
          <DefaultModelStep engines={readySnapshots} modelsByProvider={modelsByProvider} selection={validSelection} onSelect={setSelection} />
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => void finish(false)}>{t('engineSetup.action.skip')}</Button>
          {step !== 'choose' ? (
            <Button variant="outline" onClick={() => setStep(step === 'default' ? 'prepare' : 'choose')}>{t('engineSetup.action.back')}</Button>
          ) : null}
          {step === 'choose' ? (
            <Button disabled={selected.size === 0} onClick={() => { setChosen(selected); setStep('prepare'); }}>{t('engineSetup.action.continue')}</Button>
          ) : null}
          {step === 'prepare' ? (
            <Button disabled={!canContinueFromChecklist(selectedSnapshots)} onClick={() => setStep('default')}>{t('engineSetup.action.continue')}</Button>
          ) : null}
          {step === 'default' ? (
            <Button disabled={!validSelection} onClick={() => void finish(true)}>{t('engineSetup.action.start')}</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
