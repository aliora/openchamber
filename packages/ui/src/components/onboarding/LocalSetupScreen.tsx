import React from 'react';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const WINDOWS_INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
const DOCS_URL = 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview';

type OnboardingPlatform = 'macos' | 'linux' | 'windows' | 'unknown';

type LocalSetupScreenProps = {
  /** Callback when user goes back */
  onBack: () => void;
  /** Callback when CLI becomes available */
  onCliAvailable?: () => void;
  /** Whether this screen was entered from recovery flow (shows "Connect to Remote" link) */
  isFromRecovery?: boolean;
  /** Callback when user wants to switch to remote */
  onSwitchToRemote?: () => void;
};

function InstallCommand({ onCopy, copyTitle }: { onCopy: () => void; copyTitle: string }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <code className="flex-1 min-w-0 text-start overflow-x-auto whitespace-nowrap">
        <span style={{ color: 'var(--syntax-keyword)' }}>npm</span>
        <span className="text-muted-foreground"> install -g </span>
        <span style={{ color: 'var(--syntax-string)' }}>@anthropic-ai/claude-code</span>
      </code>
      <button
        onClick={onCopy}
        className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
        title={copyTitle}
        aria-label={copyTitle}
      >
        <Icon name="file-copy" className="h-4 w-4" />
      </button>
    </div>
  );
}

const HINT_DELAY_MS = 30000;

export function LocalSetupScreen({
  onBack,
  onCliAvailable,
  isFromRecovery = false,
  onSwitchToRemote,
}: LocalSetupScreenProps) {
  const { t } = useI18n();
  const [copied, setCopied] = React.useState(false);
  const [showHint, setShowHint] = React.useState(false);
  const [isDesktopApp, setIsDesktopApp] = React.useState(false);
  const [isChecking, setIsChecking] = React.useState(false);
  const [checkError, setCheckError] = React.useState<string | null>(null);
  const [platform, setPlatform] = React.useState<OnboardingPlatform>('unknown');

  React.useEffect(() => {
    const timer = setTimeout(() => setShowHint(true), HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  React.useEffect(() => {
    setIsDesktopApp(isDesktopShell());
  }, []);

  React.useEffect(() => {
    if (typeof navigator === 'undefined') {
      setPlatform('unknown');
      return;
    }

    const ua = navigator.userAgent || '';
    if (/Windows/i.test(ua)) {
      setPlatform('windows');
      return;
    }
    if (/Macintosh|Mac OS X/i.test(ua)) {
      setPlatform('macos');
      return;
    }
    if (/Linux/i.test(ua)) {
      setPlatform('linux');
      return;
    }
    setPlatform('unknown');
  }, []);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, a, input, select, textarea, code')) {
      return;
    }
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

  const handleCopy = React.useCallback(async () => {
    const result = await copyTextToClipboard(platform === 'windows' ? WINDOWS_INSTALL_COMMAND : INSTALL_COMMAND);
    if (result.ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      console.error('Failed to copy:', result.error);
    }
  }, [platform]);

  const handleCheckAndContinue = React.useCallback(async () => {
    setIsChecking(true);
    setCheckError(null);
    try {
      const available = await checkCliAvailability();
      if (available) {
        // CLI is available, proceed to main screen
        onCliAvailable?.();
      } else {
        setCheckError(t('onboarding.localSetup.errors.cliNotReady'));
      }
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : t('onboarding.localSetup.errors.detectionFailed'));
    } finally {
      setIsChecking(false);
    }
  }, [checkCliAvailability, onCliAvailable, t]);

  const docsUrl = DOCS_URL;

  return (
    <div
      className="h-full flex items-center justify-center bg-transparent p-8 relative cursor-default select-none"
      onMouseDown={handleDragStart}
    >
      <div className="w-full max-w-lg space-y-4 text-center">
        <div className="flex items-center">
          <Button
            variant="ghost"
            onClick={onBack}
            className="p-0 text-muted-foreground hover:text-foreground"
          >
            {t('onboarding.common.actions.back')}
          </Button>
        </div>

        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            {t('onboarding.localSetup.title')}
          </h1>
          <p className="text-muted-foreground">
            {t('onboarding.localSetup.description')}
          </p>
        </div>

        {platform === 'windows' && (
          <div className="mx-auto max-w-2xl rounded-lg border border-border bg-background/50 p-4 text-start">
            <div className="text-sm text-foreground">{t('onboarding.localSetup.windows.title')}</div>
            <ol className="mt-2 list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
              <li>{t('onboarding.localSetup.windows.stepRunInstallInWsl')}</li>
            </ol>
          </div>
        )}

        <div className="flex justify-center">
          <div className="bg-background/60 backdrop-blur-sm border border-border rounded-lg px-5 py-3 font-mono text-sm w-fit">
            {copied ? (
              <div className="flex items-center justify-center gap-2" style={{ color: 'var(--status-success)' }}>
                <Icon name="check" className="h-4 w-4" />
                {t('onboarding.common.status.copiedToClipboard')}
              </div>
            ) : (
              <InstallCommand onCopy={handleCopy} copyTitle={t('onboarding.common.copyToClipboard')} />
            )}
          </div>
        </div>

        <a
          href={docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1 justify-center"
        >
          {platform === 'windows' ? t('onboarding.localSetup.docs.windows') : t('onboarding.localSetup.docs.default')}
          <Icon name="external-link" className="h-3 w-3" />
        </a>

        {checkError && (
          <div className="mx-auto max-w-md rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {checkError}
          </div>
        )}

        <div className="space-y-3">
          <Button
            type="button"
            onClick={handleCheckAndContinue}
            disabled={isChecking}
            className="w-full max-w-xs"
            size="lg"
          >
            {isChecking ? t('onboarding.localSetup.actions.checking') : t('onboarding.localSetup.actions.checkAndContinue')}
          </Button>

          <p className="text-xs text-muted-foreground">
            {t('onboarding.localSetup.helper.checkAndContinue')}
          </p>
        </div>

        {isFromRecovery && onSwitchToRemote && (
          <div className="text-center pt-4">
            <p className="text-sm text-muted-foreground mb-2">
              {t('onboarding.localSetup.remotePreference')}
            </p>
            <Button
              variant="link"
              onClick={onSwitchToRemote}
            >
              {t('onboarding.localSetup.actions.connectRemoteServer')}
            </Button>
          </div>
        )}
      </div>

      {showHint && (
        <div className="absolute bottom-8 inset-s-0 inset-e-0 text-center space-y-1">
          <p className="text-sm text-muted-foreground/70">
            {t('onboarding.localSetup.hint.engineSetup')}
          </p>
          <p className="text-sm text-muted-foreground/70">
            {t('onboarding.localSetup.hint.missingRuntime')}
          </p>
        </div>
      )}
    </div>
  );
}
