import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { opencodeClient } from '@/lib/opencode/client';
import { I18nProvider } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { WorkStatusMcpSection } from '@/components/chat/work-status/WorkStatusMcpSection';

type LoadMcpConfigs = (options?: { force?: boolean; directory?: string | null }) => Promise<boolean>;

// Reading MCP status boots the directory's whole stdio server fleet as an
// OpenCode side effect, so these tests spy on the status read itself and
// assert which mounts are allowed to issue it.
describe('MCP dropdown status reads', () => {
  let root: Root | null = null;
  let restoreGlobals: () => void;
  let listSpy: ReturnType<typeof spyOn>;
  let originalLoadMcpConfigs: LoadMcpConfigs;
  let dom: Window;
  const initialSessionState = useSessionUIStore.getState();
  const configRequests: Array<Parameters<LoadMcpConfigs>[0]> = [];
  const loadMcpConfigs = mock(async (options?: Parameters<LoadMcpConfigs>[0]) => {
    configRequests.push(options);
    return true;
  });

  const renderNode = async (element: React.ReactNode) => {
    const host = document.createElement('div');
    document.body.append(host);
    const mounted = createRoot(host);
    root = mounted;
    await act(async () => {
      mounted.render(
        <I18nProvider>
          <TooltipProvider>
            {element}
          </TooltipProvider>
        </I18nProvider>,
      );
    });
    return host;
  };

  beforeEach(() => {
    dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      PointerEvent: dom.PointerEvent,
      KeyboardEvent: dom.KeyboardEvent,
      HTMLElement: dom.HTMLElement,
      Element: dom.Element,
      Node: dom.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-a' });
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: { ...initialSessionState.newSessionDraft, open: false },
    });
    useMcpStore.setState({
      byDirectory: {},
      diagnosticsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},
      refreshedAtKeys: {},
    });
    originalLoadMcpConfigs = useMcpConfigStore.getState().loadMcpConfigs;
    useMcpConfigStore.setState({ loadMcpConfigs });
    listSpy = spyOn(opencodeClient, 'listMcpServers').mockImplementation(async () => []);
  });

  afterEach(async () => {
    if (root) {
      const mounted = root;
      root = null;
      await act(async () => mounted.unmount());
    }
    listSpy.mockRestore();
    useMcpConfigStore.setState({ loadMcpConfigs: originalLoadMcpConfigs });
    useSessionUIStore.setState(initialSessionState);
    restoreGlobals();
  });

  test('inactive content does not read MCP status on mount', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={false} />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('active content reads MCP status on mount', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={true} />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(1);
  });

  test('closed dropdown does not read MCP status on mount', async () => {
    const { McpDropdown } = await import('./McpDropdown');
    await renderNode(<McpDropdown headerIconButtonClass="" />);
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('directory change while inactive issues no status read', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={false} />);
    await act(async () => {});

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-b' });
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(0);
  });

  test('directory change while active reads the new directory', async () => {
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active={true} />);
    await act(async () => {});
    expect(listSpy.mock.calls.length).toBe(1);

    useDirectoryStore.setState({ currentDirectory: 'C:/proj-b' });
    await act(async () => {});

    expect(listSpy.mock.calls.length).toBe(2);
    expect(listSpy.mock.calls[1]?.[0]).toBe('C:/proj-b');
  });

  test('concurrent freshens issue a single status read', async () => {
    const first = useMcpStore.getState().ensureFresh({ directory: 'C:/proj-a', silent: true, maxAgeMs: 60_000 });
    const second = useMcpStore.getState().ensureFresh({ directory: 'C:/proj-a', silent: true, maxAgeMs: 60_000 });
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(listSpy.mock.calls.length).toBe(1);
  });

  test('a pinned session panel uses its own directory', async () => {
    await renderNode(<WorkStatusMcpSection sessionId="pinned-chat" directory="/work/pinned" />);
    expect(listSpy.mock.calls).toEqual([['/work/pinned']]);
  });

  test('project drafts read their selected directory rather than the previous session directory', async () => {
    useSessionUIStore.setState({ newSessionDraft: {
      ...initialSessionState.newSessionDraft, open: true, target: 'project', directoryOverride: '/project-b',
    } });
    const { McpDropdownContent } = await import('./McpDropdown');
    await renderNode(<McpDropdownContent active />);
    expect(listSpy.mock.calls).toEqual([['/project-b']]);
    expect(configRequests.at(-1)).toEqual({ force: true, directory: '/project-b' });
  });
});
