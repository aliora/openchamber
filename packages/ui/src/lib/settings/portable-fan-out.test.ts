import { describe, expect, test } from 'bun:test';

import type { PortableValue } from '@/lib/settings/portable-settings';
import { copyPortableItems } from './portable-apply';
import { createPortableFanOut, type PortableFanOutHost, type PortableFanOutReport } from './portable-fan-out';

type Sent = { path: string; method: string; body: string };

const json = (body: PortableValue, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const host = (id: string, handler: (sent: Sent) => Response | Promise<Response>, reachable = true) => {
  const sent: Sent[] = [];
  const entry: PortableFanOutHost = {
    id,
    label: id.toUpperCase(),
    reachable,
    request: async (path, init) => {
      const request = { path, method: init?.method ?? 'GET', body: String(init?.body ?? '') };
      sent.push(request);
      return handler(request);
    },
  };
  return { entry, sent };
};

const sourceWith = (value: PortableValue) => host('mac', ({ path, body }) => {
  if (path !== '/api/portable-settings/export') return json({ error: 'unexpected' }, 500);
  const refs: { category: string; key: string }[] = JSON.parse(body).items;
  return json({ items: refs.map((ref) => ({ ...ref, status: 'found', value, updatedAt: 10 })) });
});

const applying = (id: string, reachable = true) => host(id, ({ body }) => {
  const { items, removals } = JSON.parse(body);
  return json({
    results: [
      ...items.map((entry: { category: string; key: string }) => ({ category: entry.category, key: entry.key, status: 'applied' })),
      ...removals.map((entry: { category: string; key: string }) => ({ category: entry.category, key: entry.key, status: 'removed' })),
    ],
  });
}, reachable);

const fanOutOver = (hosts: PortableFanOutHost[]) => {
  const reports: PortableFanOutReport[] = [];
  const fanOut = createPortableFanOut({
    listHosts: () => hosts,
    setTimer: () => () => {},
    debounceMs: 1_000,
    now: () => 500,
    report: (report) => reports.push(report),
  });
  return { fanOut, reports };
};

describe('portable fan-out', () => {
  test('writes a change to every other host even when one of them fails, and reports the failing one', async () => {
    const mac = sourceWith({ type: 'remote', headers: { Authorization: 'Bearer secret-token' } });
    const pi = applying('pi');
    const msi = host('msi', () => json({ error: 'down' }, 502));
    const studio = applying('studio');
    const { fanOut, reports } = fanOutOver([mac.entry, pi.entry, msi.entry, studio.entry]);

    fanOut.changed('mcp', 'github', 'mac');
    await fanOut.flush();

    for (const target of [pi, msi, studio]) {
      expect(target.sent).toHaveLength(1);
      expect(target.sent[0].method).toBe('PUT');
      expect(JSON.parse(target.sent[0].body)).toEqual({
        items: [{ category: 'mcp', key: 'github', value: { type: 'remote', headers: { Authorization: 'Bearer secret-token' } }, updatedAt: 10 }],
        removals: [],
        force: false,
      });
    }
    expect(reports).toEqual([{ problems: [{ hostId: 'msi', label: 'MSI', reason: 'unreachable' }], refusals: [] }]);
  });

  test('a host that is not connected is reported as offline and gets nothing', async () => {
    const mac = sourceWith({ name: 'x' });
    const pi = applying('pi', false);
    const { fanOut, reports } = fanOutOver([mac.entry, pi.entry]);

    fanOut.changed('agents', 'reviewer', 'mac');
    await fanOut.flush();

    expect(pi.sent).toHaveLength(0);
    expect(reports[0].problems).toEqual([{ hostId: 'pi', label: 'PI', reason: 'offline' }]);
  });

  test('a removal the source confirms reaches the other hosts with the time it was made', async () => {
    const mac = host('mac', ({ body }) => json({ items: JSON.parse(body).items.map((ref: { category: string; key: string }) => ({ ...ref, status: 'missing' })) }));
    const pi = applying('pi');
    const { fanOut } = fanOutOver([mac.entry, pi.entry]);

    fanOut.removed('commands', 'deploy', 'mac');
    await fanOut.flush();

    expect(JSON.parse(pi.sent[0].body)).toEqual({ items: [], removals: [{ category: 'commands', key: 'deploy', updatedAt: 500 }], force: false });
  });

  test('a removal of an item the source still holds copies it instead of removing it', async () => {
    const mac = sourceWith({ template: 'user copy' });
    const pi = applying('pi');
    const { fanOut } = fanOutOver([mac.entry, pi.entry]);

    fanOut.removed('commands', 'deploy', 'mac');
    await fanOut.flush();

    expect(JSON.parse(pi.sent[0].body)).toEqual({
      items: [{ category: 'commands', key: 'deploy', value: { template: 'user copy' }, updatedAt: 10 }],
      removals: [],
      force: false,
    });
  });

  test('a target refusing a path is listed as a refusal, not a problem', async () => {
    const mac = sourceWith({ label: 'App' });
    const pi = host('pi', () => json({ results: [{ category: 'projects', key: '~/work/app', status: 'refused', reason: 'path-missing', path: '~/work/app' }] }));
    const { fanOut, reports } = fanOutOver([mac.entry, pi.entry]);

    fanOut.changed('projects', '~/work/app', 'mac');
    await fanOut.flush();

    expect(reports[0].problems).toEqual([]);
    expect(reports[0].refusals).toEqual([{ hostId: 'pi', label: 'PI', result: { category: 'projects', key: '~/work/app', status: 'refused', reason: 'path-missing', path: '~/work/app' } }]);
  });

  test('several changes to one item are sent once, with a single host nothing is sent', async () => {
    const mac = sourceWith({});
    const pi = applying('pi');
    const { fanOut } = fanOutOver([mac.entry, pi.entry]);
    fanOut.changed('skills', 'deploy', 'mac');
    fanOut.changed('skills', 'deploy', 'mac');
    await fanOut.flush();
    expect(mac.sent).toHaveLength(1);

    const alone = sourceWith({});
    const single = fanOutOver([alone.entry]);
    single.fanOut.changed('skills', 'deploy', 'mac');
    await single.fanOut.flush();
    expect(alone.sent).toHaveLength(0);
  });
});

describe('copyPortableItems', () => {
  test('copies from the chosen source to the chosen targets with force, and lists what the source could not give', async () => {
    const source = host('pi', ({ body }) => {
      const refs: { category: string; key: string }[] = JSON.parse(body).items;
      return json({
        items: refs.map((ref) => (ref.key === 'huge'
          ? { ...ref, status: 'refused', reason: 'too-large' }
          : { ...ref, status: 'found', value: { files: [] }, updatedAt: null })),
      });
    });
    const target = applying('mac');

    const outcome = await copyPortableItems(source.entry, [target.entry], [{ category: 'skills', key: 'deploy' }, { category: 'skills', key: 'huge' }], true);

    expect(outcome).toEqual({
      status: 'done',
      notExported: [{ category: 'skills', key: 'huge', status: 'refused', reason: 'too-large' }],
      targets: [{ hostId: 'mac', status: 'done', results: [{ category: 'skills', key: 'deploy', status: 'applied' }] }],
    });
    expect(JSON.parse(target.sent[0].body).force).toBe(true);
  });

  test('an unreachable source writes nothing', async () => {
    const source = host('pi', () => {
      throw new Error('offline');
    });
    const target = applying('mac');
    expect(await copyPortableItems(source.entry, [target.entry], [{ category: 'mcp', key: 'github' }], true)).toEqual({ status: 'source-unreachable' });
    expect(target.sent).toHaveLength(0);
  });
});
