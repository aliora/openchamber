import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const copied: string[] = [];
Object.defineProperty(browser.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => { copied.push(text); } },
});
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  HTMLDivElement: browser.HTMLDivElement, Text: browser.Text, DocumentFragment: browser.DocumentFragment,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ModelPickerList } = await import('./ModelPickerList');
type ModelPickerProps = React.ComponentProps<typeof ModelPickerList>;

const INSTALL_AGY = 'curl -fsSL https://antigravity.google/cli/install.sh | bash';

const providers: ModelPickerProps['providers'] = [
  { id: 'anthropic', name: 'Claude Code', models: [{ id: 'sonnet', name: 'Claude Sonnet' }] },
  { id: 'google', name: 'Antigravity', models: [{ id: 'default', name: 'Antigravity default' }, { id: 'flash', name: 'Gemini Flash' }] },
  { id: 'openai', name: 'Codex', models: [{ id: 'gpt', name: 'GPT' }] },
];

// What the composer passes for an engine whose CLI is missing.
const agyMissing: NonNullable<ModelPickerProps['unavailableProviders']> = new Map([
  ['google', { hint: 'Not installed', fixCommand: INSTALL_AGY }],
]);

afterAll(() => {
  browser.close();
});

describe('model picker with an engine that cannot run', () => {
  let root: ReturnType<typeof createRoot> | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(async () => {
    await act(async () => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    copied.length = 0;
  });

  const render = async (props: Partial<ModelPickerProps> = {}) => {
    const chosen: string[] = [];
    const Harness = () => {
      const [query, setQuery] = React.useState('');
      return (
        <ModelPickerList
          providers={providers}
          favoriteModels={[]}
          recentModels={[]}
          searchQuery={query}
          onSearchQueryChange={setQuery}
          onSelect={(entry) => { chosen.push(`${entry.providerID}/${entry.modelID}`); }}
          labels={{ searchPlaceholder: 'Search models', noResults: 'No models', favorites: 'Favorites', recent: 'Recent', keyboardHint: '' }}
          selectedModel={{ providerID: 'anthropic', modelID: 'sonnet' }}
          {...props}
        />
      );
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<I18nProvider><Harness /></I18nProvider>);
    });
    return chosen;
  };

  const row = (name: string) => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes(name));
    if (!found) throw new Error(`No row for ${name}`);
    return found;
  };
  const press = async (key: string, { ctrlKey = false } = {}) => {
    const input = document.querySelector('input');
    if (!input) throw new Error('No search field');
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  test('keeps the engine listed, greyed out, with the reason and the command that fixes it', async () => {
    await render({ unavailableProviders: agyMissing });

    for (const name of ['Antigravity default', 'Gemini Flash']) {
      expect(row(name).getAttribute('aria-disabled')).toBe('true');
      expect(row(name).className).toContain('opacity-50');
      expect(row(name).getAttribute('title')).toBe('Not installed');
    }
    for (const name of ['Claude Sonnet', 'GPT']) {
      expect(row(name).getAttribute('aria-disabled')).toBeNull();
    }
    const header = [...document.querySelectorAll('[data-model-picker-sticky-header]')]
      .find((element) => element.textContent?.includes('Antigravity'));
    expect(header?.textContent).toContain('Not installed');
    expect(document.querySelector('code')?.textContent).toBe(INSTALL_AGY);
  });

  test('a click on a greyed-out model chooses nothing', async () => {
    const chosen = await render({ unavailableProviders: agyMissing });

    await click(row('Gemini Flash'));
    expect(chosen).toEqual([]);

    await click(row('GPT'));
    expect(chosen).toEqual(['openai/gpt']);
  });

  test('arrow keys and Ctrl+N/P skip greyed-out models', async () => {
    const chosen = await render({ unavailableProviders: agyMissing });

    await press('ArrowDown');
    expect(row('GPT').className).toContain('bg-interactive-selection');
    expect(row('Antigravity default').className).not.toContain('bg-interactive-selection');
    await press('Enter');
    expect(chosen).toEqual(['openai/gpt']);

    await press('p', { ctrlKey: true });
    expect(row('Claude Sonnet').className).toContain('bg-interactive-selection');
    await press('n', { ctrlKey: true });
    await press('ArrowUp');
    await press('Enter');
    expect(chosen).toEqual(['openai/gpt', 'anthropic/sonnet']);
  });

  test('the current model of an engine that cannot run stays shown, and Enter picks no other model', async () => {
    const chosen = await render({
      unavailableProviders: agyMissing,
      selectedModel: { providerID: 'google', modelID: 'default' },
    });

    expect(row('Antigravity default').getAttribute('aria-selected')).toBe('true');
    expect(row('Antigravity default').className).not.toContain('bg-interactive-selection');
    await press('Enter');
    expect(chosen).toEqual([]);

    await press('ArrowDown');
    await press('Enter');
    expect(chosen).toEqual(['openai/gpt']);
  });

  test('a favorite of an engine that cannot run names the reason on its row', async () => {
    await render({
      unavailableProviders: agyMissing,
      favoriteModels: [{ providerID: 'google', modelID: 'flash', model: { id: 'flash', name: 'Gemini Flash' } }],
    });
    const favorite = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .filter((option) => option.textContent?.includes('Gemini Flash'));
    expect(favorite).toHaveLength(2);
    expect(favorite[0].textContent).toContain('Not installed');
    expect(favorite[0].getAttribute('aria-disabled')).toBe('true');
  });

  test('a signed-out engine the server gives no command for shows only the reason', async () => {
    // What the composer passes in enterprise mode, where the server leaves out the sign-in command.
    await render({ unavailableProviders: new Map([['openai', { hint: 'Sign in needed', fixCommand: null }]]) });

    expect(row('GPT').getAttribute('aria-disabled')).toBe('true');
    const header = [...document.querySelectorAll('[data-model-picker-sticky-header]')]
      .find((element) => element.textContent?.includes('Codex'));
    expect(header?.textContent).toContain('Sign in needed');
    expect(document.querySelector('code')).toBeNull();
    expect(document.querySelector('button[aria-label="Copy command"]')).toBeNull();
  });

  test('an engine not known to be unavailable is offered as before', async () => {
    const chosen = await render({ unavailableProviders: new Map() });

    expect(document.querySelectorAll('[role="option"][aria-disabled="true"]')).toHaveLength(0);
    expect(document.querySelector('code')).toBeNull();
    await press('ArrowDown');
    await press('Enter');
    expect(chosen).toEqual(['google/default']);
  });

  test('the copy button copies the command and chooses nothing', async () => {
    const chosen = await render({ unavailableProviders: agyMissing });
    const copy = document.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]');
    if (!copy) throw new Error('No copy button');

    await click(copy);

    expect(copied).toEqual([INSTALL_AGY]);
    expect(copy.getAttribute('aria-label')).toBe('Copied');
    expect(chosen).toEqual([]);
    // The section stays open.
    expect(row('Gemini Flash')).toBeTruthy();
  });
});
