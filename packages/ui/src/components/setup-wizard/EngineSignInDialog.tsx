import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { copyTextToClipboard, readClipboardText } from '@/lib/clipboard';
import type { HostRuntime } from '@/lib/hosts/runtime/types';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { useEngineReadinessStore } from '@/stores/useEngineReadinessStore';
import { useScopedHostRuntime } from '@/components/sections/providers/engineHost';
import { CommandBox } from './CommandBox';
import {
  cancelEngineLogin,
  failedLogin,
  fetchEngineLogin,
  sendEngineLoginInput,
  startEngineLogin,
  type EngineLogin,
  type EngineLoginState,
} from './engineSetupApi';
import { engineLoginCommand, type EngineId } from './engineSetupModel';
import { useEngineSetupStore } from './useEngineSetupStore';

const POLL_MS = 1500;

const ENGINE_NAME = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' } satisfies Record<EngineId, string>;

const STATUS_TEXT = {
  idle: 'engines.signInDialog.failed',
  starting: 'engines.signInDialog.starting',
  waiting: 'engines.signInDialog.waiting',
  succeeded: 'engines.signInDialog.succeeded',
  failed: 'engines.signInDialog.failed',
  cancelled: 'engines.signInDialog.cancelled',
} satisfies Record<EngineLoginState, I18nKey>;

const isActiveLogin = (login: EngineLogin | null): boolean => login === null || login.state === 'starting' || login.state === 'waiting';

const toMessage = (error: unknown): string | null => (error instanceof Error ? error.message : null);

const refreshEngineState = (host: HostRuntime, engine: EngineId) => host.run(() => {
  const setup = useEngineSetupStore.getState();
  void setup.refresh();
  void setup.refreshAuth(engine);
  void useEngineReadinessStore.getState().refresh();
});

