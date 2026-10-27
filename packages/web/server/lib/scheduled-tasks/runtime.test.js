import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, mkdir, writeFile, stat, readdir } from 'fs/promises';
import {
  computeNextRunAt,
  expandCommandGoalObjective,
  formatScheduledSessionTitle,
  parseScheduledCommandPrompt,
  createScheduledTasksRuntime,
} from './runtime.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { createChatsScope } from './chats-scope.js';
import { loopFingerprint, parseLoopDefinition } from './loops.js';
import { INTERNAL_AUTH_HEADER, internalAuthHeaders } from '../ui-auth/internal-credential.js';

describe('scheduled-tasks runtime helpers', () => {
  it.each([
    ['*/15 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:15:00Z'],
    ['30 */5 * * * *', 'UTC', '2026-09-18T08:07:00Z', '2026-09-18T08:10:30Z'],
    ['0 9 * * MON-FRI', 'Europe/Kyiv', '2026-09-18T07:00:00Z', '2026-09-21T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-03-28T08:00:00Z', '2026-03-29T06:00:00Z'],
    ['0 9 * * *', 'Europe/Kyiv', '2026-10-24T08:00:00Z', '2026-10-25T07:00:00Z'],
    ['0 0 L * *', 'UTC', '2026-02-01T00:00:00Z', '2026-02-28T00:00:00Z'],
  ])('computes cron %s in %s from %s', (cron, timezone, now, expected) => {
    expect(computeNextRunAt({
      enabled: true,
      schedule: { kind: 'cron', cron, timezone },
    }, Date.parse(now))).toBe(Date.parse(expected));
  });

  it('computes next daily run in timezone', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 8, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:30'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 30, 0));
  });

  it('computes weekly next run using weekdays', () => {
    // Monday 2025-01-06 10:00:00 UTC
    const nowUtc = Date.UTC(2025, 0, 6, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'weekly',
        times: ['09:00'],
        weekdays: [1, 3],
        timezone: 'UTC',
      },
    }, nowUtc);

    // Wednesday 2025-01-08 09:00:00 UTC
    expect(next).toBe(Date.UTC(2025, 0, 8, 9, 0, 0));
  });

  it('picks nearest time from multiple daily times', () => {
    const nowUtc = Date.UTC(2025, 0, 1, 9, 20, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'daily',
        times: ['09:15', '09:45', '18:00'],
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2025, 0, 1, 9, 45, 0));
  });

  it('computes one-time next run for future date', () => {
    const nowUtc = Date.UTC(2026, 3, 15, 10, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBe(Date.UTC(2026, 3, 16, 13, 30, 0));
  });

  it('returns null for past one-time schedule', () => {
    const nowUtc = Date.UTC(2026, 3, 16, 14, 0, 0);
    const next = computeNextRunAt({
      enabled: true,
      schedule: {
        kind: 'once',
        date: '2026-04-16',
        time: '13:30',
        timezone: 'UTC',
      },
    }, nowUtc);

    expect(next).toBeNull();
  });

  it('formats session title with timestamp suffix', () => {
    const title = formatScheduledSessionTitle({
      name: 'Morning Sync',
      schedule: { timezone: 'UTC' },
    }, Date.UTC(2025, 2, 10, 7, 5, 0));

    expect(title).toBe('Morning Sync 2025-03-10 07:05');
  });

  it('parses slash command prompt for scheduled command mode', () => {
    expect(parseScheduledCommandPrompt('/review src/components')).toEqual({
      command: 'review',
      arguments: 'src/components',
    });
  });

  it('returns null when prompt is not a slash command', () => {
    expect(parseScheduledCommandPrompt('Summarize open issues')).toBeNull();
    expect(parseScheduledCommandPrompt('/')).toBeNull();
  });

  it('expands command arguments into the goal objective', () => {
    expect(expandCommandGoalObjective(
      'Run the issue pipeline for $ARGUMENTS. Verify $ARGUMENTS is represented by the PR.',
      'LIN-123 --draft',
    )).toBe('Run the issue pipeline for LIN-123 --draft. Verify LIN-123 --draft is represented by the PR.');
    expect(expandCommandGoalObjective(undefined, 'LIN-123')).toBeNull();
    expect(expandCommandGoalObjective('Move $1 to $2', '"src old" dist extra')).toBe('Move src old to dist extra');
    expect(expandCommandGoalObjective('Review the requested scope.', 'auth module'))
      .toBe('Review the requested scope.\n\nauth module');
  });
});

