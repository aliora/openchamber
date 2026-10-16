import React from 'react';
import { useI18n } from '@/lib/i18n';

interface CliSignInHintProps {
  /** Product name of the CLI whose login is missing, e.g. `Claude Code`. */
  cli: string;
  /** Terminal command that signs the CLI in. */
  command: string;
}

/**
 * Usage reads the login an engine's own CLI keeps on the server machine, so the
 * fix for a missing one is signing that CLI in again. Shown inside the warning
 * banner of a provider that reports not configured.
 */
export const CliSignInHint: React.FC<CliSignInHintProps> = ({ cli, command }) => {
  const { t } = useI18n();
  return (
    <>
      <p className="typography-ui-label font-medium text-[var(--status-warning)]">{t('settings.usage.page.state.signedOutTitle', { cli })}</p>
      <div className="mt-1 space-y-1.5">
        <p className="typography-meta text-[var(--status-warning)]/80">{t('settings.usage.page.state.signInCommand')}</p>
        <code className="typography-code block whitespace-pre-wrap break-all rounded bg-muted/50 px-2 py-1.5 text-xs text-foreground">{command}</code>
      </div>
    </>
  );
};
