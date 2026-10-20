import { describe, expect, test } from 'bun:test';

import type { HostDescriptor, HostProject, MonitoredHost } from '@/lib/hosts/types';

import { ACTIVE_HOST_OPTION_ID, resolveDraftHosts } from './draftHost';

const descriptor = (id: string, label: string): HostDescriptor => ({
  id, label, kind: 'direct', displayUrl: `https://${id}.example`, runtimeKey: `host:${id}`, monitored: true,
});

const project = (id: string, order: number, isDefault = false): HostProject => ({
  id, label: id.toUpperCase(), path: `/work/${id}`, order, isDefault,
});

const watched = (id: string, label: string, projects?: HostProject[]): MonitoredHost => ({
  descriptor: descriptor(id, label),
  connection: { state: 'live', since: 1, via: 'stream' },
  snapshot: { status: 'ready', sessions: new Map(), lastCompleteAt: 1, projects },
});

const MAC = descriptor('mac', 'Mac');
const PI = watched('pi', 'Pi5', [project('web', 1), project('api', 0), project('home', 2, true)]);
const STUDIO = watched('studio', 'Alpha Studio');

describe('the hosts a new session can start on', () => {
  test('the window\'s own host comes first, then the watched ones by name', () => {
    const state = resolveDraftHosts({ activeHost: MAC, hosts: [PI, STUDIO], pickedHostId: null });
    expect(state.options.map((option) => option.id)).toEqual(['mac', 'studio', 'pi']);
    expect(state.selected.id).toBe('mac');
    expect(state.remote).toBeNull();
  });

  test('a single host offers no choice', () => {
    expect(resolveDraftHosts({ activeHost: MAC, hosts: [], pickedHostId: null }).options).toHaveLength(1);
  });

  test('a window on an unsaved address still names its own host as the first choice', () => {
    const state = resolveDraftHosts({ activeHost: null, hosts: [PI], pickedHostId: null });
    expect(state.options.map((option) => option.id)).toEqual([ACTIVE_HOST_OPTION_ID, 'pi']);
    expect(state.selected.descriptor).toBeNull();
  });

  test('picking a watched host lists its projects, default first, then in the host\'s order', () => {
    const state = resolveDraftHosts({ activeHost: MAC, hosts: [PI, STUDIO], pickedHostId: 'pi' });
    expect(state.selected.id).toBe('pi');
    expect(state.remote?.host).toBe(PI);
    expect(state.remote?.projects.map((entry) => entry.path)).toEqual(['/work/home', '/work/api', '/work/web']);
    expect(state.remote?.defaultProjectId).toBe('home');
  });

  test('a host that predates projects lists none', () => {
    const state = resolveDraftHosts({ activeHost: MAC, hosts: [STUDIO], pickedHostId: 'studio' });
    expect(state.remote?.projects).toEqual([]);
    expect(state.remote?.defaultProjectId).toBeNull();
  });

  test('a pick that is the window\'s host or no longer watched stays on the window\'s host', () => {
    expect(resolveDraftHosts({ activeHost: MAC, hosts: [PI], pickedHostId: 'mac' }).remote).toBeNull();
    expect(resolveDraftHosts({ activeHost: MAC, hosts: [PI], pickedHostId: 'gone' }).selected.id).toBe('mac');
  });
});
