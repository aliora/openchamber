import { describe, expect, test } from 'bun:test';

import { createDraftInDirectoryOpener, type DraftInDirectoryTarget } from './open-host-draft';

const createProjects = (initial: Array<{ id: string; path: string }>) => {
  let projects = initial;
  const listeners = new Set<() => void>();
  const opened: DraftInDirectoryTarget[] = [];
  let expire: (() => void) | null = null;
  const open = createDraftInDirectoryOpener({
    findProjectId: (directory) => projects.find((project) => project.path === directory)?.id ?? null,
    subscribeProjects: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openDraft: (target) => { opened.push(target); },
    scheduleTimeout: (onTimeout) => {
      expire = onTimeout;
      return () => { expire = null; };
    },
  });
  return {
    open,
    opened,
    listeners,
    load: (next: Array<{ id: string; path: string }>) => {
      projects = next;
      for (const listener of [...listeners]) listener();
    },
    expire: () => expire?.(),
    waiting: () => expire !== null,
  };
};

describe('opening a draft in a folder of the host the window just reached', () => {
  test('a folder of a known project opens the draft there at once', () => {
    const host = createProjects([{ id: 'api', path: '/work/api' }]);
    host.open('/work/api');
    expect(host.opened).toEqual([{ projectId: 'api', directory: '/work/api' }]);
    expect(host.waiting()).toBe(false);
  });

  test('no folder opens a plain draft', () => {
    const host = createProjects([]);
    host.open();
    expect(host.opened).toEqual([{ projectId: null, directory: null }]);
  });

  test('a folder whose project has not loaded yet waits for the projects, then opens there', () => {
    const host = createProjects([]);
    host.open('/work/api');
    expect(host.opened).toEqual([]);
    host.load([{ id: 'web', path: '/work/web' }]);
    expect(host.opened).toEqual([]);
    host.load([{ id: 'web', path: '/work/web' }, { id: 'api', path: '/work/api' }]);
    expect(host.opened).toEqual([{ projectId: 'api', directory: '/work/api' }]);
    expect(host.listeners.size).toBe(0);
    expect(host.waiting()).toBe(false);
  });

  test('projects that never list the folder still open the draft there when the wait ends', () => {
    const host = createProjects([]);
    host.open('/work/api');
    host.expire();
    expect(host.opened).toEqual([{ projectId: null, directory: '/work/api' }]);
    host.load([{ id: 'api', path: '/work/api' }]);
    expect(host.opened).toHaveLength(1);
  });

  test('a newer draft replaces one still waiting', () => {
    const host = createProjects([]);
    host.open('/work/api');
    host.open('/work/web');
    host.load([{ id: 'api', path: '/work/api' }, { id: 'web', path: '/work/web' }]);
    expect(host.opened).toEqual([{ projectId: 'web', directory: '/work/web' }]);
  });
});
