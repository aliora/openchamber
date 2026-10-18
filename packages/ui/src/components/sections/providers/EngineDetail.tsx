import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsFieldRow, SettingsSection, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsBackButton, SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { CommandBox } from '@/components/setup-wizard/CommandBox';
import { EngineSignInDialog } from '@/components/setup-wizard/EngineSignInDialog';
import { refreshEngineModels } from '@/components/setup-wizard/engineSetupApi';
import type { EngineActionId, EngineCommandId, EngineSnapshot } from '@/components/setup-wizard/engineSetupModel';
import { useEngineSetupStore, type EngineActionNotice } from '@/components/setup-wizard/useEngineSetupStore';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useRunInTerminal } from '@/hooks/useRunInTerminal';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { EngineModelsSection, type EngineProvider } from './EngineModelsSection';
import { EngineUninstallDialog } from './EngineUninstallDialog';
import { SOURCE_LABEL } from './engineLabels';
import { useEngineJobLog, type JobLog, type JobState } from './engineJobStream';
import {
  deriveActionOffers,
  deriveSignIn,
  deriveVersion,
  isEngineBusy,
  troubleshootingCommands,
  type ActionOffer,
  type SignInView,
  type TerminalHint,
} from './engineManagement';

const ACTION_LABEL: Record<EngineActionId, I18nKey> = {
  install: 'engines.action.install',
  update: 'engines.action.update',
  reinstall: 'engines.action.reinstall',
  uninstall: 'engines.action.uninstall',
  doctor: 'engines.action.doctor',
};

const COMMAND_LABEL: Record<EngineCommandId, I18nKey> = {
  ...ACTION_LABEL,
  login: 'engines.command.login',
  logout: 'engines.command.logout',
};

const HINT_LABEL: Record<Exclude<TerminalHint, null>, I18nKey> = {
  'agy-logout': 'engines.signIn.agyLogout',
};

const LOG_STATE_LABEL: Record<JobState, I18nKey> = {
  idle: 'engines.log.state.idle',
  running: 'engines.log.state.running',
  completed: 'engines.log.state.completed',
  failed: 'engines.log.state.failed',
};

type RunCommand = ((command: string, kind: string) => void) | null;

const TerminalCommand: React.FC<{ label?: string; command: string; runCommand: RunCommand; kind: string }> = ({ label, command, runCommand, kind }) => {
  const { t } = useI18n();
  return (
    <div className="min-w-0">
      {label ? <span className={SETTINGS_HELPER_CLASS}>{label}</span> : null}
      <CommandBox
        command={command}
        onRun={runCommand ? () => runCommand(command, kind) : undefined}
        runLabel={t('engines.action.runInTerminal')}
      />
    </div>
  );
};

const VersionValue: React.FC<{ snapshot: EngineSnapshot }> = ({ snapshot }) => {
  const { t } = useI18n();
  const version = deriveVersion(snapshot.status);
  if (version.kind === 'missing') return <span className="typography-ui-label text-muted-foreground">{t('engines.status.notInstalled')}</span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="typography-ui-label font-mono">{version.current ?? '—'}</span>
      {version.kind === 'update'
        ? <SettingsCardPill tone="info">{t('engines.status.updateAvailable', { latest: version.latest })}</SettingsCardPill>
        : <SettingsCardPill tone="neutral">{version.latest ? t('engines.status.upToDate') : t('engines.status.latestUnknown')}</SettingsCardPill>}
    </span>
  );
};

const signInLabel = (view: SignInView, failure: string | null, t: ReturnType<typeof useI18n>['t']): string => {
  if (failure && view.state === 'unknown') return t('engines.signIn.failed', { message: failure });
  if (view.state === 'signed-in') return view.account ? t('engines.signIn.signedInAs', { account: view.account }) : t('engines.signIn.signedIn');
  if (view.state === 'signed-out') return t('engines.signIn.signedOut');
  return t('engines.signIn.unknown');
};

