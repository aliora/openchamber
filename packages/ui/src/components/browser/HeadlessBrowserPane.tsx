import React from 'react';

import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { BLANK_URL } from '@/lib/browser/url';
import { registerBrowserController } from '@/lib/browser/controlClient';
import { suggestFromHistory } from '@/lib/browser/history';
import { selectBrowserHistory, useBrowserHistoryStore } from '@/stores/useBrowserHistoryStore';
import { FILL_VIEWPORT, viewportSize, type BrowserViewport } from '@/lib/browser/viewport';
import { createHeadlessActionRunner, normalizeHeadlessAddress } from '@/lib/browser/headlessActions';
import {
  closeHeadlessTab,
  createHeadlessCommandSender,
  headlessTabKey,
  openHeadlessStream,
  sendHeadlessInput,
  type HeadlessPageInfo,
  type HeadlessStreamMessage,
} from '@/lib/browser/headlessBrowserClient';
import { isBrowserShortcut, keyInput, mouseInput, toPagePoint, wheelInput } from '@/lib/browser/headlessInput';
import { cn } from '@/lib/utils';
import { BrowserEmptyState } from './BrowserEmptyState';
import { BrowserToolbar } from './BrowserToolbar';
import type { BrowserPaneProps } from './BrowserPane';

const FIT_DEBOUNCE_MS = 150;
const HOVER_INTERVAL_MS = 50;

type PageState = { url: string; title: string; loading: boolean };

const isTabOpen = (directory: string, tabID: string): boolean => (
  useUIStore.getState().contextPanelByDirectory[normalizeContextPanelDirectoryKey(directory)]?.tabs.some((tab) => tab.id === tabID) ?? false
);

