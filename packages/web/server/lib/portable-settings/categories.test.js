import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPortableSettingsCatalog } from './catalog.js';
import {
  createGitIdentitiesCategory,
  createMcpCategory,
  createProjectsCategory,
  createScheduledTasksCategory,
  createSkillsCategory,
} from './categories.js';

const silentLogger = { warn: vi.fn() };

let home;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'portable-settings-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

const catalogOf = (categories) => createPortableSettingsCatalog({
  categories,
  pathExists: async (target) => fs.existsSync(target),
  expandPath: (portablePath) => (portablePath.startsWith('~/') ? path.join(home, portablePath.slice(2)) : portablePath),
  logger: silentLogger,
});

const discoverFrom = (roots) => async () => roots.flatMap((root) => {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'SKILL.md')))
    .map((name) => ({ name, path: path.join(root, name, 'SKILL.md'), scope: 'user' }));
});

describe('skills', () => {
  const skillsCategory = () => {
    const roots = [path.join(home, '.agents', 'skills'), path.join(home, '.claude', 'skills')];
    return createSkillsCategory({ discoverSkills: discoverFrom(roots), userSkillRoots: roots, home });
  };

  it('copies a skill folder with its files into the same root on the target', async () => {
    writeFile(path.join(home, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nRun it');
    writeFile(path.join(home, '.agents', 'skills', 'deploy', 'scripts', 'run.sh'), 'echo hi');
    const catalog = catalogOf({ skills: skillsCategory() });
    const [exported] = await catalog.exportItems([{ category: 'skills', key: 'deploy' }]);
    expect(exported.status).toBe('found');
    expect(exported.value.root).toBe('~/.agents/skills');

    fs.rmSync(path.join(home, '.agents', 'skills', 'deploy'), { recursive: true });
    const results = await catalog.importItems({ items: [{ category: 'skills', key: 'deploy', value: exported.value }] });

    expect(results).toEqual([{ category: 'skills', key: 'deploy', status: 'applied' }]);
    expect(fs.readFileSync(path.join(home, '.agents', 'skills', 'deploy', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi');
  });

  it('refuses a new skill when the target has no such skills folder', async () => {
    const catalog = catalogOf({ skills: skillsCategory() });
    const value = { root: '~/.claude/skills', dir: 'deploy', files: [{ path: 'SKILL.md', content: Buffer.from('x').toString('base64') }] };

    const results = await catalog.importItems({ items: [{ category: 'skills', key: 'deploy', value }] });

    expect(results).toEqual([{ category: 'skills', key: 'deploy', status: 'refused', reason: 'path-missing', path: '~/.claude/skills' }]);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
  });

  it('replaces an existing skill so files the source no longer has are gone', async () => {
    writeFile(path.join(home, '.agents', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nold');
    writeFile(path.join(home, '.agents', 'skills', 'deploy', 'stale.md'), 'stale');
    const value = { root: '~/.agents/skills', dir: 'deploy', files: [{ path: 'SKILL.md', content: Buffer.from('---\nname: deploy\n---\nnew').toString('base64') }] };

    const results = await catalogOf({ skills: skillsCategory() }).importItems({ items: [{ category: 'skills', key: 'deploy', value }], force: true });

    expect(results[0].status).toBe('applied');
    expect(fs.readdirSync(path.join(home, '.agents', 'skills', 'deploy'))).toEqual(['SKILL.md']);
  });

  it('refuses file paths that leave the skill folder', async () => {
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    const value = { root: '~/.agents/skills', dir: 'deploy', files: [{ path: 'SKILL.md', content: '' }, { path: '../escape.sh', content: '' }] };
    const results = await catalogOf({ skills: skillsCategory() }).importItems({ items: [{ category: 'skills', key: 'deploy', value }] });
    expect(results).toEqual([{ category: 'skills', key: 'deploy', status: 'refused', reason: 'invalid' }]);
  });

  it('refuses to overwrite a folder that holds another skill', async () => {
    writeFile(path.join(home, '.agents', 'skills', 'deploy', 'notes.md'), 'not a skill');
    const value = { root: '~/.agents/skills', dir: 'deploy', files: [{ path: 'SKILL.md', content: '' }] };
    const results = await catalogOf({ skills: skillsCategory() }).importItems({ items: [{ category: 'skills', key: 'deploy', value }] });
    expect(results).toEqual([{ category: 'skills', key: 'deploy', status: 'refused', reason: 'conflict' }]);
  });
});

describe('mcp', () => {
  it('replaces an existing entry and keeps project entries out', async () => {
    const calls = [];
    const category = createMcpCategory({
      listMcpConfigs: () => [
        { name: 'github', scope: 'user', sectionKey: 'mcp', legacy: false, type: 'remote', url: 'https://example.test', headers: { Authorization: 'Bearer secret-token' } },
        { name: 'local-only', scope: 'project', type: 'local', command: ['node'] },
      ],
      createMcpConfig: (name, value, directory, scope) => calls.push(['create', name, value, directory, scope]),
      deleteMcpConfig: (name, directory) => calls.push(['delete', name, directory]),
    });
    const items = await category.list();
    expect(items.map((item) => item.key)).toEqual(['github']);
    expect(items[0].value).toEqual({ type: 'remote', url: 'https://example.test', headers: { Authorization: 'Bearer secret-token' } });

    await category.write('github', { type: 'remote', url: 'https://other.test' }, items[0]);
    expect(calls).toEqual([
      ['delete', 'github', null],
      ['create', 'github', { type: 'remote', url: 'https://other.test' }, null, 'user'],
    ]);
  });

  it('needs an absolute command path to exist on the target', () => {
    const category = createMcpCategory({ listMcpConfigs: () => [], createMcpConfig: () => {}, deleteMcpConfig: () => {} });
    expect(category.requiredPaths('tool', { type: 'local', command: ['/opt/homebrew/bin/tool', '--stdio'] })).toEqual(['/opt/homebrew/bin/tool']);
    expect(category.requiredPaths('tool', { type: 'local', command: ['npx', 'tool'] })).toEqual([]);
  });
});

describe('git identities', () => {
  it('keeps how the target authenticates and copies who commits', async () => {
    const updates = [];
    const category = createGitIdentitiesCategory({
      getProfiles: () => [{ id: 'work', name: 'Work', userName: 'Old', userEmail: 'old@example.test', transport: 'ssh', sshCredentialId: 'key-1', account: null, signingKey: '~/.ssh/old.pub' }],
      toPublicGitIdentityProfile: (profile) => profile,
      createProfile: () => {},
      updateProfile: (id, profile) => updates.push([id, profile]),
      deleteProfile: () => {},
    });
    const [current] = await category.list();
    const value = category.parse('work', { name: 'Work', userName: 'New', userEmail: 'new@example.test' });

    await category.write('work', value, current);

    expect(updates).toEqual([['work', {
      id: 'work', name: 'Work', userName: 'New', userEmail: 'new@example.test', signCommits: false,
      signingKey: null, color: null, icon: null, account: null, transport: 'ssh', sshCredentialId: 'key-1',
    }]]);
  });

  it('a new identity starts with the machine Git', async () => {
    const created = [];
    const category = createGitIdentitiesCategory({
      getProfiles: () => [],
      toPublicGitIdentityProfile: (profile) => profile,
      createProfile: (profile) => created.push(profile),
      updateProfile: () => {},
      deleteProfile: () => {},
    });
    await category.write('home', category.parse('home', { name: 'Home', userName: 'Me', userEmail: 'me@example.test' }), null);
    expect(created[0]).toMatchObject({ id: 'home', transport: 'system', account: null });
  });
});

describe('projects', () => {
  const projectsCategory = (projects, persisted) => createProjectsCategory({
    readSettingsFromDiskMigrated: async () => ({ projects }),
    sanitizeProjects: (input) => input,
    persistSettings: async (update) => persisted.push(update),
    createProjectIdFromPath: (projectPath) => `id:${projectPath}`,
    home,
    now: () => 42,
  });

  it('lists projects by their path under the home folder', async () => {
    const items = await projectsCategory([{ id: 'p1', path: path.join(home, 'work', 'app'), label: 'App', lastOpenedAt: 9 }], []).list();
    expect(items.map(({ key, value, paths }) => ({ key, value, paths }))).toEqual([{ key: '~/work/app', value: { label: 'App' }, paths: ['~/work/app'] }]);
  });

  it('adds a missing project at the target home and updates an existing one in place', async () => {
    const persisted = [];
    const existing = { id: 'p1', path: path.join(home, 'work', 'app'), label: 'Old', color: 'red', lastOpenedAt: 9 };
    const category = projectsCategory([existing], persisted);
    const [current] = await category.list();

    await category.write('~/work/app', { label: 'App' }, current);
    await category.write('~/work/site', { label: 'Site' }, null);

    expect(persisted[0].projects).toEqual([{ id: 'p1', path: existing.path, lastOpenedAt: 9, label: 'App' }]);
    expect(persisted[1].projects.at(-1)).toEqual({ id: `id:${path.join(home, 'work', 'site')}`, path: path.join(home, 'work', 'site'), label: 'Site', addedAt: 42 });
  });
});

describe('scheduled tasks', () => {
  it('leaves loop and session tasks out and refuses a project the target has not registered', async () => {
    const upserts = [];
    const category = createScheduledTasksCategory({
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'p1', path: path.join(home, 'work', 'app') }] }),
      sanitizeProjects: (input) => input,
      projectConfigRuntime: {
        listScheduledTasks: async () => [
          { id: 't1', name: 'Nightly', enabled: true, schedule: { kind: 'daily' }, execution: {}, state: { updatedAt: 7 } },
          { id: 't2', name: 'Loop', loopFile: '/x.md', state: {} },
          { id: 't3', name: 'Ping', targetSessionId: 'ses_1', state: {} },
        ],
      },
      scheduledTaskService: { upsert: async (projectId, task) => upserts.push([projectId, task]), remove: async () => {} },
      home,
    });
    fs.mkdirSync(path.join(home, 'work', 'app'), { recursive: true });
    fs.mkdirSync(path.join(home, 'work', 'other'), { recursive: true });
    const items = await category.list();
    expect(items.map((item) => item.key)).toEqual(['t1@~/work/app']);
    expect(items[0].value).toEqual({ name: 'Nightly', enabled: true, schedule: { kind: 'daily' }, execution: {} });

    const results = await catalogOf({ scheduledTasks: category }).importItems({
      items: [
        { category: 'scheduledTasks', key: 't9@~/work/other', value: { name: 'Other' } },
        { category: 'scheduledTasks', key: 't9@~/work/app', value: { name: 'Other' } },
      ],
    });
    expect(results.map((result) => result.reason ?? result.status)).toEqual(['project-missing', 'applied']);
    expect(upserts).toEqual([['p1', { name: 'Other', id: 't9' }]]);

    const [byProjectId] = await catalogOf({ scheduledTasks: category }).exportItems([{ category: 'scheduledTasks', key: 't1@p1' }]);
    expect(byProjectId).toMatchObject({ key: 't1@~/work/app', status: 'found' });
  });
});

describe('project keys', () => {
  it('exports a project asked for by its absolute path under its portable key', async () => {
    const category = createProjectsCategory({
      readSettingsFromDiskMigrated: async () => ({ projects: [{ id: 'p1', path: path.join(home, 'work', 'app'), label: 'App' }] }),
      sanitizeProjects: (input) => input,
      persistSettings: async () => {},
      createProjectIdFromPath: (projectPath) => projectPath,
      home,
    });
    const [exported] = await catalogOf({ projects: category }).exportItems([{ category: 'projects', key: path.join(home, 'work', 'app') }]);
    expect(exported).toEqual({ category: 'projects', key: '~/work/app', status: 'found', value: { label: 'App' }, updatedAt: null });
  });
});

describe('large skills', () => {
  it('lists a skill over the limit without reading its files and refuses to export it', async () => {
    const root = path.join(home, '.agents', 'skills');
    writeFile(path.join(root, 'huge', 'SKILL.md'), '---\nname: huge\n---\n');
    for (let index = 0; index < 205; index += 1) writeFile(path.join(root, 'huge', 'parts', `${index}.txt`), 'x');
    const category = createSkillsCategory({ discoverSkills: discoverFrom([root]), userSkillRoots: [root], home });
    const catalog = catalogOf({ skills: category });

    const snapshot = await catalog.snapshot();
    expect(snapshot.categories.skills.items.map((item) => item.key)).toEqual(['huge']);
    expect(await catalog.exportItems([{ category: 'skills', key: 'huge' }])).toEqual([{ category: 'skills', key: 'huge', status: 'refused', reason: 'too-large' }]);
  });
});
