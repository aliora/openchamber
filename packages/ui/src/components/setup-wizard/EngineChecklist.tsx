import React from 'react';
import { Button } from '@/components/ui/button';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { EngineChecklist as Checklist, EngineId, EngineSnapshot, RowState } from './engineSetupModel';

type ActionKind = 'install' | 'update' | 'login';

type RowProps = {
  label: string;
  detail: string | null;
  state: RowState;
  serverAction: boolean;
  onAction: () => void;
  note: string | null;
};

const ACTION_LABEL: Record<ActionKind, I18nKey> = {
  install: 'engineSetup.action.install',
  update: 'engineSetup.action.update',
  login: 'engineSetup.action.login',
};

const STATE_MARK: Record<RowState['kind'], string> = { done: '✓', working: '…', pending: '·', action: '!' };

const CommandBox: React.FC<{ command: string }> = ({ command }) => {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void copyTextToClipboard(command).then((result) => {
      if (result.ok) setCopied(true);
    });
  };
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="typography-meta flex-1 truncate rounded bg-muted px-2 py-1">{command}</code>
      <Button size="sm" variant="outline" onClick={copy}>
        {copied ? t('engineSetup.action.copied') : t('engineSetup.action.copy')}
      </Button>
    </div>
  );
};

const hasServerAction = (engine: EngineId, state: RowState): boolean =>
  state.kind === 'action' && (state.action === 'login' ? engine !== 'antigravity' : state.command === null);

const ChecklistRow: React.FC<RowProps> = ({ label, detail, state, serverAction, onAction, note }) => {
  const { t } = useI18n();
  return (
    <div className="flex flex-col py-2">
      <div className="flex items-center gap-3">
        <span className="w-4 text-center">{STATE_MARK[state.kind]}</span>
        <span className="typography-ui-label flex-1">{label}</span>
        {detail ? <span className="typography-meta font-mono text-muted-foreground">{detail}</span> : null}
        {state.kind === 'action' && serverAction ? (
          <Button size="sm" onClick={onAction}>{t(ACTION_LABEL[state.action])}</Button>
        ) : null}
      </div>
      {state.kind === 'action' && state.command ? (
        <div className="ps-7">
          <span className="typography-meta text-muted-foreground">{t('engineSetup.runInTerminal')}</span>
          <CommandBox command={state.command} />
        </div>
      ) : null}
      {note ? <div className="typography-meta ps-7 text-muted-foreground">{note}</div> : null}
    </div>
  );
};

type EngineChecklistProps = {
  snapshot: EngineSnapshot;
  checklist: Checklist;
  modelCount: number;
  enterpriseMode: boolean;
  loginMessage: string | null;
  onInstall: () => void;
  onLogin: () => void;
};

export const EngineChecklist: React.FC<EngineChecklistProps> = ({
  snapshot,
  checklist,
  modelCount,
  enterpriseMode,
  loginMessage,
  onInstall,
  onLogin,
}) => {
  const { t } = useI18n();
  const { status } = snapshot;
  const versionDetail = status.version
    ? (status.updateAvailable && status.latestVersion
      ? t('engineSetup.version.available', { version: status.version, latest: status.latestVersion })
      : t('engineSetup.version.current', { version: status.version }))
    : null;
  const loginNote = enterpriseMode && snapshot.readiness === 'signed-out' ? t('engineSetup.enterpriseLogin') : loginMessage;
  return (
    <section className="rounded-xl border border-border p-4">
      <header className="flex items-center justify-between">
        <span className="typography-ui-header font-semibold">{status.displayName}</span>
        {modelCount > 0 ? <span className="typography-meta text-muted-foreground">{t('engineSetup.models', { count: modelCount })}</span> : null}
      </header>
      <ChecklistRow label={t('engineSetup.row.cli')} detail={null} state={checklist.cli} serverAction={hasServerAction(status.engine, checklist.cli)} onAction={onInstall} note={null} />
      <ChecklistRow label={t('engineSetup.row.version')} detail={versionDetail} state={checklist.version} serverAction={hasServerAction(status.engine, checklist.version)} onAction={onInstall} note={null} />
      <ChecklistRow label={t('engineSetup.row.login')} detail={null} state={checklist.login} serverAction={hasServerAction(status.engine, checklist.login)} onAction={onLogin} note={loginNote} />
      {status.state === 'failed' && status.lastError ? <div className="typography-meta text-destructive">{status.lastError}</div> : null}
    </section>
  );
};