const useEngineLogin = (host: HostRuntime, engine: EngineId, attempt: number): EngineLogin | null => {
  const [login, setLogin] = React.useState<EngineLogin | null>(null);

  React.useEffect(() => {
    let disposed = false;
    let timer: number | undefined;
    setLogin(null);
    const apply = (next: EngineLogin) => {
      if (disposed) return;
      setLogin(next);
      if (!isActiveLogin(next)) {
        refreshEngineState(host, engine);
        return;
      }
      timer = window.setTimeout(() => {
        void host.run(() => fetchEngineLogin(engine)).then(apply, () => apply(next));
      }, POLL_MS);
    };
    void host.run(() => startEngineLogin(engine)).then(apply, (error: unknown) => apply(failedLogin(toMessage(error))));
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [engine, attempt, host]);

  return login;
};

type EngineSignInPanelProps = {
  login: EngineLogin | null;
  fallbackCommand: string;
  draft: string;
  sending: boolean;
  onDraftChange: (value: string) => void;
  onPaste: () => void;
  onSubmit: () => void;
  onOpenUrl: (url: string) => void;
  onCopy: (text: string, kind: 'link' | 'code') => void;
};

export const EngineSignInPanel: React.FC<EngineSignInPanelProps> = ({
  login,
  fallbackCommand,
  draft,
  sending,
  onDraftChange,
  onPaste,
  onSubmit,
  onOpenUrl,
  onCopy,
}) => {
  const { t } = useI18n();
  const inputId = React.useId();
  const outputRef = React.useRef<HTMLPreElement | null>(null);
  const outputTail = login?.outputTail ?? '';
  const scrollOutputToEnd = React.useCallback(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, []);
  React.useEffect(scrollOutputToEnd, [outputTail, scrollOutputToEnd]);
  const state = login?.state ?? 'starting';
  const active = isActiveLogin(login);
  const succeeded = state === 'succeeded';
  const url = active ? login?.url ?? null : null;
  const code = active ? login?.code ?? null : null;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-start gap-2 typography-small">
        {active ? <Icon name="loader-4" className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        {succeeded ? <Icon name="checkbox-circle" className="mt-0.5 size-4 shrink-0 text-[var(--status-success)]" /> : null}
        {!active && !succeeded ? <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" /> : null}
        <div className="min-w-0 flex-1">
          <p className={cn(active ? 'text-muted-foreground' : 'text-foreground')}>{t(STATUS_TEXT[state])}</p>
          {!active && login?.message ? <p className="break-words text-muted-foreground">{login.message}</p> : null}
        </div>
      </div>

      {url ? (
        <div className="flex gap-2">
          <Button size="lg" className="h-11 min-w-0 flex-1" onClick={() => onOpenUrl(url)}>
            <Icon name="external-link" className="size-4" />
            {t('engines.signInDialog.openPage')}
          </Button>
          <Button size="lg" variant="outline" className="h-11 shrink-0" aria-label={t('engines.signInDialog.copyLink')} title={t('engines.signInDialog.copyLink')} onClick={() => onCopy(url, 'link')}>
            <Icon name="file-copy" className="size-4" />
          </Button>
        </div>
      ) : null}

      {code ? (
        <div className="flex flex-col gap-1.5">
          <span className="typography-meta text-muted-foreground">{t('engines.signInDialog.deviceCode')}</span>
          <div className="flex items-center gap-2">
            <code className="typography-ui-header min-w-0 flex-1 select-all rounded-lg bg-muted px-3 py-2 text-center font-mono tracking-widest">{code}</code>
            <Button variant="outline" className="h-10 shrink-0" onClick={() => onCopy(code, 'code')}>{t('engines.signInDialog.copyCode')}</Button>
          </div>
        </div>
      ) : null}

      {active ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <label htmlFor={inputId} className="typography-ui-label">{t('engines.signInDialog.codeLabel')}</label>
          <span className="typography-meta -mt-1 text-muted-foreground">
            {t(login?.needsInput ? 'engines.signInDialog.codeHintNeeded' : 'engines.signInDialog.codeHintOptional')}
          </span>
          <Input
            id={inputId}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder={t('engines.signInDialog.codePlaceholder')}
            enterKeyHint="send"
            className="h-10 font-mono"
          />
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="h-10 flex-1" onClick={onPaste}>
              <Icon name="clipboard" className="size-4" />
              {t('engines.signInDialog.paste')}
            </Button>
            <Button type="submit" className="h-10 flex-1" disabled={sending || !draft.trim()}>{t('engines.signInDialog.submit')}</Button>
          </div>
        </form>
      ) : null}

      {!active && !succeeded ? (
        <div className="min-w-0">
          <span className="typography-meta text-muted-foreground">{t('engines.signInDialog.fallback')}</span>
          <CommandBox command={fallbackCommand} />
        </div>
      ) : null}

      {outputTail ? (
        <details className="min-w-0" onToggle={scrollOutputToEnd}>
          <summary className="cursor-pointer typography-meta text-muted-foreground">{t('engines.signInDialog.rawOutput')}</summary>
          <pre ref={outputRef} className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-4 text-muted-foreground">{outputTail}</pre>
        </details>
      ) : null}
    </div>
  );
};

type EngineSignInDialogProps = { engine: EngineId; onClose: () => void };

export const EngineSignInDialog: React.FC<EngineSignInDialogProps> = ({ engine, onClose }) => {
  const { t } = useI18n();
  const snapshot = useEngineSetupStore((state) => state.snapshots.get(engine));
  const host = useScopedHostRuntime();
  const [attempt, setAttempt] = React.useState(0);
  const login = useEngineLogin(host, engine, attempt);
  const [draft, setDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const active = isActiveLogin(login);
  const engineName = snapshot?.status.displayName ?? ENGINE_NAME[engine];

  const close = () => {
    if (active) void host.run(() => cancelEngineLogin(engine));
    onClose();
  };

  const paste = () => {
    readClipboardText()
      .then((text) => setDraft(text.trim()))
      .catch(() => toast.error(t('engines.signInDialog.pasteFailed')));
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    host.run(() => sendEngineLoginInput(engine, text))
      .then((result) => {
        if (result.ok) setDraft('');
        else toast.error(t('engines.signInDialog.failed'), { description: result.message ?? undefined });
      })
      .catch((error: unknown) => toast.error(t('engines.signInDialog.failed'), { description: toMessage(error) ?? undefined }))
      .finally(() => setSending(false));
  };

  const openUrl = (url: string) => {
    void openExternalUrl(url).then((opened) => {
      if (!opened) toast.error(t('engines.signInDialog.openFailed'));
    });
  };

  const copy = (text: string, kind: 'link' | 'code') => {
    void copyTextToClipboard(text).then((result) => {
      if (!result.ok) toast.error(t('engines.signInDialog.copyFailed'));
      else toast.success(t(kind === 'link' ? 'engines.signInDialog.linkCopied' : 'engines.signInDialog.codeCopied'));
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent ref={popupRef} initialFocus={popupRef} className="max-w-md" layerClassName="z-[70]" backdropProps={{ className: 'z-[70]' }}>
        <DialogHeader>
          <DialogTitle>{t('engines.signInDialog.title', { engine: engineName })}</DialogTitle>
          <DialogDescription>{t('engines.signInDialog.description')}</DialogDescription>
        </DialogHeader>
        <EngineSignInPanel
          login={login}
          fallbackCommand={engineLoginCommand(engine, snapshot)}
          draft={draft}
          sending={sending}
          onDraftChange={setDraft}
          onPaste={paste}
          onSubmit={submit}
          onOpenUrl={openUrl}
          onCopy={copy}
        />
        <DialogFooter>
          {active ? <Button variant="outline" onClick={close}>{t('engines.signInDialog.cancel')}</Button> : null}
          {!active && login?.state !== 'succeeded' ? (
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>{t('engines.signInDialog.retry')}</Button>
          ) : null}
          {!active ? <Button onClick={onClose}>{t('engines.signInDialog.done')}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