describe('scheduled-tasks runtime syncProject wiring', () => {
  const createTempProject = async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-loop-'));
    const repoPath = path.join(tempRoot, 'repo');
    await mkdir(path.join(repoPath, '.agents', 'loops'), { recursive: true });
    return {
      tempRoot,
      repoPath,
      cleanup: async () => {
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  };

  const createProjectConfig = async (tempRoot) => createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: path.join(tempRoot, 'config'),
    createTaskID: () => 'task-fixed-id',
  });

  const createRuntimeDeps = (overrides = {}) => ({
    buildOpenCodeUrl: () => 'http://localhost',
    getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => {},
    ...overrides,
  });

  it('reconciles discovered loops when the project path is known', async () => {
    const { tempRoot, repoPath, cleanup } = await createTempProject();
    try {
      await writeFile(path.join(repoPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        listProjects: async () => [{ id: 'proj', path: repoPath }],
      });

      const loopFile = path.join(repoPath, '.agents', 'loops', 'daily.md');
      await runtime.syncProject('proj');

      // `enabled: true` came with the repository: listed, not scheduled.
      let tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('loop:project:daily');
      expect(tasks[0].loopFile).toBe(loopFile);
      expect(tasks[0].enabled).toBe(false);

      // Approved on this machine, this version runs.
      await projectConfigRuntime.setLoopApproval('proj', loopFile, loopFingerprint(parseLoopDefinition(loopFile)));
      await runtime.syncProject('proj');
      tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks[0].enabled).toBe(true);
      // syncTaskSchedule computed and persisted the next run for the enabled task.
      expect(tasks[0].state.nextRunAt).toBeGreaterThan(0);

      // A changed prompt is a new version and waits for a new approval.
      await writeFile(loopFile, `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run something else.
`, 'utf8');
      await runtime.syncProject('proj');
      tasks = await projectConfigRuntime.listScheduledTasks('proj');
      expect(tasks[0].enabled).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('falls back to plain listing when the project path cannot be resolved', async () => {
    const { tempRoot, cleanup } = await createTempProject();
    try {
      const projectConfigRuntime = await createProjectConfig(tempRoot);
      const reconcileSpy = vi.spyOn(projectConfigRuntime, 'reconcileLoopTasks');
      const listSpy = vi.spyOn(projectConfigRuntime, 'listScheduledTasks');

      const runtime = createScheduledTasksRuntime({
        ...createRuntimeDeps(),
        projectConfigRuntime,
        // Project not registered -> ensureProjectPath cannot resolve a path.
        listProjects: async () => [],
      });

      await runtime.syncProject('proj');

      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(listSpy).toHaveBeenCalledWith('proj');
      expect(await projectConfigRuntime.listScheduledTasks('proj')).toEqual([]);
      reconcileSpy.mockRestore();
      listSpy.mockRestore();
    } finally {
      await cleanup();
    }
  });
});

describe('scheduled-tasks runtime syncAllProjects', () => {
  it('keeps scheduling the other projects when one project cannot be synced', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-sync-all-'));
    try {
      const brokenPath = path.join(tempRoot, 'broken');
      const healthyPath = path.join(tempRoot, 'healthy');
      await mkdir(path.join(healthyPath, '.agents', 'loops'), { recursive: true });
      await mkdir(brokenPath, { recursive: true });
      await writeFile(path.join(healthyPath, '.agents', 'loops', 'daily.md'), `---
name: daily
schedule: "0 9 * * *"
enabled: true
model: openai/gpt-5
---
Run daily.
`, 'utf8');

      const projectConfigRuntime = createProjectConfigRuntime({
        fsPromises: await import('fs/promises'),
        path,
        projectsDirPath: path.join(tempRoot, 'config'),
        createTaskID: () => 'task-fixed-id',
      });
      await mkdir(path.join(tempRoot, 'config'), { recursive: true });
      await writeFile(projectConfigRuntime.resolveProjectConfigPath('broken'), '{ not json', 'utf8');
      const healthyLoop = path.join(healthyPath, '.agents', 'loops', 'daily.md');
      await projectConfigRuntime.setLoopApproval('healthy', healthyLoop, loopFingerprint(parseLoopDefinition(healthyLoop)));

      const warnings = [];
      const runtime = createScheduledTasksRuntime({
        buildOpenCodeUrl: () => 'http://localhost',
        getOpenCodeAuthHeaders: () => ({}),
        waitForOpenCodeReady: async () => {},
        projectConfigRuntime,
        listProjects: async () => [
          { id: 'broken', path: brokenPath },
          { id: 'healthy', path: healthyPath },
        ],
        logger: { warn: (...args) => warnings.push(args) },
      });

      await expect(runtime.start()).resolves.toBeUndefined();

      expect(runtime.getStatus().enabledScheduledTasksCount).toBe(1);
      const healthyTasks = await projectConfigRuntime.listScheduledTasks('healthy');
      expect(healthyTasks.map((task) => task.id)).toEqual(['loop:project:daily']);
      expect(warnings).toHaveLength(1);
      expect(warnings[0][1]).toMatchObject({ projectID: 'broken' });
      runtime.stop();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('scheduled-tasks runtime prompt dispatch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parks the briefing with resume: false so execution starts on the task prompt', async () => {
    const posts = [];
    const markSessionScheduled = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST') posts.push({ pathname, body: JSON.parse(init.body) });
      const data = pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5', goalEnabled: true, goalTokenBudget: 50_000 },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async () => ({ task, updated: true }),
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      persistSessionGoal: async () => undefined,
      markSessionScheduled,
      sessionKnowledgeRuntime: {
        sync: async (sessionID, directory) => { posts.push({ pathname: `knowledge:${sessionID}`, body: { directory } }); return true; },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    await runtime.runNow('proj', 'task-1');
    runtime.stop();

    // The run is marked, so it stays out of In work.
    expect(posts.find((post) => post.pathname === '/api/session')?.body.metadata).toEqual({ openchamber: { kind: 'scheduled' } });
    expect(markSessionScheduled).toHaveBeenCalledWith('ses_run', '/repo');
    // The project knowledge is written into the session before anything is sent to it.
    const dispatch = posts.filter((post) => post.pathname.startsWith('/api/session/ses_run/') || post.pathname.startsWith('knowledge:'));
    expect(dispatch.map((post) => post.pathname.split('/').at(-1))).toEqual(['knowledge:ses_run', 'synthetic', 'prompt']);
    expect(dispatch[0].body).toEqual({ directory: '/repo' });
    expect(dispatch[1].body.resume).toBe(false);
    expect(dispatch[2].body).toMatchObject({ text: 'Review open issues' });
    expect(dispatch[2].body.resume).toBeUndefined();
  });

  const runWithPermissionMode = async ({ patchStatus = 204 } = {}) => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      requests.push({ method: init.method, pathname, body: init.body ? JSON.parse(init.body) : null });
      if (init.method === 'PATCH') {
        return patchStatus === 204
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify({ message: 'Unknown permission mode for Claude Code: dangerously-skip-permissions' }), { status: patchStatus });
      }
      const data = pathname === '/api/session' ? { id: 'ses_agy' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Unattended',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'echo ok', providerID: 'google', modelID: 'gemini-3.8-flash', permissionMode: 'dangerously-skip-permissions' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({ authorization: 'Bearer t' }),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();
    return { requests, patches, result };
  };

  it('starts the session in the task permission mode before the prompt goes out', async () => {
    const { requests, result } = await runWithPermissionMode();

    expect(result.ok).toBe(true);
    const patchIndex = requests.findIndex((request) => request.method === 'PATCH');
    expect(requests[patchIndex]).toEqual({
      method: 'PATCH',
      pathname: '/api/session/ses_agy',
      body: { permissionMode: 'dangerously-skip-permissions' },
    });
    const promptIndex = requests.findIndex((request) => request.pathname === '/api/session/ses_agy/prompt');
    expect(patchIndex).toBeGreaterThan(-1);
    expect(patchIndex).toBeLessThan(promptIndex);
  });

  it('fails the run without a prompt when the engine refuses the permission mode', async () => {
    const { requests, patches, result } = await runWithPermissionMode({ patchStatus: 400 });

    expect(result.ok).toBe(false);
    expect(requests.some((request) => request.pathname.endsWith('/prompt'))).toBe(false);
    expect(patches.at(-1)).toMatchObject({
      lastStatus: 'error',
      lastSessionId: 'ses_agy',
      lastError: expect.stringContaining('Unknown permission mode'),
    });
  });

  it('points a run that fails after creating its session at that session', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname.endsWith('/prompt')) {
        return new Response(JSON.stringify({ error: 'provider down' }), { status: 500 });
      }
      const data = pathname === '/api/session' ? { id: 'ses_failed' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1, lastSessionId: 'ses_previous' },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(false);
    // The start clears the previous run's session, creation records this one,
    // and the failure keeps it.
    const startIndex = patches.findIndex((patch) => patch.lastStatus === 'running');
    expect(Object.hasOwn(patches[startIndex], 'lastSessionId')).toBe(true);
    expect(patches[startIndex].lastSessionId).toBeUndefined();
    expect(patches[startIndex + 1]).toEqual({ lastSessionId: 'ses_failed' });
    expect(patches.at(-1)).toMatchObject({ lastStatus: 'error', lastSessionId: 'ses_failed' });
  });
});

describe('scheduled-tasks runtime chats scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const task = {
    id: 'task-1',
    name: 'Morning digest',
    enabled: true,
    schedule: { kind: 'daily', times: ['08:00'], timezone: 'UTC' },
    execution: { prompt: 'Summarize the news', providerID: 'openai', modelID: 'gpt-5' },
    state: { createdAt: 1, updatedAt: 1 },
  };

  const createChatsRuntime = async ({ sessionStatus = 200 } = {}) => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-runtime-chats-'));
    const chatsScope = createChatsScope(path.join(tempRoot, 'chats'));
    const sessionBodies = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (init.method === 'POST' && pathname === '/api/session') {
        sessionBodies.push(JSON.parse(init.body));
        if (sessionStatus !== 200) return new Response(JSON.stringify({ error: 'boom' }), { status: sessionStatus });
      }
      const data = pathname === '/api/session' ? { id: 'ses_chat' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const projectConfigRuntime = {
      listScheduledTasks: vi.fn(async () => [task]),
      reconcileLoopTasks: vi.fn(async () => [task]),
      updateScheduledTaskState: async () => ({ task, updated: true }),
      updateScheduledTaskStateIf: async () => ({ task, updated: true }),
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime,
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      chatsScope,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    return {
      runtime,
      chatsScope,
      projectConfigRuntime,
      sessionBodies,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  };

  it('schedules chats without discovering loop files', async () => {
    const { runtime, chatsScope, projectConfigRuntime, cleanup } = await createChatsRuntime();
    try {
      await runtime.start();
      runtime.stop();
      expect(projectConfigRuntime.reconcileLoopTasks).toHaveBeenCalledWith('proj', expect.anything());
      expect(projectConfigRuntime.reconcileLoopTasks).not.toHaveBeenCalledWith(chatsScope.id, expect.anything());
      expect(projectConfigRuntime.listScheduledTasks).toHaveBeenCalledWith(chatsScope.id);
    } finally {
      await cleanup();
    }
  });

  it('starts every run in a new chat directory under the chats root', async () => {
    const { runtime, chatsScope, sessionBodies, cleanup } = await createChatsRuntime();
    try {
      await runtime.start();
      const first = await runtime.runNow(chatsScope.id, 'task-1');
      const second = await runtime.runNow(chatsScope.id, 'task-1');
      runtime.stop();

      expect(first.ok).toBe(true);
      expect(first.directory).not.toBe(second.directory);
      for (const result of [first, second]) {
        expect(path.relative(chatsScope.root, result.directory)).toMatch(/^\d{4}-\d{2}-\d{2}[\\/]session-/);
        await expect(stat(result.directory)).resolves.toBeTruthy();
      }
      expect(sessionBodies.map((body) => body.location.directory)).toEqual([first.directory, second.directory]);
    } finally {
      await cleanup();
    }
  });

  it('removes the new chat directory when the session cannot be created', async () => {
    const { runtime, chatsScope, cleanup } = await createChatsRuntime({ sessionStatus: 500 });
    try {
      await runtime.start();
      const result = await runtime.runNow(chatsScope.id, 'task-1');
      runtime.stop();

      expect(result.ok).toBe(false);
      const dayDirectories = await readdir(chatsScope.root);
      expect(dayDirectories).toHaveLength(1);
      expect(await readdir(path.join(chatsScope.root, dayDirectories[0]))).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

describe('scheduled-tasks runtime internal credential', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the server internal credential on every call of a run', async () => {
    const seen = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      seen.push({ pathname: new URL(request.url).pathname, credential: request.headers.get(INTERNAL_AUTH_HEADER) });
      const { pathname } = new URL(request.url);
      const data = pathname === '/api/session' ? { id: 'ses_internal' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule: { kind: 'daily', times: ['03:00'], timezone: 'UTC' },
      execution: { prompt: 'echo ok', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async () => ({ task, updated: true }),
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => internalAuthHeaders(),
      waitForOpenCodeReady: async () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const result = await runtime.runNow('proj', 'task-1');
    runtime.stop();

    expect(result.ok).toBe(true);
    expect(seen.some((call) => call.pathname === '/api/session')).toBe(true);
    const expected = internalAuthHeaders()[INTERNAL_AUTH_HEADER];
    expect(seen.every((call) => call.credential === expected)).toBe(true);
  });
});

describe('scheduled-tasks runtime waits for the turn to end', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createHub = () => {
    const eventSubscribers = new Set();
    const statusSubscribers = new Set();
    return {
      subscribeEvent: (subscriber) => {
        eventSubscribers.add(subscriber);
        return () => eventSubscribers.delete(subscriber);
      },
      subscribeStatus: (subscriber) => {
        statusSubscribers.add(subscriber);
        return () => statusSubscribers.delete(subscriber);
      },
      emit: (payload) => {
        for (const subscriber of eventSubscribers) subscriber({ translated: () => [payload] });
      },
      reconnect: () => {
        for (const subscriber of statusSubscribers) subscriber({ type: 'connect' });
      },
      get subscriberCount() {
        return eventSubscribers.size + statusSubscribers.size;
      },
    };
  };

  const startRun = async ({ hub, schedule = { kind: 'daily', times: ['03:00'], timezone: 'UTC' }, maxRunDurationMs, routes = {} }) => {
    let promptSent;
    const prompted = new Promise((resolve) => { promptSent = resolve; });
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/api/session/ses_run/prompt') promptSent();
      const routed = routes[pathname];
      const data = routed !== undefined ? routed : pathname === '/api/session' ? { id: 'ses_run' } : pathname === '/api/command' ? [] : {};
      return new Response(JSON.stringify({ location: { directory: '/repo' }, data }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    let task = {
      id: 'task-1',
      name: 'Nightly',
      enabled: true,
      schedule,
      execution: { prompt: 'Review open issues', providerID: 'openai', modelID: 'gpt-5' },
      state: { createdAt: 1, updatedAt: 1 },
    };
    const patches = [];
    const runtime = createScheduledTasksRuntime({
      projectConfigRuntime: {
        listScheduledTasks: async () => [task],
        reconcileLoopTasks: async () => [task],
        updateScheduledTaskState: async (_projectID, _taskID, patch) => {
          patches.push(patch);
          task = { ...task, state: { ...task.state, ...patch } };
          return { task, updated: true };
        },
        updateScheduledTaskStateIf: async () => ({ task, updated: true }),
        upsertScheduledTask: async (_projectID, next) => {
          task = next;
          return { task };
        },
      },
      listProjects: async () => [{ id: 'proj', path: '/repo' }],
      buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
      getOpenCodeAuthHeaders: () => ({}),
      waitForOpenCodeReady: async () => {},
      globalEventHub: hub,
      ...(maxRunDurationMs ? { maxRunDurationMs } : {}),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    await runtime.start();
    const run = runtime.runNow('proj', 'task-1');
    await prompted;
    const finalPatch = () => patches.find((patch) => patch.lastStatus && patch.lastStatus !== 'running');
    return { runtime, run, finalPatch, readTask: () => task };
  };

  it('stays running after the prompt is accepted and succeeds when the turn ends', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({ hub });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(finalPatch()).toBeUndefined();
    hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_other' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalPatch()).toBeUndefined();

    hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_run' } });
    const result = await run;
    runtime.stop();

    expect(result.ok).toBe(true);
    expect(finalPatch()).toMatchObject({ lastStatus: 'success', lastSessionId: 'ses_run' });
    expect(hub.subscriberCount).toBe(0);
  });

  it('fails the run when the turn fails', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({ hub });

    hub.emit({ type: 'session.error', properties: { sessionID: 'ses_run', error: { type: 'RateLimit', message: 'rate limited' } } });
    await run;
    runtime.stop();

    expect(finalPatch()).toMatchObject({ lastStatus: 'error', lastError: 'rate limited' });
  });

  it('fails the run when the turn is interrupted', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({ hub });

    hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_run', aborted: true, reason: 'user' } });
    await run;
    runtime.stop();

    expect(finalPatch()).toMatchObject({ lastStatus: 'error' });
    expect(finalPatch().lastError).toContain('interrupted');
  });

  it('reads the outcome from the server when the hub reconnects after the turn ended', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({
      hub,
      routes: {
        '/api/session/active': {},
        '/api/session/ses_run/message': [{ id: 'msg_1', type: 'assistant', error: { type: 'EngineExited', message: 'the CLI exited' } }],
      },
    });

    hub.reconnect();
    await run;
    runtime.stop();

    expect(finalPatch()).toMatchObject({ lastStatus: 'error', lastError: 'the CLI exited' });
  });

  it('keeps waiting after a reconnect while the session still runs', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({
      hub,
      routes: { '/api/session/active': { ses_run: { type: 'running' } } },
    });

    hub.reconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalPatch()).toBeUndefined();

    hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_run' } });
    await run;
    runtime.stop();
    expect(finalPatch()).toMatchObject({ lastStatus: 'success' });
  });

  it('times the whole turn out with the watchdog and stops listening', async () => {
    const hub = createHub();
    const { runtime, run, finalPatch } = await startRun({ hub, maxRunDurationMs: 50 });

    await run;
    runtime.stop();

    expect(finalPatch()).toMatchObject({ lastStatus: 'error', lastError: 'scheduled task run timed out' });
    expect(hub.subscriberCount).toBe(0);
  });
});
