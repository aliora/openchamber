import { getCurrentVersion } from '../../package-manager.js';
import { CODEX_PERMISSION_MODES, CodexProcess } from './codex-process.js';
import { CodexInstaller } from './installer.js';
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
} = {}) => {
  const clientVersion = getCurrentVersion();
  return {
    id: 'codex',
    displayName: 'Codex',
    providerID: 'openai',
    // What `model/list` returns in codex-cli 0.163.0, the CLI's default first.
    models: [
      { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', family: 'gpt-sol' },
      { id: 'gpt-6-astra', name: 'GPT-6-Astra', family: 'gpt-astra' },
      { id: 'gpt-6-sol', name: 'GPT-6-Sol', family: 'gpt-sol' },
      { id: 'gpt-6-luna', name: 'GPT-6-Luna', family: 'gpt-luna' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', family: 'gpt-sol' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', family: 'gpt-terra' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', family: 'gpt-luna' },
      { id: 'gpt-5.5', name: 'GPT-5.5' },
    ],
    // The model catalog bundled with codex-cli 0.163.0 gives every listed
    // model a 272K context window. It states no output cap.
    limit: { context: 272_000 },
    defaultModel: 'gpt-6.1-sol',
    // The reasoning efforts every listed model accepts.
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'medium',
    permissionModes: Object.keys(CODEX_PERMISSION_MODES),
    defaultPermissionMode: 'on-request',
    installer,
    auth: {
      status: authStatusProvider,
      login: startCodexLogin,
      logout: logoutCodex,
    },
    createProcess: (options) => new CodexProcess({ ...options, spawnProcess, clientVersion }),
  };
};
