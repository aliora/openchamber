import nodePath from 'node:path';

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_WORKSPACES = 8;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

const isSubsequence = (needle, haystack) => {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
};

const matchRank = (query, candidate) => {
  const lowered = candidate.toLowerCase();
  const name = nodePath.posix.basename(lowered);
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (lowered.includes(query)) return 3;
  if (isSubsequence(query, lowered)) return 4;
  return null;
};

const rankEntries = (entries, query, limit) => {
  const needle = query.trim().toLowerCase();
  const ranked = [];
  for (const entry of entries) {
    const rank = matchRank(needle, entry.path);
    if (rank !== null) ranked.push({ entry, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.entry.path.length - b.entry.path.length || a.entry.path.localeCompare(b.entry.path));
  return ranked.slice(0, limit).map(({ entry }) => entry);
};

const toEntries = (files) => {
  const directories = new Set();
  for (const file of files) {
    for (let parent = nodePath.posix.dirname(file); parent !== '.'; parent = nodePath.posix.dirname(parent)) {
      if (directories.has(parent)) break;
      directories.add(parent);
    }
  }
  return [
    ...files.map((file) => ({ path: file, type: 'file' })),
    ...[...directories].map((directory) => ({ path: directory, type: 'directory' })),
  ];
};

export const createFileFinder = ({
  spawn,
  resolveRipgrepBinary,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  now = () => Date.now(),
}) => {
  const workspaces = new Map();

  const listFiles = async (directory) => {
    const binary = await resolveRipgrepBinary();
    if (!binary) throw new Error('ripgrep is not available on this server');
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ['--files', '--no-messages'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error(`Listing ${directory} took longer than ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on('data', (data) => {
        bytes += data.length;
        if (bytes > maxOutputBytes) {
          child.kill();
          finish(new Error(`${directory} has too many files to search`));
          return;
        }
        chunks.push(data);
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (code !== 0 && code !== 1) {
          finish(new Error(`ripgrep exited with code ${code}`));
          return;
        }
        const files = Buffer.concat(chunks).toString('utf8').split('\n')
          .filter(Boolean)
          .map((file) => file.split(nodePath.sep).join('/'));
        finish(null, toEntries(files));
      });
    });
  };

  const load = (directory) => {
    const cached = workspaces.get(directory);
    if (cached && (cached.pending || now() - cached.loadedAt < ttlMs)) return cached.pending ?? Promise.resolve(cached.entries);
    const pending = listFiles(directory).then(
      (entries) => {
        workspaces.set(directory, { loadedAt: now(), pending: null, entries });
        return entries;
      },
      (error) => {
        workspaces.delete(directory);
        throw error;
      },
    );
    workspaces.delete(directory);
    workspaces.set(directory, { loadedAt: 0, pending, entries: null });
    while (workspaces.size > MAX_WORKSPACES) workspaces.delete(workspaces.keys().next().value);
    return pending;
  };

  const find = async (directory, { query, type, limit }) => {
    const entries = await load(directory);
    const candidates = type ? entries.filter((entry) => entry.type === type) : entries;
    const capped = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;
    return rankEntries(candidates, query, capped);
  };

  return { find };
};
