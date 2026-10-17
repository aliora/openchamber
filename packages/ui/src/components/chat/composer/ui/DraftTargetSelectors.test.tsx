import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import type { ChatSurfaceMode } from '@/components/chat/chatSurfaceContextValue';
import { themes } from '@/lib/theme/themes';

import type { DraftTargetProject } from '../state/useDraftTarget';
import { MobileDraftTargetSheets } from './DraftTargetSelectors';

const project: DraftTargetProject = { id: 'p1', path: '/repo', label: 'repo' };
const otherProject: DraftTargetProject = { id: 'p2', path: '/other', label: 'other' };

const renderSheets = async (options: {
    openPicker: 'project' | 'branch';
    projects?: readonly DraftTargetProject[];
    selectedProject?: DraftTargetProject | null;
    defaultProjectId?: string | null;
    onCreateCustomWorktree?: () => void;
    surface?: ChatSurfaceMode;
}) => {
    const win = new Window({ url: 'http://localhost' });
    const values = {
        window: win,
        document: win.document,
        navigator: win.navigator,
        localStorage: win.localStorage,
        requestAnimationFrame: win.requestAnimationFrame.bind(win),
        cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let pickerChanges = 0;
    let pickerOpen: string | null = options.openPicker;
    await act(async () => root.render(
        <I18nProvider>
            <ChatSurfaceProvider mode={options.surface ?? 'default'}>
                <MobileDraftTargetSheets
                    projects={options.projects ?? [project]}
                    selectedProject={options.selectedProject === undefined ? project : options.selectedProject}
                    defaultProjectId={options.defaultProjectId ?? null}
                    selectedDirectory="/repo"
                    selectedBranchLabel="main"
                    selectedBranchIsKnown
                    hasUncommittedChanges={false}
                    projectRootBranchOption={{ value: '/repo', label: 'main' }}
                    worktreeBranchOptions={[]}
                    branchItems={[{ value: '/repo', label: 'main' }]}
                    showBranchSelector
                    onProjectChange={() => {}}
                    onDirectoryChange={() => {}}
                    onCreateCustomWorktree={options.onCreateCustomWorktree}
                    theme={themes[0]}
                    openPicker={options.openPicker}
                    onOpenPickerChange={(next) => { pickerChanges += 1; pickerOpen = next; }}
                />
            </ChatSurfaceProvider>
        </I18nProvider>,
    ));
    const button = (label: string) => [...document.body.querySelectorAll('button')].find((node) => node.textContent?.trim() === label) ?? null;
    return { root, button, picker: () => ({ changes: pickerChanges, open: pickerOpen }) };
};

const renderBranchSheet = (onCreateCustomWorktree?: () => void) => renderSheets({ openPicker: 'branch', onCreateCustomWorktree });

describe('draft worktree actions', () => {
    test('offer a quick worktree and the dialog, and the dialog entry closes the sheet', async () => {
        let opened = 0;
        const { root, picker, button } = await renderBranchSheet(() => { opened += 1; });
        expect(button('Quick worktree')).not.toBeNull();
        const custom = button('New worktree…');
        expect(custom).not.toBeNull();
        await act(async () => { custom?.click(); });
        expect(opened).toBe(1);
        expect(picker()).toEqual({ changes: 1, open: null });
        await act(async () => root.unmount());
    });

    test('leave the dialog entry out where the draft cannot open it', async () => {
        const { root, button } = await renderBranchSheet();
        expect(button('Quick worktree')).not.toBeNull();
        expect(button('New worktree…')).toBeNull();
        await act(async () => root.unmount());
    });
});

describe('draft project sheet', () => {
    test('marks the default project', async () => {
        const { root } = await renderSheets({ openPicker: 'project', projects: [project, otherProject], defaultProjectId: otherProject.id });
        const rows = [...document.body.querySelectorAll('button')].filter((node) => node.textContent?.includes('repo') || node.textContent?.includes('other'));
        expect(rows.find((node) => node.textContent?.includes('other'))?.textContent).toContain('Default');
        expect(rows.find((node) => node.textContent?.includes('repo'))?.textContent).not.toContain('Default');
        await act(async () => root.unmount());
    });

    test('offers adding a project when there is none', async () => {
        const { root, button } = await renderSheets({ openPicker: 'project', projects: [], selectedProject: null });
        expect(button('Add project')).not.toBeNull();
        await act(async () => root.unmount());
    });

    test('leaves adding a project out of the mini chat, which cannot open the directory dialog', async () => {
        const { root, button } = await renderSheets({ openPicker: 'project', projects: [], selectedProject: null, surface: 'mini-chat' });
        expect(button('Add project')).toBeNull();
        await act(async () => root.unmount());
    });
});