const ActionNotice: React.FC<{ notice: EngineActionNotice; runCommand: RunCommand }> = ({ notice, runCommand }) => {
  const { t } = useI18n();
  const action = t(ACTION_LABEL[notice.action]);
  if (notice.kind === 'busy') return <p className="typography-meta text-[var(--status-warning)]">{t('engines.notice.busy')}</p>;
  if (notice.kind === 'failed') return <p className="typography-meta text-[var(--status-error)]">{t('engines.notice.failed', { action, message: notice.message })}</p>;
  return <TerminalCommand label={t('engines.notice.command', { action })} command={notice.command} runCommand={runCommand} kind={notice.action} />;
};

const JobLogPanel: React.FC<{ log: JobLog }> = ({ log }) => {
  const { t } = useI18n();
  const scrollRef = React.useRef<HTMLPreElement | null>(null);
  React.useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [log.lines.length]);
  return (
    <SettingsSection
      title={t('engines.log.title')}
      titleAccessory={(
        <SettingsCardPill tone={log.state === 'failed' ? 'error' : log.state === 'running' ? 'info' : 'neutral'}>
          {log.action ? `${t(ACTION_LABEL[log.action])} · ` : ''}{t(LOG_STATE_LABEL[log.state])}
        </SettingsCardPill>
      )}
    >
      <pre
        ref={scrollRef}
        className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-lg oc-tile-inset p-3 font-mono typography-micro"
      >
        {log.lines.length === 0 ? <span className="text-muted-foreground">{t('engines.log.empty')}</span> : log.lines.map((line, index) => (
          <span
            key={index}
            className={cn(line.stream === 'system' && 'text-muted-foreground', line.stream === 'stderr' && 'text-[var(--status-warning)]')}
          >
            {line.text}
          </span>
        ))}
      </pre>
    </SettingsSection>
  );
};

type EngineDetailProps = {
  snapshot: EngineSnapshot;
  provider: EngineProvider | undefined;
  enterpriseMode: boolean;
  onBack: () => void;
};

