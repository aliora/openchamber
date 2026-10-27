import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

// The menus open through Base UI, which reads the DOM globals when it loads,
// so the window is installed before the components are imported.
const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom, document: dom.document, navigator: dom.navigator,
  Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
  Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, InputEvent: dom.InputEvent,
  ResizeObserver: dom.ResizeObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { useSessionDisplayStore } = await import('@/stores/useSessionDisplayStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { SidebarHeader } = await import('./SidebarHeader');
const { SidebarFooter } = await import('./SidebarFooter');

const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
const initialDisplay = useSessionDisplayStore.getState();
const initialUI = useUIStore.getState();

afterEach(async () => {
  await act(async () => root.render(null));
  useSessionDisplayStore.setState(initialDisplay);
  useUIStore.setState(initialUI);
});

afterAll(async () => {
  await act(async () => root.unmount());
  await dom.happyDOM.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const headerProps = {
  hideDirectoryControls: false,
  showProjectDisplayControls: true,
  showSectionControls: true,
  handleOpenDirectoryDialog: () => undefined,
  headerActionIconClass: 'h-4 w-4',
  headerActionButtonClass: 'inline-flex h-6 w-6 items-center justify-center rounded-md',
  isSessionSearchOpen: false,
  openSessionSearch: () => undefined,
  closeSessionSearch: () => undefined,
  sessionSearchInputRef: React.createRef<HTMLInputElement | null>(),
  sessionSearchQuery: '',
  setSessionSearchQuery: () => undefined,
  hasSessionSearchQuery: false,
  searchMatchCount: 0,
  collapseAll: () => undefined,
  expandAll: () => undefined,
};

const render = (node: React.ReactNode) => act(async () => root.render(
  <I18nProvider>
    <TooltipProvider>{node}</TooltipProvider>
  </I18nProvider>,
));

const menuItem = (label: string): HTMLElement => {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((entry) => entry.textContent === label);
  if (!item) throw new Error(`Missing menu item ${label}`);
  return item;
};

const button = (label: string): HTMLButtonElement => {
  const element = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!element) throw new Error(`Missing button ${label}`);
  return element;
};

describe('sidebar header menus', () => {
  test('the status filter switches what the list shows and stays marked while it filters', async () => {
    await render(<SidebarHeader {...headerProps} />);
    const trigger = () => {
      const element = document.querySelector<HTMLButtonElement>('[data-status-filter]');
      if (!element) throw new Error('Missing status filter');
      return element;
    };
    const choose = async (label: string) => {
      await act(async () => trigger().click());
      await act(async () => menuItem(label).click());
    };

    await choose('Needs you');
    expect(useSessionDisplayStore.getState().sessionStatusFilter).toBe('attention');
    expect(trigger().getAttribute('data-status-filter')).toBe('attention');
    expect(trigger().textContent).toBe('Needs you');
    expect(trigger().className).toContain('bg-interactive-selection');

    await choose('Running');
    expect(useSessionDisplayStore.getState().sessionStatusFilter).toBe('running');

    await choose('All');
    expect(useSessionDisplayStore.getState().sessionStatusFilter).toBe('all');
    expect(trigger().className).not.toContain('bg-interactive-selection');
  });

  test('Add project opens from the display menu', async () => {
    let opened = 0;
    await render(<SidebarHeader {...headerProps} handleOpenDirectoryDialog={() => { opened += 1; }} />);
    await act(async () => button('Display mode').click());
    await act(async () => menuItem('Add project').click());
    expect(opened).toBe(1);
  });

  test('a Sort by choice becomes the session sort and is marked', async () => {
    await render(<SidebarHeader {...headerProps} />);
    const trigger = () => document.querySelector<HTMLButtonElement>('[data-status-filter]');
    await act(async () => trigger()?.click());
    await act(async () => menuItem('Name A→Z').click());
    expect(useSessionDisplayStore.getState().sessionSortOrder).toBe('name');
    await act(async () => trigger()?.click());
    expect(document.querySelector('[data-session-sort="name"] svg')).not.toBeNull();
    expect(document.querySelector('[data-session-sort="activity"] svg')).toBeNull();
  });

  test('host lists leave out the project orders and the Pinned toggle', async () => {
    useSessionDisplayStore.setState({ sidebarViewMode: 'projects' });
    const labels = async (showHostLists: boolean) => {
      await render(<SidebarHeader {...headerProps} showHostLists={showHostLists} />);
      await act(async () => button('Display mode').click());
      const found = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((entry) => entry.textContent ?? '');
      await act(async () => root.render(null));
      return found;
    };
    const projects = await labels(false);
    expect(projects.some((label) => label.startsWith('Sort projects'))).toBe(true);
    expect(projects).toContain('Show pinned section');
    const hosts = await labels(true);
    expect(hosts.some((label) => label.startsWith('Sort projects'))).toBe(false);
    expect(hosts).not.toContain('Show pinned section');
  });
});

describe('sidebar footer', () => {
  const footer = (props: Partial<React.ComponentProps<typeof SidebarFooter>> = {}) => (
    <SidebarFooter
      onOpenSettings={() => undefined}
      onOpenShortcuts={() => undefined}
      onOpenAbout={() => undefined}
      {...props}
    />
  );

  test('a page button opens its page, shows it pressed, and closes it on the next click', async () => {
    await render(footer());
    for (const [label, isOpen] of [
      ['Stats', () => useUIStore.getState().isUsageStatsPageOpen],
      ['Scheduled tasks', () => useUIStore.getState().isScheduledTasksDialogOpen],
      ['Archive', () => useUIStore.getState().isArchivePageOpen],
    ] as const) {
      expect(button(label).getAttribute('aria-pressed')).toBe('false');
      await act(async () => button(label).click());
      expect(isOpen()).toBe(true);
      expect(button(label).getAttribute('aria-pressed')).toBe('true');
      await act(async () => button(label).click());
      expect(isOpen()).toBe(false);
    }
  });

  test('More holds Integrations, Shortcuts and About, and reads pressed while its page is open', async () => {
    let shortcuts = 0;
    let about = 0;
    await render(footer({ onOpenShortcuts: () => { shortcuts += 1; }, onOpenAbout: () => { about += 1; } }));

    await act(async () => button('More').click());
    await act(async () => menuItem('Integrations catalog').click());
    expect(useUIStore.getState().isIntegrationsCatalogOpen).toBe(true);
    expect(button('More').className).toContain('bg-interactive-selection');

    await act(async () => button('More').click());
    await act(async () => menuItem('Shortcuts').click());
    await act(async () => button('More').click());
    await act(async () => menuItem('About OpenChamber').click());
    expect([shortcuts, about]).toEqual([1, 1]);
  });

  test('VS Code shows no footer buttons', async () => {
    await render(footer({ showRuntimeButtons: false }));
    for (const label of ['Settings', 'Archive', 'More', 'Update']) {
      expect(document.querySelector(`[aria-label="${label}"]`)).toBeNull();
    }
  });
});
