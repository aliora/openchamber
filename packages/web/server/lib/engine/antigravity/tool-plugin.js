import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeQuestionHook } from './question-hook.js';

const PLUGIN_NAME = 'openchamber';

export const agyServerName = (toolServerName) => `${PLUGIN_NAME}_${toolServerName}`;

const mcpConfig = ({ name, url, token }) => ({
  mcpServers: {
    [name]: { url, headers: { Authorization: `Bearer ${token}` } },
  },
});

const writePrivateFile = (file, content) => fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });

/**
 * Writes a workspace root holding one agy plugin with, each when given,
 * OpenChamber's tool server, the tool instructions as a plugin rule and the
 * question hook. `root` goes to `--add-dir`; `remove()` deletes it and is safe
 * to call twice.
 */
export const writeAgyToolPlugin = ({ toolServer, instructions, askQuestions }, directory = os.tmpdir()) => {
  const root = fs.mkdtempSync(path.join(directory, 'openchamber-agy-'));
  const remove = () => fs.rmSync(root, { recursive: true, force: true });
  const plugin = path.join(root, '.agents', 'plugins', PLUGIN_NAME);
  try {
    fs.mkdirSync(path.join(plugin, 'rules'), { recursive: true, mode: 0o700 });
    writePrivateFile(path.join(plugin, 'plugin.json'), JSON.stringify({ name: PLUGIN_NAME }));
    if (toolServer) writePrivateFile(path.join(plugin, 'mcp_config.json'), JSON.stringify(mcpConfig(toolServer)));
    if (instructions) writePrivateFile(path.join(plugin, 'rules', 'AGENTS.md'), `${instructions}\n`);
    if (askQuestions) writeQuestionHook(plugin);
  } catch (error) {
    remove();
    throw error;
  }
  return { root, plugin, remove };
};
