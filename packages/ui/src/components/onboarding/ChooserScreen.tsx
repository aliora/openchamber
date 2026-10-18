import { OpenChamberLogo } from '@/components/ui/OpenChamberLogo';
import React from 'react';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn } from '@/lib/utils';
import { RemoteConnectionForm } from './RemoteConnectionForm';
import { desktopHostsGet, desktopHostsSet } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const WINDOWS_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const DOCS_URL = 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview';
const POLL_INTERVAL_MS = 2500;

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type ChooserScreenProps = {
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
  localAvailable?: boolean;
};

function InstallCommand({ onCopy, copyTitle }: { onCopy: () => void; copyTitle: string }) {
  return (
    <div className="flex items-center justify-between gap-3 w-full">
      <code className="flex-1 min-w-0 text-start overflow-x-auto whitespace-nowrap">
        <span style={{ color: 'var(--syntax-keyword)' }}>npm</span>
        <span className="text-muted-foreground"> install -g </span>
        <span style={{ color: 'var(--syntax-string)' }}>@anthropic-ai/claude-code</span>
      </code>
      <button
        onClick={onCopy}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors shrink-0"
        title={copyTitle}
        aria-label={copyTitle}
      >
        <Icon name="file-copy" className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ChooserScreen({ onCliAvailable, localAvailable = true }: ChooserScreenProps) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isManualChecking, setIsManualChecking] = React.useState(false);
  const [platform, setPlatform] = React.useState<OnboardingPlatform>('unknown');
  const [activeTab, setActiveTab] = React.useState<'local' | 'remote'>(() => localAvailable ? 'local' : 'remote');
  const [troubleOpen, setTroubleOpen] = React.useState(false);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') {
      setPlatform('unknown');
      return;
    }

    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) setPlatform('windows');
    else if (/Macintosh|Mac OS X/i.test(ua)) setPlatform('macos');
    else if (/Linux/i.test(ua)) setPlatform('linux');
    else setPlatform('unknown');
  }, []);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) return;
    if (target.closest('button, a, input, select, textarea, code, summary, details')) return;
    if (e.button !== 0) return;
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const checkCliAvailability = React.useCallback(async (): Promise<boolean> => {
    try {
      const response = await runtimeFetch('/health');
      if (!response.ok) return false;
      const data = await response.json();
      return data.openCodeRunning === true || data.isOpenCodeReady === true;
    } catch {
      return false;
    }
  }, []);

  const persistFirstChoice = React.useCallback(async (choice: 'local' | 'remote') => {
    if (!isDesktopApp) return;

    const config = await desktopHostsGet();
    await desktopHostsSet({
      ...config,
      ...(choice === 'local' ? { defaultHostId: 'local' } : {}),
      initialHostChoiceCompleted: true,
    });
  }, [isDesktopApp]);

  const announceAvailable = React.useCallback(async () => {
    if (isDesktopApp) {
      await persistFirstChoice('local');
    }
    onCliAvailable?.();
  }, [isDesktopApp, onCliAvailable, persistFirstChoice]);

  // Background polling: while the local tab is visible, periodically check
  // whether the OpenCode CLI is reachable. As soon as it is, transition
  // automatically — the user doesn't have to click anything.
  React.useEffect(() => {
    if (!localAvailable || activeTab !== 'local') return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const available = await checkCliAvailability();
        if (cancelled) return;
        if (available) {
          await announceAvailable();
          return;
        }
      } catch {
        // ignore
      }
      if (!cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };

    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeTab, checkCliAvailability, announceAvailable, localAvailable]);

  const handleManualCheck = React.useCallback(async () => {
    setIsManualChecking(true);
    try {
      const available = await checkCliAvailability();
      if (available) await announceAvailable();
    } finally {
      setIsManualChecking(false);
    }
  }, [checkCliAvailability, announceAvailable]);

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(platform === 'windows' ? WINDOWS_INSTALL_COMMAND : INSTALL_COMMAND);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy:', result.error);
    }
  }, [platform]);

  const docsUrl = DOCS_URL;

  const showLocal = localAvailable && (!isDesktopApp || activeTab === 'local');

  return (
    <div
      className="app-region-drag h-full flex items-center justify-center bg-transparent p-8 cursor-default select-none overflow-y-auto"
      onMouseDown={handleDragStart}
    >
      <div className="w-full max-w-md">
        <header className="flex flex-col items-center text-center">
          <OpenChamberLogo width={48} height={48} />
          <h1 className="mt-6 text-xl font-semibold tracking-tight text-foreground">
            {t('onboarding.chooser.title')}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('onboarding.chooser.description')}
          </p>
        </header>

        {isDesktopApp && localAvailable && (
          <div role="tablist" className="app-region-no-drag mt-7 flex gap-1 rounded-lg border border-border p-1">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'local'}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm transition-colors',
                activeTab === 'local'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setActiveTab('local')}
            >
              {t('onboarding.chooser.tabs.localInstall')}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'remote'}
              className={cn(
                'flex-1 rounded-md px-3 py-1.5 text-sm transition-colors',
                activeTab === 'remote'
                  ? 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                  : 'text-muted-foreground hover:text-foreground'
              )}
              onClick={() => setActiveTab('remote')}
            >
              {t('onboarding.chooser.tabs.connectRemote')}
            </button>
          </div>
        )}

        {isDesktopApp && activeTab === 'remote' ? (
          <div className="app-region-no-drag mt-6">
            <RemoteConnectionForm
              onBack={() => localAvailable && setActiveTab('local')}
              showBackButton={false}
              showInstancePicker={!localAvailable}
              onSwitchToLocal={localAvailable ? () => setActiveTab('local') : undefined}
            />
          </div>
        ) : null}

        {showLocal && (
          <div className="mt-6">
            {platform === 'windows' && (
              <div className="mb-4 rounded-lg border border-border p-4">
                <div className="text-sm text-foreground">{t('onboarding.localSetup.windows.title')}</div>
                <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
                  <li>{t('onboarding.localSetup.windows.stepRunInstallInWsl')}</li>
                </ol>
              </div>
            )}

            <p className="text-center text-sm leading-relaxed text-muted-foreground text-balance">
              {t('onboarding.localSetup.intro')}
            </p>

            <div className="app-region-no-drag mt-3 rounded-lg border border-border bg-background/60 px-4 py-3 font-mono text-sm">
              {copied ? (
                <div className="flex items-center gap-2" style={{ color: 'var(--status-success)' }}>
                  <Icon name="check" className="h-4 w-4" />
                  {t('onboarding.common.status.copiedToClipboard')}
                </div>
              ) : (
                <InstallCommand onCopy={handleCopy} copyTitle={t('onboarding.common.copyToClipboard')} />
              )}
            </div>

            <div className="app-region-no-drag mt-3 flex items-center gap-2.5 px-1" role="status" aria-live="polite">
              <span className="relative inline-flex h-2 w-2 shrink-0" aria-hidden>
                <span
                  className="absolute inset-0 rounded-full"
                  style={{ backgroundColor: 'var(--primary-base)', animation: 'pulse-opacity 1.6s ease-in-out infinite' }}
                />
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                <span className="text-foreground">{t('onboarding.localSetup.status.watching')}</span>
                {' · '}
                {t('onboarding.localSetup.status.autoContinue')}
              </span>
              <button
                type="button"
                onClick={handleManualCheck}
                disabled={isManualChecking}
                className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                {isManualChecking ? t('onboarding.localSetup.actions.checking') : t('onboarding.localSetup.actions.checkNow')}
              </button>
            </div>

            <div className="mt-6 divide-y divide-border/60 border-y border-border/60">
              <details
                className="app-region-no-drag group"
                open={troubleOpen}
                onToggle={(e) => setTroubleOpen(e.currentTarget.open)}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between py-3 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <span>{t('onboarding.localSetup.troubleshoot.title')}</span>
                  <Icon name="arrow-down-s" className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <ul className="list-disc space-y-1.5 pb-4 ps-4 text-xs text-muted-foreground">
                  <li>{t('onboarding.localSetup.hint.engineSetup')}</li>
                  <li>{t('onboarding.localSetup.hint.missingRuntime')}</li>
                </ul>
              </details>
            </div>

            <div className="app-region-no-drag mt-5 text-center">
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {platform === 'windows' ? t('onboarding.localSetup.docs.windows') : t('onboarding.localSetup.docs.default')}
                <Icon name="external-link" className="h-3 w-3" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
