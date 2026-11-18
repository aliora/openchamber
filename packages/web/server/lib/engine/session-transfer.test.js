import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyGitChanges,
  buildTransferBundle,
  collectGitChanges,
  importedMetadata,
  resolveTargetCwd,
  TRANSFER_BUNDLE_VERSION,
  withTransferredTo,
} from './session-transfer.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

const initRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
};

const commitAll = (dir, message = 'commit') => {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', message);
};

const cloneRepo = (source, target) => {
  git(os.tmpdir(), 'clone', source, target);
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'user.name', 'Test');
};

describe('session transfer', () => {
  let tmpDir;
  let source;

  const write = (dir, relativePath, content) => {
    const target = path.join(dir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const read = (dir, relativePath) => fs.readFileSync(path.join(dir, relativePath), 'utf8');

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-transfer-test-')));
    source = path.join(tmpDir, 'source');
    initRepo(source);
    write(source, 'a.txt', 'one\ntwo\nthree\n');
    write(source, 'staged.txt', 'staged base\n');
    write(source, 'sub/inner.txt', 'inner\n');
    commitAll(source, 'initial');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('collectGitChanges', () => {
    it('returns null outside a repository', async () => {
      const plain = path.join(tmpDir, 'plain');
      fs.mkdirSync(plain);
      expect(await collectGitChanges(plain)).toBeNull();
    });

    it('captures branch, head and a clean tree', async () => {
      const changes = await collectGitChanges(source);
      expect(changes).toMatchObject({
        branch: 'main',
        head: git(source, 'rev-parse', 'HEAD'),
        remoteUrl: null,
        repoSubpath: '',
        diff: '',
        untracked: [],
        skippedUntracked: [],
      });
    });

    it('reads the subpath of a cwd reached through a symlink', async () => {
      fs.mkdirSync(path.join(source, 'sub'), { recursive: true });
      const link = path.join(tmpDir, 'link');
      fs.symlinkSync(source, link);
      expect((await collectGitChanges(path.join(link, 'sub'))).repoSubpath).toBe('sub');
    });

    it('captures staged and unstaged edits in one diff', async () => {
      write(source, 'staged.txt', 'staged edit\n');
      git(source, 'add', 'staged.txt');
      write(source, 'a.txt', 'one\nTWO\nthree\n');
      const { diff } = await collectGitChanges(source);
      expect(diff).toContain('+staged edit');
      expect(diff).toContain('+TWO');
    });

    it('captures untracked files as base64 and skips ignored ones', async () => {
      write(source, '.gitignore', 'ignored.txt\n');
      commitAll(source, 'ignore');
      write(source, 'new/file.bin', Buffer.from([0, 1, 2, 255]));
      write(source, 'ignored.txt', 'nope');
      const { untracked } = await collectGitChanges(source);
      expect(untracked).toEqual([{ path: 'new/file.bin', contentBase64: Buffer.from([0, 1, 2, 255]).toString('base64') }]);
    });

    it('records the subfolder of a cwd inside the repository', async () => {
      const changes = await collectGitChanges(path.join(source, 'sub'));
      expect(changes.repoSubpath).toBe('sub');
    });

    it('records the origin remote url', async () => {
      git(source, 'remote', 'add', 'origin', 'git@github.com:a/b.git');
      expect((await collectGitChanges(source)).remoteUrl).toBe('git@github.com:a/b.git');
    });

    it('skips an untracked file above the size cap', async () => {
      write(source, 'big.bin', Buffer.alloc(6 * 1024 * 1024, 1));
      write(source, 'small.txt', 'small');
      const { untracked, skippedUntracked } = await collectGitChanges(source);
      expect(skippedUntracked).toEqual(['big.bin']);
      expect(untracked.map((file) => file.path)).toEqual(['small.txt']);
    });
  });

  describe('applyGitChanges', () => {
    let target;

    beforeEach(() => {
      target = path.join(tmpDir, 'target');
      cloneRepo(source, target);
    });

    it('applies staged, unstaged and untracked changes to a clone', async () => {
      write(source, 'staged.txt', 'staged edit\n');
      git(source, 'add', 'staged.txt');
      write(source, 'a.txt', 'one\nTWO\nthree\n');
      write(source, 'docs/new.md', '# new\n');
      const changes = await collectGitChanges(source);

      expect(await applyGitChanges(target, changes)).toEqual({ applied: true });
      expect(read(target, 'staged.txt')).toBe('staged edit\n');
      expect(read(target, 'a.txt')).toBe('one\nTWO\nthree\n');
      expect(read(target, 'docs/new.md')).toBe('# new\n');
    });

    it('applies a binary change', async () => {
      write(source, 'logo.bin', Buffer.from([0, 1, 2, 3]));
      commitAll(source, 'add binary');
      git(target, 'pull', '--quiet');
      write(source, 'logo.bin', Buffer.from([9, 8, 7, 0, 1]));
      const changes = await collectGitChanges(source);

      expect(await applyGitChanges(target, changes)).toEqual({ applied: true });
      expect(fs.readFileSync(path.join(target, 'logo.bin'))).toEqual(Buffer.from([9, 8, 7, 0, 1]));
    });

    it('reports a conflicting local edit without throwing', async () => {
      write(source, 'a.txt', 'one\nsource edit\nthree\n');
      const changes = await collectGitChanges(source);
      write(target, 'a.txt', 'one\nlocal edit\nthree\n');

      const result = await applyGitChanges(target, changes);
      expect(result.warning).toEqual(expect.any(String));
      expect(result.warning.length).toBeGreaterThan(0);
    });

    it('returns applied false with a warning outside a repository', async () => {
      const plain = path.join(tmpDir, 'plain');
      fs.mkdirSync(plain);
      const result = await applyGitChanges(plain, { diff: '', untracked: [] });
      expect(result.applied).toBe(false);
      expect(result.warning).toContain('not a git repository');
    });

    it('returns applied false without changes', async () => {
      const result = await applyGitChanges(target, null);
      expect(result.applied).toBe(false);
      expect(result.warning).toBeTruthy();
    });

    it('refuses an untracked path that escapes the repository', async () => {
      const changes = {
        diff: '',
        untracked: [
          { path: '../escape.txt', contentBase64: Buffer.from('evil').toString('base64') },
          { path: 'ok.txt', contentBase64: Buffer.from('fine').toString('base64') },
        ],
      };
      const result = await applyGitChanges(target, changes);
      expect(fs.existsSync(path.join(tmpDir, 'escape.txt'))).toBe(false);
      expect(read(target, 'ok.txt')).toBe('fine');
      expect(result.warning).toContain('../escape.txt');
    });

    it('leaves an existing untracked file with different content and lists it', async () => {
      write(target, 'notes.txt', 'mine');
      const changes = {
        diff: '',
        untracked: [
          { path: 'notes.txt', contentBase64: Buffer.from('theirs').toString('base64') },
          { path: 'same.txt', contentBase64: Buffer.from('same').toString('base64') },
        ],
      };
      write(target, 'same.txt', 'same');
      const result = await applyGitChanges(target, changes);
      expect(read(target, 'notes.txt')).toBe('mine');
      expect(result.warning).toContain('notes.txt');
      expect(result.warning).not.toContain('same.txt');
    });

    it('mentions files skipped for size', async () => {
      const result = await applyGitChanges(target, { diff: '', untracked: [], skippedUntracked: ['big.bin'] });
      expect(result.applied).toBe(true);
      expect(result.warning).toContain('big.bin');
    });

    it('stays on the current branch when the working tree is dirty', async () => {
      git(source, 'checkout', '-b', 'feature');
      write(source, 'a.txt', 'one\ntwo\nthree\nfour\n');
      const changes = await collectGitChanges(source);
      git(target, 'fetch', '--quiet', 'origin', 'feature:feature');
      write(target, 'dirty.txt', 'x');
      git(target, 'add', 'dirty.txt');

      const result = await applyGitChanges(target, changes);
      expect(result.warning).toContain('Stayed on main');
      expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    });

    it('switches to the source branch when the tree is clean', async () => {
      git(source, 'checkout', '-b', 'feature');
      const changes = await collectGitChanges(source);
      git(target, 'fetch', '--quiet', 'origin', 'feature:feature');

      expect(await applyGitChanges(target, changes)).toEqual({ applied: true });
      expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature');
    });
  });

  describe('resolveTargetCwd', () => {
    let homeDir;
    const fallbackCwd = '/fallback';

    beforeEach(() => {
      homeDir = path.join(tmpDir, 'home');
      fs.mkdirSync(homeDir);
    });

    const bundleOf = (overrides = {}) => ({
      source: { cwd: '/Users/other/work/app', homeRelativeCwd: 'work/app', hostname: 'other' },
      git: null,
      ...overrides,
    });
    const resolve = (options) => resolveTargetCwd({ homeDir, fallbackCwd, ...options });

    it('uses the requested directory first', async () => {
      const result = await resolve({ bundle: bundleOf(), requestedCwd: '/picked', projects: [{ path: source }] });
      expect(result).toEqual({ cwd: '/picked', matchedBy: 'requested' });
    });

    it('matches a project by origin url across ssh and https forms and appends the subpath', async () => {
      const project = path.join(tmpDir, 'project');
      initRepo(project);
      git(project, 'remote', 'add', 'origin', 'https://github.com/a/b');
      const bundle = bundleOf({ git: { remoteUrl: 'git@github.com:a/b.git', repoSubpath: 'packages/web' } });

      const result = await resolve({ bundle, projects: [{ path: path.join(tmpDir, 'nowhere') }, { path: project }] });
      expect(result).toEqual({ cwd: `${project}/packages/web`, matchedBy: 'repository' });
    });

    it('does not match a project with a different remote', async () => {
      const project = path.join(tmpDir, 'project');
      initRepo(project);
      git(project, 'remote', 'add', 'origin', 'https://github.com/a/other');
      const bundle = bundleOf({ git: { remoteUrl: 'git@github.com:a/b.git', repoSubpath: '' } });

      const result = await resolve({ bundle, projects: [{ path: project }] });
      expect(result.matchedBy).toBe('fallback');
    });

    it('matches a project by folder name', async () => {
      const result = await resolve({ bundle: bundleOf(), projects: [{ path: '/elsewhere/app' }] });
      expect(result).toEqual({ cwd: '/elsewhere/app', matchedBy: 'project-name' });
    });

    it('matches the same path under the home folder', async () => {
      fs.mkdirSync(path.join(homeDir, 'work/app'), { recursive: true });
      const result = await resolve({ bundle: bundleOf() });
      expect(result).toEqual({ cwd: path.join(homeDir, 'work/app'), matchedBy: 'home-relative' });
    });

    it('uses the source path when it exists here', async () => {
      const bundle = bundleOf({ source: { cwd: source, homeRelativeCwd: null } });
      expect(await resolve({ bundle })).toEqual({ cwd: source, matchedBy: 'same-path' });
    });

    it('falls back when nothing matches', async () => {
      expect(await resolve({ bundle: bundleOf() })).toEqual({ cwd: fallbackCwd, matchedBy: 'fallback' });
    });
  });

  describe('buildTransferBundle', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'hello', parts: [{ type: 'text', text: 'hello' }] },
      { id: 'm2', role: 'assistant', content: 'hi', parts: [{ type: 'text', text: 'hi there' }] },
    ];
    const session = () => ({
      id: 's1',
      title: 'Title',
      engine: 'claude',
      model: 'sonnet',
      effort: 'high',
      permissionMode: 'auto',
      cwd: source,
      metadata: { openchamber: { work: 1 } },
    });

    it('builds a version 1 bundle with the handoff summary and no git by default', async () => {
      const homeDir = path.dirname(source);
      const bundle = await buildTransferBundle({ session: session(), messages, homeDir, hostname: 'mac' });
      expect(bundle.version).toBe(1);
      expect(TRANSFER_BUNDLE_VERSION).toBe(1);
      expect(bundle.source).toEqual({ hostname: 'mac', sessionId: 's1', cwd: source, homeRelativeCwd: 'source' });
      expect(bundle.session).toMatchObject({ title: 'Title', engine: 'claude', model: 'sonnet', metadata: { openchamber: { work: 1 } } });
      expect(bundle.messages).toEqual(messages);
      expect(bundle.handoffSummary).toContain('<previous_conversation>');
      expect(bundle.handoffSummary).toContain('hi there');
      expect(bundle.git).toBeNull();
    });

    it('collects git changes when asked', async () => {
      write(source, 'new.txt', 'new');
      const bundle = await buildTransferBundle({ session: session(), messages, includeGitChanges: true });
      expect(bundle.git.branch).toBe('main');
      expect(bundle.git.untracked.map((file) => file.path)).toEqual(['new.txt']);
    });

    it('marks a cwd outside the home folder as not home relative', async () => {
      const bundle = await buildTransferBundle({ session: session(), messages, homeDir: '/somewhere/else' });
      expect(bundle.source.homeRelativeCwd).toBeNull();
    });
  });

  describe('metadata helpers', () => {
    it('importedMetadata drops transferredTo and autoResume and adds transferredFrom', () => {
      const from = { hostLabel: 'Mac', sessionId: 's1', transferredAt: 1 };
      const result = importedMetadata({ other: 1, openchamber: { work: 'x', transferredTo: { a: 1 }, autoResume: { enabled: true } } }, from);
      expect(result).toEqual({ other: 1, openchamber: { work: 'x', transferredFrom: from } });
    });

    it('importedMetadata copes with missing metadata', () => {
      expect(importedMetadata(null, { sessionId: 's' })).toEqual({ openchamber: { transferredFrom: { sessionId: 's' } } });
    });

    it('withTransferredTo keeps the other keys', () => {
      const result = withTransferredTo({ other: 1, openchamber: { work: 'x', autoResume: { enabled: true } } }, { hostLabel: 'PC' });
      expect(result).toEqual({ other: 1, openchamber: { work: 'x', autoResume: { enabled: true }, transferredTo: { hostLabel: 'PC' } } });
    });
  });
});