export const EngineDetail: React.FC<EngineDetailProps> = ({ snapshot, provider, enterpriseMode, onBack }) => {
  const { t } = useI18n();
  const { status } = snapshot;
  const { engine } = status;
  const authEntry = useEngineSetupStore((state) => state.auth.get(engine) ?? null);
  const notice = useEngineSetupStore((state) => state.actionNotice.get(engine) ?? null);
  const logoutMessage = useEngineSetupStore((state) => state.logoutMessage.get(engine) ?? null);
  const refresh = useEngineSetupStore((state) => state.refresh);
  const refreshAuth = useEngineSetupStore((state) => state.refreshAuth);
  const runAction = useEngineSetupStore((state) => state.runAction);
  const logout = useEngineSetupStore((state) => state.logout);
  const runInTerminal = useRunInTerminal();
  const [pending, setPending] = React.useState<EngineActionId | 'logout' | null>(null);
  const [confirmUninstall, setConfirmUninstall] = React.useState(false);
  const [signingIn, setSigningIn] = React.useState(false);
  const [refreshingModels, setRefreshingModels] = React.useState(false);
  const settingsDirectory = useSettingsDirectory();
  const loadProviders = useConfigStore((state) => state.loadProviders);

  const refreshAll = React.useCallback(() => {
    void refresh();
    void refreshAuth(engine);
  }, [engine, refresh, refreshAuth]);

  React.useEffect(() => {
    if (status.installed) void refreshAuth(engine);
  }, [engine, refreshAuth, snapshot.readiness, status.installed]);

  const log = useEngineJobLog(engine, refreshAll);

  const runCommand: RunCommand = React.useMemo(() => {
    if (!runInTerminal) return null;
    return (command: string, kind: string) => {
      runInTerminal(command, `engine-${engine}-${kind}`)
        .then(refreshAll)
        .catch((error: unknown) => {
          toast.error(t('engines.terminal.failed'), { description: error instanceof Error ? error.message : undefined });
        });
    };
  }, [engine, refreshAll, runInTerminal, t]);

  const busy = isEngineBusy(status) || pending !== null;
  const offers = deriveActionOffers(status);
  const serverOffers = offers.filter((offer): offer is Extract<ActionOffer, { mode: 'server' }> => offer.mode === 'server');
  const terminalOffers = offers.filter((offer): offer is Extract<ActionOffer, { mode: 'terminal' }> => offer.mode === 'terminal');
  const auth = authEntry?.kind === 'loaded' ? authEntry.auth : null;
  const authFailure = authEntry?.kind === 'failed' ? authEntry.message : null;
  const signIn = deriveSignIn(snapshot, auth, { enterpriseMode });
  const runningAction = status.currentAction ?? (log.state === 'running' ? log.action : null) ?? (pending !== 'logout' ? pending : null);
  const showLog = log.state === 'running' || log.lines.length > 0;
  const diagnostics = [
    { label: t('engines.troubleshooting.commandPath'), value: status.commandPath },
    { label: t('engines.troubleshooting.rawVersion'), value: status.rawVersion },
    { label: t('engines.troubleshooting.lastError'), value: status.lastError },
    { label: t('engines.troubleshooting.detection'), value: status.detectionError !== status.lastError ? status.detectionError : null },
  ].filter((row): row is { label: string; value: string } => Boolean(row.value));

  const startAction = async (action: EngineActionId, options?: { removeConfig?: boolean }) => {
    setPending(action);
    try {
      await runAction(engine, action, options);
    } finally {
      setPending(null);
    }
  };

  const refreshModels = async () => {
    setRefreshingModels(true);
    try {
      const result = await refreshEngineModels(engine);
      await loadProviders({ directory: settingsDirectory, source: 'settings:engineModels', fresh: true });
      if (result.ok) toast.success(t('engines.models.refreshed', { count: result.count }));
      else toast.error(t('engines.models.refreshFailed'), { description: result.message ?? undefined });
    } catch (error: unknown) {
      toast.error(t('engines.models.refreshFailed'), { description: error instanceof Error ? error.message : undefined });
    } finally {
      setRefreshingModels(false);
    }
  };

  const startLogout = async () => {
    setPending('logout');
    try {
      await logout(engine);
    } finally {
      setPending(null);
    }
  };

  return (
    <SettingsPageLayout
      title={status.displayName}
      titleLeading={(
        <span className="flex items-center gap-2">
          <SettingsBackButton label={t('engines.page.back')} onClick={onBack} />
          <ProviderLogo providerId={status.providerID} className="h-5 w-5 shrink-0" />
        </span>
      )}
      description={<span className="typography-settings-description font-mono text-muted-foreground">{engine}</span>}
      headerEnd={<Button size="sm" variant="outline" onClick={refreshAll}>{t('engines.page.refresh')}</Button>}
      showSaveStatus={false}
    >
      <SettingsSection title={t('engines.status.title')} divider={false} contentClassName="space-y-3">
        <SettingsFieldRow label={t('engines.status.version')} alignEnd={false}>
          <VersionValue snapshot={snapshot} />
        </SettingsFieldRow>
        {status.installed ? (
          <SettingsFieldRow label={t('engines.status.source')} alignEnd={false}>
            <span className="typography-ui-label">{t(SOURCE_LABEL[status.installSource])}</span>
          </SettingsFieldRow>
        ) : null}
        <SettingsFieldRow label={t('engines.status.signIn')} alignEnd={false}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="typography-ui-label min-w-0 break-all">{signInLabel(signIn, authFailure, t)}</span>
            {signIn.plan ? <SettingsCardPill tone="neutral">{signIn.plan}</SettingsCardPill> : null}
          </span>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('engines.status.models')} alignEnd={false}>
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="typography-ui-label tabular-nums">{provider?.models.length ?? 0}</span>
            {status.installed ? (
              <Button size="sm" variant="outline" disabled={refreshingModels} onClick={() => void refreshModels()}>
                {t('engines.models.refresh')}
              </Button>
            ) : null}
          </span>
        </SettingsFieldRow>
      </SettingsSection>

      {status.installed ? (
        <SettingsSection title={t('engines.status.signIn')} info={t('engines.signIn.loginInfo')} contentClassName="space-y-3">
          {signIn.login ? (
            <Button size="sm" onClick={() => setSigningIn(true)}>{t('engines.signIn.login')}</Button>
          ) : null}
          {enterpriseMode && signIn.state !== 'signed-in' ? <p className={SETTINGS_HELPER_CLASS}>{t('engineSetup.enterpriseLogin')}</p> : null}
          {signIn.logout?.mode === 'server' ? (
            <Button size="sm" variant="outline" disabled={pending === 'logout'} onClick={() => void startLogout()}>{t('engines.signIn.logout')}</Button>
          ) : null}
          {signIn.logout?.mode === 'terminal' ? (
            <>
              {signIn.logout.hint ? <p className={SETTINGS_HELPER_CLASS}>{t(HINT_LABEL[signIn.logout.hint])}</p> : null}
              <TerminalCommand command={signIn.logout.command} runCommand={runCommand} kind="logout" />
            </>
          ) : null}
          {logoutMessage ? <p className="typography-meta text-[var(--status-error)]">{logoutMessage}</p> : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title={t('engines.actions.title')} info={t('engines.actions.info')} contentClassName="space-y-3">
        {serverOffers.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {serverOffers.map(({ action }) => (
              <Button
                key={action}
                size="sm"
                variant={action === 'uninstall' ? 'destructive' : action === 'update' || action === 'install' ? 'default' : 'outline'}
                disabled={busy}
                onClick={() => (action === 'uninstall' ? setConfirmUninstall(true) : void startAction(action))}
              >
                {t(ACTION_LABEL[action])}
              </Button>
            ))}
          </div>
        ) : null}
        {runningAction ? <p className={SETTINGS_HELPER_CLASS}>{t('engines.action.running', { action: t(ACTION_LABEL[runningAction]) })}</p> : null}
        {terminalOffers.map((offer) => (
          <TerminalCommand
            key={offer.action}
            label={t('engines.action.terminalOnly', { action: t(ACTION_LABEL[offer.action]) })}
            command={offer.command}
            runCommand={offer.action === 'uninstall' ? null : runCommand}
            kind={offer.action}
          />
        ))}
        {notice ? <ActionNotice notice={notice} runCommand={runCommand} /> : null}
        {!runCommand ? <p className={SETTINGS_HELPER_CLASS}>{t('engines.terminal.unavailable')}</p> : null}
      </SettingsSection>

      {showLog ? <JobLogPanel log={log} /> : null}

      <SettingsSection title={t('engines.troubleshooting.title')} contentClassName="space-y-3">
        {diagnostics.map((row) => (
          <SettingsFieldRow key={row.label} label={row.label} alignEnd={false}>
            <code className="typography-meta min-w-0 whitespace-pre-wrap break-all font-mono">{row.value}</code>
          </SettingsFieldRow>
        ))}
        <div className="space-y-2">
          <span className={SETTINGS_HELPER_CLASS}>{t('engines.troubleshooting.commands')}</span>
          {troubleshootingCommands(snapshot).map((entry) => (
            <TerminalCommand key={entry.id} label={t(COMMAND_LABEL[entry.id])} command={entry.command} runCommand={entry.id === 'uninstall' ? null : runCommand} kind={entry.id} />
          ))}
        </div>
      </SettingsSection>

      {provider && provider.models.length > 0 ? <EngineModelsSection provider={provider} /> : null}

      {signingIn ? <EngineSignInDialog engine={engine} onClose={() => setSigningIn(false)} /> : null}

      <EngineUninstallDialog
        engineName={confirmUninstall ? status.displayName : null}
        onCancel={() => setConfirmUninstall(false)}
        onConfirm={(removeConfig) => {
          setConfirmUninstall(false);
          void startAction('uninstall', { removeConfig });
        }}
      />
    </SettingsPageLayout>
  );
};
