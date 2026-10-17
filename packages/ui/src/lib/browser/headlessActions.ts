import {
  buildClickScript,
  buildInspectScript,
  buildScrollScript,
  buildSnapshotScript,
  buildTypeScript,
} from './pageActions';
import { normalizeBrowserUrl } from './url';
import type { HeadlessCommandSender, HeadlessPageInfo } from './headlessBrowserClient';
import {
  isViewportMode,
  viewportForMode,
  viewportSize,
  viewportSummary,
  type BrowserViewport,
} from './viewport';

const POST_ACTION_PAUSE_MS = 150;
const OPEN_TIMEOUT_MS = 25_000;
const FILE_URL_PATTERN = /^file:\/\//i;

type PageNavigation = { url: string; title: string; settled?: boolean };

export type HeadlessActionHost = {
  readonly send: HeadlessCommandSender;
  readonly getViewport: () => BrowserViewport;
  readonly setViewport: (viewport: BrowserViewport) => void;
  readonly reveal?: () => void;
  readonly pause?: (ms: number) => Promise<void>;
};

const defaultPause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const optionalString = (value: unknown): string | undefined => (
  typeof value === 'string' && value ? value : undefined
);

const viewportCommand = (viewport: BrowserViewport) => {
  const size = viewportSize(viewport);
  return size
    ? { command: 'viewport', fill: false, width: size.width, height: size.height } as const
    : { command: 'viewport', fill: true } as const;
};

const scriptFor = (action: string, parameters: Record<string, unknown>): string | null => {
  switch (action) {
    case 'browser.snapshot':
      return buildSnapshotScript({ selector: optionalString(parameters.selector) });
    case 'browser.click':
      return buildClickScript({ selector: optionalString(parameters.selector), text: optionalString(parameters.text), locateOnly: true });
    case 'browser.type':
      return buildTypeScript({
        selector: String(parameters.selector ?? ''),
        value: String(parameters.value ?? ''),
        submit: parameters.submit === true,
        focusOnly: true,
      });
    case 'browser.inspect':
      return buildInspectScript({ selector: String(parameters.selector ?? '') });
    case 'browser.scroll':
      return buildScrollScript({
        selector: optionalString(parameters.selector),
        direction: optionalString(parameters.direction),
      });
    default:
      return null;
  }
};

export const createHeadlessActionRunner = (host: HeadlessActionHost) => {
  const pause = host.pause ?? defaultPause;

  const applyViewportMode = async (mode: unknown): Promise<void> => {
    if (!isViewportMode(mode)) return;
    const next = viewportForMode(mode);
    host.setViewport(next);
    await host.send(viewportCommand(next));
  };

  const afterNavigation = async (record: Record<string, unknown>): Promise<unknown> => {
    await pause(POST_ACTION_PAUSE_MS);
    await host.send({ command: 'settle' });
    const info = await host.send<HeadlessPageInfo>({ command: 'info' });
    return info.url ? { ...record, url: info.url } : record;
  };

  const runPageScript = async (action: string, parameters: Record<string, unknown>): Promise<unknown> => {
    const script = scriptFor(action, parameters);
    if (!script) throw new Error(`Unsupported browser action: ${action}`);
    await host.send({ command: 'settle' });
    const { value } = await host.send<{ value: unknown }>({ command: 'evaluate', script });
    if (!value || typeof value !== 'object') throw new Error('The page returned no result');
    const record = value as Record<string, unknown>;
    if (record.ok !== true) {
      throw new Error(typeof record.error === 'string' && record.error ? record.error : 'Browser action failed');
    }
    if (action === 'browser.click') {
      const { x, y, ...clicked } = record;
      await host.send({ command: 'click', x: Number(x), y: Number(y) });
      return afterNavigation(clicked);
    }
    if (action === 'browser.type') {
      await host.send({ command: 'type', text: String(parameters.value ?? ''), submit: parameters.submit === true });
      return parameters.submit === true ? afterNavigation(record) : record;
    }
    if (action === 'browser.snapshot') {
      const info = await host.send<HeadlessPageInfo>({ command: 'info' });
      return {
        ...record,
        viewport: viewportSummary(host.getViewport()),
        ...(info.problems.length > 0 ? { consoleProblems: info.problems } : {}),
      };
    }
    return record;
  };

  return async (action: string, parameters: Record<string, unknown>): Promise<unknown> => {
    if (action === 'browser.open') {
      const url = optionalString(parameters.url);
      if (!url) throw new Error('url is required');
      host.reveal?.();
      await applyViewportMode(parameters.viewport);
      const opened = await host.send<PageNavigation>({ command: 'navigate', url, timeoutMs: OPEN_TIMEOUT_MS });
      return {
        url: opened.url,
        title: opened.title,
        opened: true,
        settled: opened.settled === true,
        viewport: viewportSummary(host.getViewport()),
      };
    }
    if (action === 'browser.resize') {
      if (!isViewportMode(parameters.viewport)) throw new Error('viewport is required');
      await applyViewportMode(parameters.viewport);
      return { viewport: viewportSummary(host.getViewport()) };
    }
    if (action === 'browser.back' || action === 'browser.forward') {
      return host.send<PageNavigation>({ command: 'history', direction: action === 'browser.back' ? 'back' : 'forward' });
    }
    if (action === 'browser.capture') {
      const capture = await host.send<Record<string, unknown>>({ command: 'capture' });
      return { ...capture, viewport: viewportSummary(host.getViewport()) };
    }
    return runPageScript(action, parameters);
  };
};

export const normalizeHeadlessAddress = (value: string): string => (
  FILE_URL_PATTERN.test(value.trim()) ? value.trim() : normalizeBrowserUrl(value)
);
