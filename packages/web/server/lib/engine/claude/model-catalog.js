import os from 'node:os';
import readline from 'node:readline';
import { z } from 'zod';
import { terminateChild } from '../cli-platform.js';
import { spawnClaudeProcess } from './platform.js';

export const CLAUDE_FALLBACK_CATALOG = {
  models: [
    { id: 'sonnet', name: 'Claude Sonnet', family: 'claude-sonnet' },
    { id: 'opus', name: 'Claude Opus', family: 'claude-opus' },
    { id: 'haiku', name: 'Claude Haiku', family: 'claude-haiku' },
  ],
  defaultModel: 'sonnet',
};

const READ_TIMEOUT_MS = 20_000;
const REQUEST_ID = 'openchamber-models';
const CLI_DEFAULT_MODEL = 'default';

export const CLAUDE_MODEL_LIST_ARGS = [
  '-p',
  '--settings', JSON.stringify({ disableAllHooks: true }),
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
];

const initializeResponseSchema = z.object({
  type: z.literal('control_response'),
  response: z.object({
    subtype: z.literal('success'),
    request_id: z.literal(REQUEST_ID),
    response: z.object({ models: z.array(z.unknown()) }),
  }),
});

const listedModelSchema = z.object({
  value: z.string().min(1),
  displayName: z.string().min(1).optional(),
  supportedEffortLevels: z.array(z.string()).optional(),
});

const parseLine = (line) => {
  try {
    return initializeResponseSchema.safeParse(JSON.parse(line));
  } catch {
    return { success: false };
  }
};

export const toClaudeModelCatalog = (listed) => {
  const models = listed.flatMap((entry) => {
    const parsed = listedModelSchema.safeParse(entry);
    if (!parsed.success || parsed.data.value === CLI_DEFAULT_MODEL) return [];
    const { value, displayName, supportedEffortLevels } = parsed.data;
    return [{ id: value, name: displayName ?? value, efforts: supportedEffortLevels ?? [] }];
  });
  if (models.length === 0) return null;
  const listedIds = new Set(models.map((model) => model.id));
  const missingAliases = CLAUDE_FALLBACK_CATALOG.models.filter((model) => !listedIds.has(model.id));
  return { models: [...models, ...missingAliases], defaultModel: CLAUDE_FALLBACK_CATALOG.defaultModel };
};

export const readClaudeModels = ({ spawnProcess = spawnClaudeProcess, timeoutMs = READ_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
  const child = spawnProcess(CLAUDE_MODEL_LIST_ARGS, { cwd: os.homedir() });
  const lines = readline.createInterface({ input: child.stdout });
  let settled = false;

  const finish = (error, catalog) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    lines.close();
    void terminateChild(child);
    if (error) reject(error);
    else resolve(catalog);
  };

  const timer = setTimeout(() => finish(new Error(`Claude Code did not list its models within ${timeoutMs / 1000} seconds`)), timeoutMs);
  child.stderr?.resume();
  child.on('error', (error) => finish(error));
  child.on('exit', (code, signal) => finish(new Error(`Claude Code exited before listing its models (${signal || code})`)));
  child.stdin.on('error', (error) => finish(error));
  lines.on('line', (line) => {
    const parsed = parseLine(line);
    if (!parsed.success) return;
    const catalog = toClaudeModelCatalog(parsed.data.response.response.models);
    if (catalog) finish(null, catalog);
    else finish(new Error('Claude Code listed no models'));
  });
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
});
