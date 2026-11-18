import os from 'node:os';
import { spawnClaudeProcess } from './claude/platform.js';
import { spawnCodexProcess } from './codex/platform.js';
import { spawnAgyProcess } from './antigravity/platform.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const OUTPUT_LIMIT = 256 * 1024;

const ENGINES = {
  claude: {
    smallModel: /haiku/,
    spawn: (args, env) => spawnClaudeProcess(args, { cwd: os.tmpdir(), env }),
    args: (model) => [
      '-p', '--model', model, '--output-format', 'json',
      '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--disable-slash-commands',
      '--system-prompt', 'Answer in plain text only.',
    ],
    promptOnStdin: true,
    read: (stdout) => {
      const result = JSON.parse(stdout);
      if (result.is_error) throw new Error(String(result.result || 'Claude returned an error'));
      return String(result.result ?? '');
    },
  },
  codex: {
    smallModel: /luna|mini/,
    spawn: (args, env) => spawnCodexProcess(args, { cwd: os.tmpdir(), env }),
    args: (model) => [
      'exec', '-m', model, '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only',
      '--ignore-rules', '--color', 'never', '-c', 'model_reasoning_effort="low"', '-',
    ],
    promptOnStdin: true,
    read: (stdout) => stdout,
  },
  antigravity: {
    smallModel: /flash/,
    spawn: (args) => spawnAgyProcess(args, { cwd: os.tmpdir() }),
    args: (model, prompt) => ['-p', prompt, '--model', model, '--output-format', 'json', '--disable-slash-commands'],
    promptOnStdin: false,
    read: (stdout) => {
      const result = JSON.parse(stdout);
      if (result.status !== 'SUCCESS') throw new Error(`Antigravity answered ${String(result.status)}`);
      return String(result.response ?? '');
    },
  },
};

export const smallModelFor = (adapter) => {
  const catalog = adapter.modelCatalog();
  const pattern = ENGINES[adapter.id]?.smallModel;
  return catalog.models.find((model) => pattern?.test(model.id))?.id ?? catalog.defaultModel;
};

const collectOutput = (child, { input, timeoutMs, signal }) => new Promise((resolve, reject) => {
  let stdout = '';
  let stderr = '';
  let timer;
  const finish = (settle, value) => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    settle(value);
  };
  const kill = (message) => {
    child.kill('SIGKILL');
    finish(reject, new Error(message));
  };
  const onAbort = () => kill('Generation was cancelled');
  timer = setTimeout(() => kill(`No answer within ${timeoutMs} ms`), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  child.stdout.on('data', (chunk) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => finish(reject, error));
  child.stdin.on('error', (error) => finish(reject, error));
  child.on('close', (code) => finish(resolve, { code, stdout, stderr }));
  child.stdin.end(input);
});

const spawnEngine = (engine, args, env) => engine.spawn(args, env);

export const createOneShotGenerator = ({ spawn = spawnEngine, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => ({
  generateText: async ({ adapter, model, prompt, signal, accountId, env }) => {
    const engine = ENGINES[adapter.id];
    if (!engine) throw new Error(`${adapter.displayName} cannot answer a one-off prompt`);
    signal?.throwIfAborted();
    const args = engine.args(model || smallModelFor(adapter), prompt);
    if (adapter.id === 'codex' && accountId && accountId !== 'default') args.unshift('-c', 'cli_auth_credentials_store="file"');
    const child = spawn(engine, args, env);
    const { code, stdout, stderr } = await collectOutput(child, { input: engine.promptOnStdin ? prompt : undefined, timeoutMs, signal });
    const text = stdout.trim() ? engine.read(stdout).trim() : '';
    if (code === 0 && text) return text;
    throw new Error(stderr.trim().split('\n').pop() || (code === 0 ? 'The answer was empty' : `Exited with code ${code}`));
  },
});
