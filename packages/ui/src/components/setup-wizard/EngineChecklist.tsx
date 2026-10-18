import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { CommandBox } from './CommandBox';
import type { EngineChecklist as Checklist, EngineSnapshot, RowState } from './engineSetupModel';

type ServerActionKind = 'install' | 'update';

export type RunCommand = (command: string, kind: 'install' | 'update' | 'login') => void;

type RowProps = {
  label: string;
  detail: string | null;
  state: RowState;
  onAction?: () => void;
  onRun: RunCommand | null;
  note: string | null;
};

const ACTION_LABEL: Record<ServerActionKind, I18nKey> = {
  install: 'engineSetup.action.install',
  update: 'engineSetup.action.update',
};

const STATE_MARK: Record<RowState['kind'], string> = { done: '✓', working: '…', pending: '·', action: '!' };

const ChecklistRow: React.FC<RowProps> = ({ label, detail, state, onAction, onRun, note }) => {
  const { t } = useI18n();
  const command = state.kind === 'action' ? state.command : null;
  return (
    <div className="flex flex-col py-2">
      <div className="flex items-center gap-3">
        <span className="w-4 text-center">{STATE_MARK[state.kind]}</span>
        <span className="typography-ui-label flex-1">{label}</span>
        {detail ? <span className="typography-meta font-mono text-muted-foreground">{detail}</span> : null}
        {state.kind === 'action' && state.action !== 'login' && state.command === null && onAction ? (
          <Button size="sm" onClick={onAction}>{t(ACTION_LABEL[state.action])}</Button>
        ) : null}
      </div>
      {state.kind === 'action' && command ? (
        <div className="ps-7">
          <span className="typography-meta text-muted-foreground">{t('engineSetup.runInTerminal')}</span>
          <CommandBox
            command={command}
            onRun={onRun ? () => onRun(command, state.action) : undefined}
            runLabel={t('engines.action.runInTerminal')}
          />
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
  onInstall: () => void;
  onUpdate: () => void;
  onRun: RunCommand | null;
};

export const EngineChecklist: React.FC<EngineChecklistProps> = ({
  snapshot,
  checklist,
  modelCount,
  enterpriseMode,
  onInstall,
  onUpdate,
  onRun,
}) => {
  const { t } = useI18n();
  const { status } = snapshot;
  const versionDetail = status.version
    ? (status.updateAvailable && status.latestVersion
      ? t('engineSetup.version.available', { version: status.version, latest: status.latestVersion })
      : t('engineSetup.version.current', { version: status.version }))
    : null;
  const loginNote = enterpriseMode && snapshot.readiness === 'signed-out'
    ? t('engineSetup.enterpriseLogin')
    : checklist.login.kind === 'action' && status.engine === 'antigravity' ? t('engines.signIn.agyLogin') : null;
  return (
    <section className="rounded-xl border border-border p-4">
      <header className="flex items-center justify-between">
        <span className="typography-ui-header font-semibold">{status.displayName}</span>
        {modelCount > 0 ? <span className="typography-meta text-muted-foreground">{t('engineSetup.models', { count: modelCount })}</span> : null}
      </header>
      <ChecklistRow label={t('engineSetup.row.cli')} detail={null} state={checklist.cli} onAction={onInstall} onRun={onRun} note={null} />
      <ChecklistRow label={t('engineSetup.row.version')} detail={versionDetail} state={checklist.version} onAction={onUpdate} onRun={onRun} note={null} />
      <ChecklistRow label={t('engineSetup.row.login')} detail={null} state={checklist.login} onRun={onRun} note={loginNote} />
      {status.state === 'failed' && status.lastError ? <div className="typography-meta text-destructive">{status.lastError}</div> : null}
    </section>
  );
};
