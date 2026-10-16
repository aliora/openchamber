import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// How Claude Code is given OpenChamber's tool server.
//
// `--mcp-config` takes a file or an inline JSON string. Inline JSON would put
// the token in argv, which every user on the machine can read through `ps`.
// The config therefore goes into a file of its own: a fresh directory from
// mkdtemp (0700) holding one file written 0600, removed when the process ends.
// The token is never in the environment either, so commands the agent runs
// through its shell do not inherit it. On Windows the file inherits the
// per-user temp folder's access rules.

/** The config Claude Code reads: one HTTP MCP server, the token as a header. */
export const claudeMcpConfig = ({ name, url, token }) => ({
  mcpServers: {
    [name]: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
    },
  },
});

/**
 * Writes the config for one process. `remove()` deletes it and is safe to
 * call twice; a failed write leaves nothing behind.
 */
export const writeClaudeMcpConfig = (toolServer, directory = os.tmpdir()) => {
  const folder = fs.mkdtempSync(path.join(directory, 'openchamber-mcp-'));
  const remove = () => fs.rmSync(folder, { recursive: true, force: true });
  const file = path.join(folder, 'mcp.json');
  try {
    fs.writeFileSync(file, JSON.stringify(claudeMcpConfig(toolServer)), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    remove();
    throw error;
  }
  return { path: file, remove };
};
