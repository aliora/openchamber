import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHandoffPrompt } from './handoff.js';

// Moves a session to another OpenChamber host. The hosts never talk to each
// other: the UI reads the bundle from the source, posts it to the target and
// marks the source (packages/ui/src/lib/hosts/session-transfer.ts).
//
// A bundle carries the session's settings and metadata, every stored message,
// the handoff text a CLI would get, and, when asked, the working tree's
// uncommitted changes as a binary diff against HEAD plus the untracked files.

export const TRANSFER_BUNDLE_VERSION = 1;

// Untracked files travel inline as base64, so their size is capped.
const MAX_UNTRACKED_FILE_BYTES = 5 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

const normalize = (value) => value.replace(/\\/g, '/');

/** Runs git in `cwd`; resolves `{ ok, stdout, stderr }`, never rejects. */
export const runGit = (cwd, args, { input, encoding = 'utf8' } = {}) => new Promise((resolve) => {
  const child = execFile('git', args, { cwd, encoding, maxBuffer: MAX_GIT_OUTPUT_BYTES }, (error, stdout, stderr) => {
    resolve({ ok: !error, stdout, stderr: String(stderr ?? '').trim() || (error ? error.message : '') });
  });
  if (input !== undefined) child.stdin.end(input);
});

const homeRelative = (cwd, homeDir) => {
  const home = normalize(homeDir).replace(/\/+$/, '');
  const target = normalize(cwd);
  if (target === home) return '';
  return target.startsWith(`${home}/`) ? target.slice(home.length + 1) : null;
};

const readUntrackedFiles = async (cwd, git) => {
  const listed = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!listed.ok) return { files: [], skipped: [] };
  const files = [];
  const skipped = [];
  let total = 0;
  for (const relativePath of listed.stdout.split('\0').filter(Boolean)) {
    const absolute = path.join(cwd, relativePath);
    let stat;
    try {
      stat = await fs.promises.stat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > MAX_UNTRACKED_FILE_BYTES || total + stat.size > MAX_UNTRACKED_TOTAL_BYTES) {
      skipped.push(relativePath);
      continue;
    }
    total += stat.size;
    files.push({ path: relativePath, contentBase64: (await fs.promises.readFile(absolute)).toString('base64') });
  }
  return { files, skipped };
};

/**
 * The working tree of `cwd` as `{ branch, head, remoteUrl, diff, untracked,
 * skippedUntracked }`, or null when `cwd` is not inside a git repository.
 * `diff` is `git diff HEAD --binary`: staged and unstaged changes together.
 */
export const collectGitChanges = async (cwd, git = runGit) => {
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return null;
  const repoRoot = root.stdout.trim();
  const [branch, head, remote, diff] = await Promise.all([
    git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repoRoot, ['rev-parse', 'HEAD']),
    git(repoRoot, ['remote', 'get-url', 'origin']),
    git(repoRoot, ['diff', 'HEAD', '--binary']),
  ]);
  const { files, skipped } = await readUntrackedFiles(repoRoot, git);
  return {
    branch: branch.ok ? branch.stdout.trim() : null,
    head: head.ok ? head.stdout.trim() : null,
    remoteUrl: remote.ok ? remote.stdout.trim() : null,
    // `--show-toplevel` resolves symlinks, so the cwd is compared resolved too.
    repoSubpath: normalize(path.relative(repoRoot, await fs.promises.realpath(cwd).catch(() => cwd))),
    diff: diff.ok ? diff.stdout : '',
    untracked: files,
    skippedUntracked: skipped,
  };
};

/** The package the target host imports. */
export const buildTransferBundle = async ({ session, messages, includeGitChanges = false, git = runGit, homeDir = os.homedir(), hostname = os.hostname() }) => {
  const cwd = session.cwd;
  return {
    version: TRANSFER_BUNDLE_VERSION,
    exportedAt: Date.now(),
    source: { hostname, sessionId: session.id, cwd, homeRelativeCwd: cwd ? homeRelative(cwd, homeDir) : null },
    session: {
      title: session.title ?? null,
      engine: session.engine ?? null,
      model: session.model ?? null,
      effort: session.effort ?? null,
      permissionMode: session.permissionMode ?? null,
      accountLabel: (session.accountId ?? 'default') === 'default' ? null : session.accountLabel,
      projectID: session.projectID ?? null,
      metadata: session.metadata ?? null,
    },
    messages,
    handoffSummary: buildHandoffPrompt(messages, ''),
    git: includeGitChanges && cwd ? await collectGitChanges(cwd, git) : null,
  };
};

const comparableRemote = (url) => (url ?? '')
  .trim()
  .toLowerCase()
  .replace(/\.git$/, '')
  .replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/, '')
  .replace(/^[^@/]+@([^:]+):/, '$1/');

