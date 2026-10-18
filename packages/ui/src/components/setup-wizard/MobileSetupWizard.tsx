import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useEngineJobLog } from '@/components/sections/providers/engineJobStream';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useRunInTerminal } from '@/hooks/useRunInTerminal';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { CommandBox } from './CommandBox';
import { completeEngineSetup } from './completeEngineSetup';
import { DefaultModelStep, type ModelOption, type ModelSelection } from './DefaultModelStep';
import { EngineCard } from './EngineCard';
import {
  canLeaveMobileSetupStep,
  isEngineReady,
  loginCommandFor,
  MOBILE_SETUP_STEPS,
  type EngineId,
  type EngineSnapshot,
  type MobileSetupStep,
} from './engineSetupModel';
import { useEngineSetupPolling, useEngineSetupStore } from './useEngineSetupStore';

const LOG_TAIL_LINES = 6;

const STEP_TITLE: Record<MobileSetupStep, I18nKey> = {
  choose: 'engineSetup.mobile.choose.title',
  install: 'engineSetup.mobile.install.title',
  signIn: 'engineSetup.mobile.signIn.title',
  model: 'engineSetup.mobile.model.title',
  done: 'engineSetup.mobile.done.title',
};

const STEP_DESCRIPTION: Record<Exclude<MobileSetupStep, 'done'>, I18nKey> = {
  choose: 'engineSetup.choose.description',
  install: 'engineSetup.mobile.install.description',
  signIn: 'engineSetup.mobile.signIn.description',
  model: 'engineSetup.default.description',
};

type RunCommand = (engine: EngineId, command: string, kind: 'install' | 'update' | 'login') => void;

const EngineRow: React.FC<{ snapshot: EngineSnapshot; children: React.ReactNode }> = ({ snapshot, children }) => (
  <section className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface-elevated p-4">
    <div className="flex items-center gap-3">
      <ProviderLogo providerId={snapshot.status.providerID} className="size-7 shrink-0" />
      <span className="typography-ui-header min-w-0 flex-1 truncate font-semibold">{snapshot.status.displayName}</span>
    </div>
    {children}
  </section>
);

const StatusLine: React.FC<{ icon: 'check' | 'loader-4'; text: string }> = ({ icon, text }) => (
  <div className="flex items-center gap-2 typography-small text-muted-foreground">
    <Icon name={icon} className={cn('size-4', icon === 'check' ? 'text-[var(--status-success)]' : 'animate-spin')} />
    <span className="min-w-0 truncate">{text}</span>
  </div>
);

const InstallRow: React.FC<{ snapshot: EngineSnapshot; onRun: RunCommand | null }> = ({ snapshot, onRun }) => {
  const { t } = useI18n();
  const { status } = snapshot;
  const refresh = useEngineSetupStore((state) => state.refresh);
  const runAction = useEngineSetupStore((state) => state.runAction);
  const settle = React.useCallback(() => { void refresh(); }, [refresh]);
  const log = useEngineJobLog(status.engine, settle);
  const working = status.state === 'installing' || log.state === 'running';
  const action = status.installed ? (status.updateAvailable ? 'update' : null) : 'install';
  const serverAction = action !== null && status.actions[action];
  const command = action !== null && !serverAction ? status.commands[action] ?? status.installCommand : null;
  const tail = log.lines.slice(-LOG_TAIL_LINES);

  return (
    <EngineRow snapshot={snapshot}>
      {working ? <StatusLine icon="loader-4" text={t('engines.action.running', { action: t(action === 'update' ? 'engineSetup.action.update' : 'engineSetup.action.install') })} /> : null}
      {!working && status.installed ? <StatusLine icon="check" text={`${t('engineSetup.mobile.install.installed')}${status.version ? ` · ${status.version}` : ''}`} /> : null}
      {!working && serverAction && action ? (
        <Button size="lg" variant={action === 'install' ? 'default' : 'outline'} className="h-11 w-full" onClick={() => void runAction(status.engine, action)}>
          {t(action === 'install' ? 'engineSetup.action.install' : 'engineSetup.action.update')}
        </Button>
      ) : null}
      {!working && command && action ? (
        <CommandBox command={command} onRun={onRun ? () => onRun(status.engine, command, action) : undefined} runLabel={t('engines.action.runInTerminal')} />
      ) : null}
      {tail.length > 0 ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground">{tail.join('\n')}</pre>
      ) : null}
      {status.state === 'failed' && status.lastError ? <p className="typography-small text-[var(--status-error)]">{status.lastError}</p> : null}
    </EngineRow>
  );
};

