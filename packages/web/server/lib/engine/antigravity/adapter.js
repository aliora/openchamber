import { AgyProcess, DEFAULT_MODEL } from './agy-process.js';
import { AntigravityInstaller } from './installer.js';
import { runAgy } from './platform.js';

// The Antigravity engine: runs Google's `agy` CLI in headless stream-json mode
// and maps its output to the engine events in ../DOCUMENTATION.md.

// `<slug>\t<display name>` lines of `agy models`; the heading and blank lines are skipped.
export const parseModelListing = (output) => output.split(/\r?\n/).flatMap((line) => {
  const trimmed = line.trim();
  const [id, ...label] = trimmed.split(/\s+/);
  const name = label.join(' ');
  if (!name || trimmed.endsWith(':') || !/^[\w.:/-]+$/.test(id)) return [];
  return [{ id, name }];
});

/**
 * `agy models` lists nothing when no account is signed in, so a non-empty list
 * is the sign-in check. It works for Google sign-in and for GEMINI_API_KEY, and
 * unlike a print-mode command it never starts a sign-in flow. Its stderr is not
 * read, so nothing agy prints about the account reaches the response.
 */
export const getAgyAuthStatus = async ({ run = runAgy } = {}) => {
  const { exitCode, stdout, error } = await run(['models']);
  if (error) return { loggedIn: false, email: null, reason: 'agy_unavailable' };
  if (exitCode !== 0) return { loggedIn: false, email: null, reason: `agy models exited with code ${exitCode}` };
  if (parseModelListing(stdout).length === 0) return { loggedIn: false, email: null, reason: 'not_signed_in' };
  return { loggedIn: true, email: null };
};

// agy signs in and out only inside its terminal UI, with `/login` and `/logout`.
// Print mode refuses both and there is no auth subcommand, so these throw the
// step to take and the routes answer 501 with it.
const startAgyLogin = () => {
  throw new Error('Antigravity signs in from its own terminal UI: run `agy` in a terminal and follow the Google sign-in.');
};

const logoutAgy = () => {
  throw new Error('Sign out of Antigravity by running /logout inside `agy`.');
};

/**
 * What each mode lets headless agy do. A tool the mode does not allow is
 * refused without asking, and allow rules in agy's own settings.json apply in
 * every mode.
 * - `default`: reads in the workspace; file edits and commands are refused.
 * - `accept-edits`: file edits too; commands still need an allow rule.
 * - `auto`: file edits and commands agy judges safe; irreversible actions are
 *   refused. agy 1.3.5 and later has it on Linux and macOS only.
 * - `dangerously-skip-permissions`: every tool runs.
 * `plan` is left out because headless agy approves its own plan and goes on to edit.
 */
const permissionModesFor = (platform) => (platform === 'win32'
  ? ['default', 'accept-edits', 'dangerously-skip-permissions']
  : ['default', 'accept-edits', 'auto', 'dangerously-skip-permissions']);

// `agy models` lists what the signed-in account can use; it differs per account.
// `default` passes no `--effort`, so it offers none.
const AGY_MODEL_CATALOG = {
  models: [
    { id: DEFAULT_MODEL, name: 'Antigravity default', efforts: [] },
    { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', family: 'gemini-flash' },
  ],
  defaultModel: DEFAULT_MODEL,
};

export const createAntigravityEngine = ({
  installer = new AntigravityInstaller(),
  authStatusProvider = getAgyAuthStatus,
  platform = process.platform,
  createAgyProcess = (options) => new AgyProcess(options),
} = {}) => ({
  id: 'antigravity',
  displayName: 'Antigravity',
  providerID: 'google',
  modelCatalog: () => AGY_MODEL_CATALOG,
  efforts: ['low', 'medium', 'high'],
  defaultEffort: 'medium',
  permissionModes: permissionModesFor(platform),
  defaultPermissionMode: 'default',
  dangerousPermissionModes: ['dangerously-skip-permissions'],
  installer,
  auth: {
    status: authStatusProvider,
    login: startAgyLogin,
    logout: logoutAgy,
    // Starts the terminal UI, where agy signs in (see `startAgyLogin`).
    loginCommand: 'agy',
  },
  createProcess: createAgyProcess,
});