export const HeadlessBrowser: React.FC<BrowserPaneProps> = ({ initialUrl, directory, tabID, ownerSessionId }) => {
  const { t } = useI18n();
  const tabDirectory = normalizeContextPanelDirectoryKey(directory);
  const key = React.useMemo(() => headlessTabKey(tabDirectory, tabID), [tabDirectory, tabID]);
  const send = React.useMemo(() => createHeadlessCommandSender(key), [key]);
  const setContextPanelTabTargetPath = useUIStore((state) => state.setContextPanelTabTargetPath);
  const recordHistoryVisit = useBrowserHistoryStore((state) => state.recordVisit);
  const forgetHistoryVisit = useBrowserHistoryStore((state) => state.forget);
  const visitedAddresses = useBrowserHistoryStore(selectBrowserHistory(directory));

  const startUrl = React.useMemo(() => {
    const normalized = normalizeHeadlessAddress(initialUrl);
    return normalized === BLANK_URL ? '' : normalized;
  }, [initialUrl]);
  const [address, setAddress] = React.useState(startUrl);
  const [page, setPage] = React.useState<PageState>({ url: '', title: '', loading: false });
  const [crashed, setCrashed] = React.useState(false);
  const [viewport, setViewport] = React.useState<BrowserViewport>(FILL_VIEWPORT);
  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const frameSizeRef = React.useRef({ width: 0, height: 0 });
  const frameSequenceRef = React.useRef(0);
  const lastHoverRef = React.useRef(0);
  const suggestions = React.useMemo(() => suggestFromHistory(visitedAddresses, address), [visitedAddresses, address]);

  const drawFrame = React.useCallback((message: Extract<HeadlessStreamMessage, { type: 'frame' }>) => {
    frameSequenceRef.current += 1;
    const sequence = frameSequenceRef.current;
    const image = new Image();
    image.onload = () => {
      const canvas = canvasRef.current;
      if (!canvas || sequence !== frameSequenceRef.current) return;
      if (canvas.width !== message.width || canvas.height !== message.height) {
        canvas.width = message.width;
        canvas.height = message.height;
      }
      frameSizeRef.current = { width: message.width, height: message.height };
      canvas.getContext('2d')?.drawImage(image, 0, 0);
    };
    image.src = `data:image/jpeg;base64,${message.data}`;
  }, []);

  const handleMeta = React.useCallback((meta: PageState) => {
    setPage(meta);
    setCrashed(false);
    if (!meta.url || meta.url === BLANK_URL) return;
    setAddress(meta.url);
    setContextPanelTabTargetPath(directory, tabID, meta.url);
    if (!meta.loading) recordHistoryVisit(directory, { url: meta.url, title: meta.title });
  }, [directory, recordHistoryVisit, setContextPanelTabTargetPath, tabID]);

  React.useEffect(() => openHeadlessStream(
    key,
    (message) => {
      if (message.type === 'frame') drawFrame(message);
      else if (message.type === 'meta') handleMeta({ url: message.url, title: message.title, loading: message.loading });
      else if (message.type === 'crashed') setCrashed(true);
    },
    () => undefined,
  ), [drawFrame, handleMeta, key]);

  const navigate = React.useCallback((value: string) => {
    const next = normalizeHeadlessAddress(value);
    if (next === BLANK_URL) return;
    setAddress(next);
    void send({ command: 'navigate', url: next }).catch(() => undefined);
  }, [send]);

  React.useEffect(() => {
    if (!startUrl) return;
    let active = true;
    void send<HeadlessPageInfo>({ command: 'info' })
      .then((info) => {
        if (active && (!info.url || info.url === BLANK_URL)) navigate(startUrl);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [navigate, send, startUrl]);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fit = () => {
      if (viewportRef.current.kind !== 'fill') return;
      const rect = stage.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void send({ command: 'fit', width: rect.width, height: rect.height }).catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fit, FIT_DEBOUNCE_MS);
    });
    observer.observe(stage);
    fit();
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [send]);

  const reveal = React.useCallback(() => {
    useUIStore.getState().setActiveContextPanelTab(directory, tabID);
  }, [directory, tabID]);

  React.useEffect(() => {
    if (ownerSessionId && startUrl) reveal();
  }, [ownerSessionId, reveal, startUrl]);

  const runAction = React.useMemo(() => createHeadlessActionRunner({
    send,
    reveal,
    getViewport: () => viewportRef.current,
    setViewport: (next) => {
      viewportRef.current = next;
      setViewport(next);
    },
  }), [reveal, send]);

  const describeTab = React.useCallback(() => ({ title: pageRef.current.title, url: pageRef.current.url }), []);

  React.useEffect(() => registerBrowserController({
    tabId: tabID,
    directory: tabDirectory,
    ownerSessionId,
    describe: describeTab,
    run: runAction,
  }), [describeTab, ownerSessionId, runAction, tabDirectory, tabID]);

  React.useEffect(() => () => {
    if (!isTabOpen(directory, tabID)) void closeHeadlessTab(key);
  }, [directory, key, tabID]);

  const pagePoint = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    return canvas ? toPagePoint(canvas.getBoundingClientRect(), frameSizeRef.current, clientX, clientY) : null;
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    stageRef.current?.focus();
    void sendHeadlessInput(key, mouseInput('down', point, event));
  };
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pagePoint(event.clientX, event.clientY);
    if (point) void sendHeadlessInput(key, mouseInput('up', point, event));
  };
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const now = Date.now();
    if (now - lastHoverRef.current < HOVER_INTERVAL_MS) return;
    lastHoverRef.current = now;
    const point = pagePoint(event.clientX, event.clientY);
    if (point) void sendHeadlessInput(key, mouseInput('move', point, event));
  };
  const onKey = (type: 'down' | 'up') => (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || isBrowserShortcut(event)) return;
    event.preventDefault();
    void sendHeadlessInput(key, keyInput(type, {
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    }));
  };
  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const text = event.clipboardData.getData('text');
    if (!text) return;
    event.preventDefault();
    void sendHeadlessInput(key, { kind: 'text', text });
  };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      const box = canvas.getBoundingClientRect();
      const point = toPagePoint(box, frameSizeRef.current, event.clientX, event.clientY);
      if (!point) return;
      event.preventDefault();
      void sendHeadlessInput(key, wheelInput(point, event));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [key]);

  const size = viewportSize(viewport);
  const showEmpty = !startUrl && !page.url && !page.loading;

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <BrowserToolbar
        address={address}
        onAddressChange={setAddress}
        onSubmit={navigate}
        suggestions={suggestions}
        onForgetSuggestion={(url) => forgetHistoryVisit(directory, url)}
        onBack={() => void send({ command: 'history', direction: 'back' }).catch(() => undefined)}
        onForward={() => void send({ command: 'history', direction: 'forward' }).catch(() => undefined)}
        onReload={() => void send({ command: 'reload' }).catch(() => undefined)}
        onOpenExternal={() => void openExternalUrl(page.url || address)}
        canGoBack
        canGoForward
        isLoading={page.loading}
      />
      <div
        ref={stageRef}
        tabIndex={0}
        role="application"
        aria-label={t('contextPanel.browser.frameTitle')}
        onKeyDown={onKey('down')}
        onKeyUp={onKey('up')}
        onPaste={onPaste}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-background outline-none',
          size && 'bg-[var(--surface-muted)]',
        )}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onContextMenu={(event) => event.preventDefault()}
          className={cn('max-h-full max-w-full touch-none select-none', !page.url && 'hidden')}
        />
        {showEmpty ? <BrowserEmptyState onOpen={navigate} directory={directory} /> : null}
        {crashed ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <span className="typography-ui-header text-foreground">{t('contextPanel.browser.crashed')}</span>
            <span className="typography-micro text-muted-foreground">{t('contextPanel.browser.crashedHint')}</span>
          </div>
        ) : null}
        {page.loading ? (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
            <div className="h-full w-1/3 animate-[browser-progress_1.1s_ease-in-out_infinite] bg-[var(--primary)]" />
          </div>
        ) : null}
      </div>
    </div>
  );
};