const SignInRow: React.FC<{ snapshot: EngineSnapshot; enterpriseMode: boolean; onRun: RunCommand | null }> = ({ snapshot, enterpriseMode, onRun }) => {
  const { t } = useI18n();
  const { status } = snapshot;
  const command = loginCommandFor(snapshot);
  return (
    <EngineRow snapshot={snapshot}>
      {isEngineReady(snapshot) ? <StatusLine icon="check" text={t('engines.signIn.signedIn')} /> : null}
      {snapshot.readiness === 'unknown' ? <StatusLine icon="loader-4" text={t('engineSetup.mobile.signIn.checking')} /> : null}
      {snapshot.readiness === 'signed-out' && enterpriseMode ? <p className="typography-small text-muted-foreground">{t('engineSetup.enterpriseLogin')}</p> : null}
      {snapshot.readiness === 'signed-out' && !enterpriseMode ? (
        <>
          <Button size="lg" className="h-11 w-full" disabled={!onRun} onClick={() => onRun?.(status.engine, command, 'login')}>
            <Icon name="terminal" className="size-4" />
            {t('engines.signIn.login')}
          </Button>
          {status.engine === 'antigravity' ? <p className="typography-small text-muted-foreground">{t('engines.signIn.agyLogin')}</p> : null}
          {!onRun ? <CommandBox command={command} /> : null}
        </>
      ) : null}
    </EngineRow>
  );
};

type MobileSetupWizardProps = { open: boolean; enterpriseMode: boolean; onClose: () => void };

