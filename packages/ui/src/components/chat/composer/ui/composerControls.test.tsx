import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import type { EngineControls } from '@/stores/useEngineControlsStore';

const installDom = () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent,
    ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  return async () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  };
};

const mode = (engine: string, id: string, extra: { dangerous?: boolean; appliesLive?: boolean } = {}) => ({
  id,
  labelKey: `engine.permissionMode.${engine}.${id}.label`,
  descriptionKey: `engine.permissionMode.${engine}.${id}.description`,
  dangerous: extra.dangerous ?? false,
  appliesLive: extra.appliesLive ?? false,
});

// The controls `GET /api/engines/controls` answers for Claude Code and Codex.
const CLAUDE: EngineControls = {
  engine: 'claude',
  providerID: 'anthropic',
  defaultPermissionMode: 'auto',
  permissionModes: [
    mode('claude', 'manual', { appliesLive: true }),
    mode('claude', 'acceptEdits', { appliesLive: true }),
    mode('claude', 'plan', { appliesLive: true }),
    mode('claude', 'auto', { appliesLive: true }),
    mode('claude', 'dontAsk', { appliesLive: true }),
    mode('claude', 'bypassPermissions', { dangerous: true }),
  ],
  defaultEffort: 'medium',
};
const CODEX: EngineControls = {
  engine: 'codex',
  providerID: 'openai',
  defaultPermissionMode: 'on-request',
  permissionModes: ['read-only', 'untrusted', 'on-request', 'never'].map((id) => mode('codex', id)),
  defaultEffort: 'medium',
};

let restoreDom: () => Promise<void>;
let root: { render: (node: React.ReactNode) => void; unmount: () => void };
let container: HTMLElement;

beforeEach(async () => {
  restoreDom = installDom();
  const { createRoot } = await import('react-dom/client');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  act(() => root.unmount());
  await restoreDom();
});

const renderWithI18n = async (node: React.ReactNode) => {
  const { I18nProvider } = await import('@/lib/i18n');
  await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
};

const trigger = (testId: string) => {
  const element = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`Missing ${testId}`);
  return element;
};

const openMenu = async (testId: string) => {
  await act(async () => { trigger(testId).click(); });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
};

