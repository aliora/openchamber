import type { SettingsCardTone } from '@/components/sections/shared/SettingsCards';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { PortableHostState } from '@/lib/settings/portable-diff';
import type { PortableCategory, PortableImportResult } from '@/lib/settings/portable-settings';

export type SyncLabel = { key: I18nKey; params?: I18nParams; tone: SettingsCardTone };

export const CATEGORY_TITLE = {
  mcp: 'settings.sync.category.mcp',
  agents: 'settings.sync.category.agents',
  commands: 'settings.sync.category.commands',
  skills: 'settings.sync.category.skills',
  gitIdentities: 'settings.sync.category.gitIdentities',
  projects: 'settings.sync.category.projects',
  scheduledTasks: 'settings.sync.category.scheduledTasks',
} satisfies Record<PortableCategory, I18nKey>;

const versionName = (version: number): string => String.fromCharCode(64 + Math.min(version, 26));

export const stateLabel = (state: PortableHostState): SyncLabel => {
  if (state.kind === 'unreachable') return { key: 'settings.sync.state.unreachable', tone: 'neutral' };
  if (state.kind === 'unknown') return { key: 'settings.sync.state.unknown', tone: 'warning' };
  if (state.kind === 'missing') return { key: 'settings.sync.state.missing', tone: 'warning' };
  if (state.newest) return { key: 'settings.sync.state.versionNewest', params: { version: versionName(state.version) }, tone: 'info' };
  return { key: 'settings.sync.state.version', params: { version: versionName(state.version) }, tone: 'neutral' };
};

const refusalLabel = (reason: string | undefined, fallback: I18nKey): I18nKey => {
  if (reason === 'project-missing') return 'settings.sync.result.projectMissing';
  if (reason === 'too-large') return 'settings.sync.result.tooLarge';
  if (reason === 'conflict') return 'settings.sync.result.conflict';
  if (reason === 'linked') return 'settings.sync.result.linked';
  return fallback;
};

export type SyncOutcome =
  | { kind: 'result'; result: PortableImportResult }
  | { kind: 'unreachable' }
  | { kind: 'not-exported'; reason: string };

export const outcomeLabel = (outcome: SyncOutcome): SyncLabel => {
  if (outcome.kind === 'unreachable') return { key: 'settings.sync.result.unreachable', tone: 'error' };
  if (outcome.kind === 'not-exported') {
    return { key: refusalLabel(outcome.reason, 'settings.sync.result.missing'), tone: 'warning' };
  }
  const { result } = outcome;
  if (result.status === 'applied' || result.status === 'removed') return { key: 'settings.sync.result.applied', tone: 'success' };
  if (result.status === 'unchanged') return { key: 'settings.sync.result.unchanged', tone: 'neutral' };
  if (result.status === 'skipped') return { key: 'settings.sync.result.skipped', tone: 'warning' };
  if (result.status === 'failed') return { key: 'settings.sync.result.failed', tone: 'error' };
  if (result.reason === 'path-missing') return { key: 'settings.sync.result.pathMissing', params: { path: result.path ?? '' }, tone: 'warning' };
  return { key: refusalLabel(result.reason, 'settings.sync.result.invalid'), tone: 'warning' };
};