export const MobileSetupWizard: React.FC<MobileSetupWizardProps> = ({ open, enterpriseMode, onClose }) => {
  const { t } = useI18n();
  const [step, setStep] = React.useState<MobileSetupStep>('choose');
  const [chosen, setChosen] = React.useState<Set<EngineId> | null>(null);
  const [selection, setSelection] = React.useState<ModelSelection | null>(null);
  const { snapshots, loaded, error, refresh } = useEngineSetupStore();
  const runInTerminal = useRunInTerminal();
  const providers = useConfigStore((state) => state.providers);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  useEngineSetupPolling(true);

  const all = [...snapshots.values()];
  const selected = chosen ?? new Set(all.filter((snapshot) => snapshot.status.installed).map((snapshot) => snapshot.status.engine));
  const selectedSnapshots = all.filter((snapshot) => selected.has(snapshot.status.engine));
  const installedSnapshots = selectedSnapshots.filter((snapshot) => snapshot.status.installed);
  const readySnapshots = selectedSnapshots.filter(isEngineReady);
  const modelsByProvider = new Map<string, ModelOption[]>(
    providers.map((provider) => [provider.id, provider.models.map((model) => ({ id: model.id, name: model.name ?? model.id }))]),
  );
  const firstModelEngine = readySnapshots.find((snapshot) => (modelsByProvider.get(snapshot.status.providerID)?.length ?? 0) > 0);
  const firstModel = firstModelEngine ? modelsByProvider.get(firstModelEngine.status.providerID)?.[0] : undefined;
  const validSelection = selection && readySnapshots.some((snapshot) => snapshot.status.providerID === selection.providerID)
    ? selection
    : firstModelEngine && firstModel ? { providerID: firstModelEngine.status.providerID, modelID: firstModel.id } : null;
  const stepIndex = MOBILE_SETUP_STEPS.indexOf(step);
  const canContinue = canLeaveMobileSetupStep(step, { selected: selectedSnapshots, hasModel: validSelection !== null });
  const selectedModelName = validSelection
    ? modelsByProvider.get(validSelection.providerID)?.find((model) => model.id === validSelection.modelID)?.name ?? validSelection.modelID
    : null;

  const runCommand: RunCommand | null = runInTerminal
    ? (engine, command, kind) => {
      runInTerminal(command, `engine-${engine}-${kind}`)
        .then(() => refresh())
        .catch((runError: unknown) => {
          toast.error(t('engines.terminal.failed'), { description: runError instanceof Error ? runError.message : undefined });
        });
    }
    : null;

  const toggle = (engine: EngineId) => {
    const next = new Set(selected);
    if (next.has(engine)) next.delete(engine);
    else next.add(engine);
    setChosen(next);
  };

  const goTo = (next: MobileSetupStep) => {
    if (step === 'choose') setChosen(selected);
    if (next === 'model') void loadProviders({ source: 'setupWizard:mobile', fresh: true });
    setStep(next);
  };

  const finish = async (withDefault: boolean) => {
    await completeEngineSetup(withDefault ? validSelection : null);
    onClose();
  };

  const next = MOBILE_SETUP_STEPS[stepIndex + 1];
  const previous = MOBILE_SETUP_STEPS[stepIndex - 1];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('engineSetup.title')}
      aria-hidden={!open}
      className={cn('oc-keyboard-inset-surface fixed inset-0 z-[60] flex flex-col bg-background text-foreground', !open && 'hidden')}
      style={{ paddingTop: 'var(--oc-safe-area-top, 0px)' }}
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-2">
        {previous && step !== 'done' ? (
          <Button variant="ghost" size="icon" className="size-10" aria-label={t('engineSetup.action.back')} onClick={() => setStep(previous)}>
            <Icon name="arrow-left-s" className="size-6" />
          </Button>
        ) : (
          <Button variant="ghost" size="icon" className="size-10" aria-label={t('engineSetup.mobile.close')} onClick={() => void finish(false)}>
            <Icon name="close" className="size-5" />
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-center typography-small text-muted-foreground">
          {t('engineSetup.mobile.step', { current: stepIndex + 1, total: MOBILE_SETUP_STEPS.length })}
        </span>
        {step !== 'done' ? (
          <Button variant="ghost" size="sm" className="h-10 px-3" onClick={() => void finish(false)}>{t('engineSetup.action.skip')}</Button>
        ) : <span className="w-10" />}
      </header>
      <div className="flex shrink-0 gap-1.5 px-5" aria-hidden>
        {MOBILE_SETUP_STEPS.map((entry, index) => (
          <span key={entry} className={cn('h-1 flex-1 rounded-full', index <= stepIndex ? 'bg-primary' : 'bg-border')} />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-6">
        <div className="mx-auto flex w-full max-w-md flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h1 className="typography-h2 font-semibold text-foreground">{t(STEP_TITLE[step])}</h1>
            {step !== 'done' ? <p className="typography-body text-muted-foreground">{t(STEP_DESCRIPTION[step])}</p> : null}
          </div>

          {step === 'choose' && !loaded ? <StatusLine icon="loader-4" text={t('engineSetup.mobile.signIn.checking')} /> : null}
          {step === 'choose' && loaded ? (
            <div className="flex flex-col gap-3">
              {all.map((snapshot) => (
                <EngineCard key={snapshot.status.engine} snapshot={snapshot} selected={selected.has(snapshot.status.engine)} onToggle={() => toggle(snapshot.status.engine)} />
              ))}
            </div>
          ) : null}

          {step === 'install' ? selectedSnapshots.map((snapshot) => (
            <InstallRow key={snapshot.status.engine} snapshot={snapshot} onRun={runCommand} />
          )) : null}

          {step === 'signIn' ? (
            <>
              {installedSnapshots.map((snapshot) => (
                <SignInRow key={snapshot.status.engine} snapshot={snapshot} enterpriseMode={enterpriseMode} onRun={runCommand} />
              ))}
              <Button variant="outline" className="self-start" onClick={() => void refresh()}>
                <Icon name="refresh" className="size-4" />
                {t('engines.page.refresh')}
              </Button>
              {readySnapshots.length < selectedSnapshots.length ? <p className="typography-small text-muted-foreground">{t('engineSetup.notReady')}</p> : null}
            </>
          ) : null}

          {step === 'model' ? (
            <DefaultModelStep engines={readySnapshots} modelsByProvider={modelsByProvider} selection={validSelection} onSelect={setSelection} />
          ) : null}

          {step === 'done' ? (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                {readySnapshots.map((snapshot) => (
                  <div key={snapshot.status.engine} className="flex items-center gap-3 rounded-2xl border border-border/70 bg-surface-elevated p-3">
                    <ProviderLogo providerId={snapshot.status.providerID} className="size-6 shrink-0" />
                    <span className="typography-ui-label min-w-0 flex-1 truncate">{snapshot.status.displayName}</span>
                    <Icon name="check" className="size-5 text-[var(--status-success)]" />
                  </div>
                ))}
              </div>
              <p className="typography-body text-muted-foreground">
                {selectedModelName ? t('engineSetup.mobile.done.description', { model: selectedModelName }) : t('engineSetup.mobile.done.descriptionNoModel')}
              </p>
            </div>
          ) : null}

          {error ? <p className="typography-small text-[var(--status-error)]">{error}</p> : null}
        </div>
      </div>

      <footer className="shrink-0 border-t border-border/40 px-5 pt-3 pb-[max(0.75rem,var(--oc-app-bottom-safe,0px))]">
        <div className="mx-auto w-full max-w-md">
          {step === 'done' ? (
            <Button size="lg" className="h-12 w-full" onClick={() => void finish(true)}>{t('engineSetup.action.start')}</Button>
          ) : (
            <Button size="lg" className="h-12 w-full" disabled={!canContinue || !next} onClick={() => next && goTo(next)}>
              {t('engineSetup.action.continue')}
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
};