describe('Permission menu', () => {
  test('names the mode in force and lists the engine modes in plain words', async () => {
    const { EnginePermissionControl } = await import('./EnginePermissionControl');
    const picked: string[] = [];
    await renderWithI18n(
      <EnginePermissionControl
        permission={{ kind: 'engine', engine: CLAUDE, mode: CLAUDE.permissionModes[3], select: (id) => picked.push(id) }}
        heightClass="h-8"
        iconSizeClass="size-4"
        textClass="typography-meta"
      />,
    );

    expect(trigger('composer-permission-control').getAttribute('aria-label')).toBe('Permission mode: Auto');
    // The label carries the class the narrow-row rule hides.
    expect(trigger('composer-permission-control').querySelector('.composer-footer__control-label')?.textContent).toBe('Auto');

    const items = await openMenu('composer-permission-control');
    expect(items.map((item) => item.querySelector('.typography-ui-label')?.textContent)).toEqual([
      'Ask before changes',
      'Auto-accept edits',
      'Plan only',
      'Auto',
      'Only allowed tools',
      'Bypass all permissions',
    ]);
    expect(items[0]?.textContent).toContain('Claude asks before it edits files or runs commands.');
    expect(items[3]?.getAttribute('aria-checked')).toBe('true');
    // Bypass is marked, and it reaches Claude only with the next message.
    expect(items[5]?.textContent).toContain('Dangerous');
    expect(items[5]?.textContent).toContain('Takes effect with your next message.');
    expect(items[0]?.textContent).not.toContain('Takes effect with your next message.');

    await act(async () => { items[0]?.click(); });
    expect(picked).toEqual(['manual']);
  });

  test('says once that every Codex mode waits for the next message', async () => {
    const { EnginePermissionControl } = await import('./EnginePermissionControl');
    await renderWithI18n(
      <EnginePermissionControl
        permission={{ kind: 'engine', engine: CODEX, mode: CODEX.permissionModes[2], select: () => {} }}
        heightClass="h-8"
        iconSizeClass="size-4"
        textClass="typography-meta"
      />,
    );
    expect(trigger('composer-permission-control').getAttribute('aria-label')).toBe('Permission mode: Ask when needed');
    const items = await openMenu('composer-permission-control');
    expect(items.map((item) => item.querySelector('.typography-ui-label')?.textContent)).toEqual([
      'Read only',
      'Ask before commands',
      'Ask when needed',
      'Never ask',
    ]);
    const menu = document.querySelector('[role="menu"]');
    expect(menu?.textContent?.split('Takes effect with your next message.').length).toBe(2);
  });

  test('stays disabled while the engine modes load', async () => {
    const { EnginePermissionControl } = await import('./EnginePermissionControl');
    await renderWithI18n(
      <EnginePermissionControl permission={{ kind: 'pending' }} heightClass="h-8" iconSizeClass="size-4" textClass="typography-meta" />,
    );
    expect(trigger('composer-permission-control').disabled).toBe(true);
    expect(trigger('composer-permission-control').getAttribute('aria-label')).toBe('Loading permission modes');
  });

  test('collapses to its icon on a narrow composer row', () => {
    const css = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
    const rule = /@container composer-footer \(max-width: 36rem\) \{\s*:root:not\(\.vscode-runtime\) \.composer-footer__control-label \{\s*display: none;/;
    expect(rule.test(css)).toBe(true);
  });
});

describe('Effort menu', () => {
  const renderEffort = async (props: Partial<React.ComponentProps<typeof import('./EffortControl').EffortControl>>, picks: Array<string | undefined>) => {
    const { EffortControl } = await import('./EffortControl');
    await renderWithI18n(
      <EffortControl
        levels={['low', 'medium', 'high', 'xhigh', 'max']}
        selected={undefined}
        defaultLevel={null}
        unavailableReason={null}
        onSelect={(level) => picks.push(level)}
        heightClass="h-8"
        iconSizeClass="size-4"
        textClass="typography-meta"
        {...props}
      />,
    );
  };

  test('shows the engine default level as chosen and marks it instead of a Default item', async () => {
    const picks: Array<string | undefined> = [];
    await renderEffort({ defaultLevel: 'medium' }, picks);
    expect(trigger('composer-effort-control').getAttribute('aria-label')).toBe('Effort: Medium');

    const items = await openMenu('composer-effort-control');
    expect(items.map((item) => item.querySelector('.typography-ui-label')?.textContent)).toEqual(['Low', 'Medium', 'High', 'Extra high', 'Max']);
    expect(items[1]?.getAttribute('aria-checked')).toBe('true');
    expect(items[1]?.textContent).toContain('Model default');
    expect(items[3]?.textContent).toContain('Thinks much longer.');

    // Picking the default records it, so the session runs on what the menu shows.
    await act(async () => { items[1]?.click(); });
    expect(picks).toEqual(['medium']);
  });

  test('follows the model: its own levels, and Default where no engine names one', async () => {
    const picks: Array<string | undefined> = [];
    await renderEffort({ levels: ['low', 'high', 'turbo'], selected: 'high' }, picks);
    expect(trigger('composer-effort-control').getAttribute('aria-label')).toBe('Effort: High');
    const items = await openMenu('composer-effort-control');
    expect(items.map((item) => item.querySelector('.typography-ui-label')?.textContent)).toEqual(['Default', 'Low', 'High', 'Turbo']);
    await act(async () => { items[0]?.click(); });
    expect(picks).toEqual([undefined]);
  });

  test('explains why a model without levels offers no menu', async () => {
    const picks: Array<string | undefined> = [];
    await renderEffort({ levels: [], unavailableReason: 'Antigravity default has no effort levels to choose from.' }, picks);
    const button = trigger('composer-effort-control');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe('Effort: Antigravity default has no effort levels to choose from.');
    await act(async () => { button.click(); });
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(picks).toEqual([]);
  });
});