const isDirectory = async (candidate) => {
  try {
    return (await fs.promises.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Where the session runs on this host, first match wins:
 * the directory the user picked; a saved project of the same repository
 * (by origin URL, then by folder name); the same path under this home
 * folder; the source path itself when it exists here; else `fallbackCwd`.
 * Returns `{ cwd, matchedBy }`.
 */
export const resolveTargetCwd = async ({ bundle, requestedCwd, projects = [], homeDir = os.homedir(), fallbackCwd, git = runGit }) => {
  if (requestedCwd) return { cwd: normalize(requestedCwd), matchedBy: 'requested' };
  const subpath = bundle.git?.repoSubpath && bundle.git.repoSubpath !== '' ? bundle.git.repoSubpath : null;
  const within = (root) => normalize(subpath ? path.join(root, subpath) : root);
  const projectPaths = projects.map((project) => project?.path).filter(Boolean);

  const wanted = comparableRemote(bundle.git?.remoteUrl);
  if (wanted) {
    for (const projectPath of projectPaths) {
      const remote = await git(projectPath, ['remote', 'get-url', 'origin']);
      if (remote.ok && comparableRemote(remote.stdout) === wanted) return { cwd: within(projectPath), matchedBy: 'repository' };
    }
  }
  const sourceName = bundle.source?.cwd ? path.basename(normalize(bundle.source.cwd)) : null;
  if (sourceName) {
    const named = projectPaths.find((projectPath) => path.basename(normalize(projectPath)) === sourceName);
    if (named) return { cwd: normalize(named), matchedBy: 'project-name' };
  }
  const relative = bundle.source?.homeRelativeCwd;
  if (relative !== null && relative !== undefined) {
    const underHome = path.join(homeDir, relative);
    if (await isDirectory(underHome)) return { cwd: normalize(underHome), matchedBy: 'home-relative' };
  }
  if (bundle.source?.cwd && await isDirectory(bundle.source.cwd)) return { cwd: normalize(bundle.source.cwd), matchedBy: 'same-path' };
  return { cwd: normalize(fallbackCwd), matchedBy: 'fallback' };
};

const writeUntracked = async (repoRoot, files) => {
  const conflicts = [];
  for (const file of files) {
    const target = path.resolve(repoRoot, file.path);
    // A path from another machine must stay inside this repository.
    if (!target.startsWith(`${path.resolve(repoRoot)}${path.sep}`)) {
      conflicts.push(file.path);
      continue;
    }
    const content = Buffer.from(file.contentBase64, 'base64');
    try {
      const existing = await fs.promises.readFile(target);
      if (!existing.equals(content)) conflicts.push(file.path);
      continue;
    } catch {
      // Missing: written below.
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, content);
  }
  return conflicts;
};

/**
 * Applies the bundle's working tree changes in `cwd`. Never throws: a
 * conflict or a missing repository comes back as `{ applied: false, warning }`
 * and the caller still opens the session.
 */
export const applyGitChanges = async (cwd, changes, git = runGit) => {
  if (!changes) return { applied: false, warning: 'The bundle carries no git changes.' };
  const root = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (!root.ok) return { applied: false, warning: `${cwd} is not a git repository here.` };
  const repoRoot = root.stdout.trim();
  const warnings = [];

  const current = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (changes.branch && current.ok && current.stdout.trim() !== changes.branch) {
    const status = await git(repoRoot, ['status', '--porcelain']);
    const switched = status.ok && status.stdout.trim() === '' && (await git(repoRoot, ['checkout', changes.branch])).ok;
    if (!switched) warnings.push(`Stayed on ${current.stdout.trim()}; the source was on ${changes.branch}.`);
  }

  let patchApplied = true;
  if (changes.diff) {
    // A clean apply is all or nothing. Only a patch that does not apply
    // cleanly goes through --3way, which leaves conflict markers to resolve.
    const clean = (await git(repoRoot, ['apply', '--check', '--whitespace=nowarn', '-'], { input: changes.diff })).ok
      && (await git(repoRoot, ['apply', '--whitespace=nowarn', '-'], { input: changes.diff })).ok;
    if (!clean) {
      const threeWay = await git(repoRoot, ['apply', '--3way', '--whitespace=nowarn', '-'], { input: changes.diff });
      if (!threeWay.ok) {
        patchApplied = false;
        warnings.push(`The changes did not apply cleanly: ${threeWay.stderr}`);
      }
    }
  }

  const conflicts = await writeUntracked(repoRoot, changes.untracked ?? []);
  if (conflicts.length > 0) warnings.push(`Left existing files as they were: ${conflicts.join(', ')}`);
  if (changes.skippedUntracked?.length > 0) warnings.push(`Too large to carry: ${changes.skippedUntracked.join(', ')}`);

  return warnings.length === 0
    ? { applied: true }
    : { applied: patchApplied, warning: warnings.join(' ') };
};

/** `metadata.openchamber.transferredTo` after a move, with the rest of the metadata kept. */
export const withTransferredTo = (metadata, transferredTo) => ({
  ...(metadata ?? {}),
  openchamber: { ...(metadata?.openchamber ?? {}), transferredTo },
});

/** Metadata the target keeps from the source: the old transfer mark and resume timer do not move. */
export const importedMetadata = (metadata, transferredFrom) => {
  const { transferredTo: _transferredTo, autoResume: _autoResume, ...rest } = metadata?.openchamber ?? {};
  return { ...(metadata ?? {}), openchamber: { ...rest, transferredFrom } };
};
