import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// OpenCode 2.x scoped every read to a "location": the directory the request is
// about. The UI still sends it, as `?directory=` or the URI-encoded
// `x-opencode-directory` header, and reads these shapes back.

const execFileAsync = promisify(execFile);

export const requestDirectory = (req, fallback) => {
  if (req.query.directory) return String(req.query.directory);
  const header = req.headers['x-opencode-directory'];
  if (header) return decodeURIComponent(String(header));
  return fallback;
};

const projectIdFor = (directory) => crypto.createHash('sha1').update(directory).digest('hex').slice(0, 16);

export const describeLocation = (directory) => ({
  directory,
  project: { id: projectIdFor(directory), directory, canonical: directory },
});

/** One project per distinct session directory, newest activity first. */
export const describeProjects = (sessions) => {
  const byDirectory = new Map();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const created = session.createdAt || 0;
    const updated = session.updatedAt || created;
    const current = byDirectory.get(session.cwd);
    if (!current) {
      byDirectory.set(session.cwd, {
        id: projectIdFor(session.cwd),
        canonical: session.cwd,
        time: { created, updated, active: updated },
        sandboxes: [],
      });
      continue;
    }
    current.time.created = Math.min(current.time.created, created);
    current.time.updated = Math.max(current.time.updated, updated);
    current.time.active = current.time.updated;
  }
  return [...byDirectory.values()];
};

/** The branch of the repository at `directory`. A folder outside git has no provider. */
export const readVcs = async (directory) => {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: directory,
      timeout: 3000,
      windowsHide: true,
    });
    return { provider: 'git', branch: { current: stdout.trim() } };
  } catch {
    return { branch: {} };
  }
};
