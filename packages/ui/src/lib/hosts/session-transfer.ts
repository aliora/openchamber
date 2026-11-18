import { z } from 'zod';

import type { HostRequest } from './host-transport';

/**
 * Moves a session from one host to another through this window. The hosts
 * never reach each other: each request goes over the host's own transport
 * (`runtimeFetch` for the focused host, `hostsMonitoring.transportFor` for the
 * others), so any two saved hosts can trade a session.
 *
 * 1. The source serves the bundle (`GET /api/sessions/:id/transfer-bundle`).
 * 2. The target imports it (`POST /api/sessions/import-transfer`): a new
 *    session with the whole history, marked so its CLI gets the conversation.
 * 3. The source marks the old session as moved and, when asked, archives it.
 *
 * Steps 1 and 2 decide the move: a failure there throws and nothing changed on
 * the source. Step 3 runs after the new session exists, so its failures come
 * back as warnings and the move still counts.
 */

export type TransferHost = {
  request: HostRequest;
  label: string;
  runtimeKey: string;
};

export type TransferModel = { providerID: string; id: string; variant?: string };

type SessionTransferRequest = {
  sessionId: string;
  source: TransferHost;
  target: TransferHost;
  includeGitChanges: boolean;
  archiveSource: boolean;
  prompt?: string;
  model?: TransferModel;
  cwd?: string;
};

type GitTransferResult = { applied: boolean; warning?: string };

type SessionTransferWarning = 'mark-failed' | 'archive-failed';

type SessionTransferResult = {
  targetSessionId: string;
  directory: string;
  gitTransferResult: GitTransferResult | null;
  prompted: boolean;
  promptError: string | null;
  warnings: SessionTransferWarning[];
};

const bundleSchema = z.object({ version: z.number() }).passthrough();

type ImportBody = {
  bundle: z.infer<typeof bundleSchema>;
  applyGitChanges: boolean;
  sourceHostLabel: string;
  prompt?: string;
  model?: TransferModel;
  cwd?: string;
};

const importResponseSchema = z.object({
  data: z.object({
    sessionId: z.string().min(1),
    directory: z.string(),
    gitTransferResult: z.object({ applied: z.boolean(), warning: z.string().optional() }).nullable(),
    prompted: z.boolean(),
    promptError: z.string().nullable(),
  }),
});

const errorSchema = z.object({ error: z.string() });

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** The server's own error text, else the status, so the user sees why. */
const failureOf = async (response: Response, step: string): Promise<Error> => {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return new Error(parsed.success ? parsed.data.error : `${step} answered ${response.status}`);
};

const succeeded = async (request: () => Promise<Response>): Promise<boolean> => {
  try {
    return (await request()).ok;
  } catch {
    return false;
  }
};

export const transferSession = async (options: SessionTransferRequest): Promise<SessionTransferResult> => {
  const { sessionId, source, target } = options;
  const query = options.includeGitChanges ? '?includeGitChanges=1' : '';
  const exported = await source.request(`/api/sessions/${encodeURIComponent(sessionId)}/transfer-bundle${query}`);
  if (!exported.ok) throw await failureOf(exported, 'transfer-bundle');
  const bundle = bundleSchema.parse(await exported.json());

  const importBody: ImportBody = { bundle, applyGitChanges: options.includeGitChanges, sourceHostLabel: source.label };
  const prompt = options.prompt?.trim();
  if (prompt) importBody.prompt = prompt;
  if (options.model) importBody.model = options.model;
  if (options.cwd) importBody.cwd = options.cwd;
  const imported = await target.request('/api/sessions/import-transfer', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(importBody),
  });
  if (!imported.ok) throw await failureOf(imported, 'import-transfer');
  const { data } = importResponseSchema.parse(await imported.json());

  const warnings: SessionTransferWarning[] = [];
  const marked = await succeeded(() => source.request(`/api/sessions/${encodeURIComponent(sessionId)}/mark-transferred`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ hostLabel: target.label, runtimeKey: target.runtimeKey, targetSessionId: data.sessionId, targetDirectory: data.directory }),
  }));
  if (!marked) warnings.push('mark-failed');
  if (options.archiveSource) {
    const archived = await succeeded(() => source.request('/api/openchamber/sessions/archive', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ids: [sessionId] }),
    }));
    if (!archived) warnings.push('archive-failed');
  }

  return {
    targetSessionId: data.sessionId,
    directory: data.directory,
    gitTransferResult: data.gitTransferResult,
    prompted: data.prompted,
    promptError: data.promptError,
    warnings,
  };
};
