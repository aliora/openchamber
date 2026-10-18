import { getCurrentVersion } from '../../package-manager.js';
import { CODEX_PERMISSION_MODES, CodexProcess } from './codex-process.js';
import { CodexInstaller } from './installer.js';
import { createCodexModelCatalog, readCodexModels } from './model-catalog.js';
import { runCodexCommand, startCodexLogin } from './platform.js';

// The Codex engine: runs the official `codex app-server` and maps its JSON-RPC
// notifications to the engine events in ../DOCUMENTATION.md.

/**
 * `codex login status` exits 0 when signed in and prints one line to stderr:
 * "Logged in using ChatGPT", "Logged in using an API key - <masked key>" or
 * "Not logged in". Only the sign-in method is read from it; the line itself
 * is never returned or logged.
 */
export const getCodexAuthStatus = async ({ run = runCodexCommand } = {}) => {
  const result = await run(['login', 'status'], { timeoutMs: 5000 });
  if (result.error) return { loggedIn: false, email: null, reason: 'codex_unavailable' };
  if (result.code !== 0) return { loggedIn: false, email: null, reason: 'not_logged_in' };
  const output = `${result.stdout}\n${result.stderr}`;
  let authMethod = 'unknown';
  if (/api key/i.test(output)) authMethod = 'apikey';
  else if (/chatgpt/i.test(output)) authMethod = 'chatgpt';
  return { loggedIn: true, email: null, subscriptionType: 'unknown', authMethod };
};

const logoutCodex = async () => {
  const result = await runCodexCommand(['logout'], { timeoutMs: 5000 });
  if (result.error || result.code !== 0) {
    throw new Error(`codex logout did not finish (${result.error || `exit code ${result.code}`}). Run \`codex logout\` in a terminal.`);
  }
};

export const createCodexEngine = ({
  installer = new CodexInstaller(),
  authStatusProvider = getCodexAuthStatus,
  // Tests pass a fake; otherwise each process spawns the resolved `codex` binary.
  spawnProcess,
  // Tests pass a fake; otherwise the catalog reads `model/list` from the CLI.
  readModels,
} = {}) => {
  const clientVersion = getCurrentVersion();
  const models = createCodexModelCatalog({
    read: readModels ?? (() => readCodexModels({ spawnProcess, clientVersion })),
    // The binary and version a read would run; another one lists models anew.
    identify: () => {
      const status = installer.getStatus();
      return status.installed ? `${status.command} ${status.version}` : null;
    },
  });
  return {
    id: 'codex',
    displayName: 'Codex',
    providerID: 'openai',
    // The models the installed CLI lists, read in the background (model-catalog.js).
    modelCatalog: models.current,
    startModelCatalog: models.start,
    // The model catalog bundled with codex-cli 0.163.0 gives every listed
    // model a 272K context window. It states no output cap, and `model/list`
    // names neither.
    limit: { context: 272_000 },
    // The reasoning efforts of the fallback models. A model read from the CLI
    // lists its own.
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    permissionModes: Object.keys(CODEX_PERMISSION_MODES),
    defaultPermissionMode: 'on-request',
    dangerousPermissionModes: ['full-access'],
    installer,
    auth: {
      status: authStatusProvider,
      login: startCodexLogin,
      logout: logoutCodex,
      loginCommand: 'codex login',
    },
    createProcess: (options) => new CodexProcess({ ...options, spawnProcess, clientVersion }),
  };
};
