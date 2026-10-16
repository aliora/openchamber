import { z } from 'zod';

// The parts of the `codex app-server` v2 protocol OpenChamber reads, written
// against the schema codex-cli 0.163.0 generates (`codex app-server
// generate-json-schema --out <dir>`). Each schema keeps only the fields the
// engine uses; zod drops the rest, so new optional fields do not break parsing.

const requestIdSchema = z.union([z.string(), z.number().int()]);

export const threadResponseSchema = z.object({
  thread: z.object({ id: z.string() }),
});

export const turnStartResponseSchema = z.object({
  turn: z.object({ id: z.string() }),
});

const tokenUsageBreakdownSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteInputTokens: z.number().default(0),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

const fileUpdateChangeSchema = z.object({
  path: z.string(),
  kind: z.object({ type: z.string() }),
  diff: z.string(),
});

/** The thread items that become tool calls; other item types fail to parse and are skipped. */
const toolItemSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('commandExecution'), id: z.string(), command: z.string(), cwd: z.string() }),
  z.object({ type: z.literal('fileChange'), id: z.string(), changes: z.array(fileUpdateChangeSchema) }),
  z.object({
    type: z.literal('mcpToolCall'),
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    arguments: z.unknown(),
  }),
]);

const turnScoped = { threadId: z.string(), turnId: z.string() };

/**
 * A finished MCP tool call: `status` is `completed` or `failed`, `result`
 * holds the server's content blocks, `error` why it failed. Other finished
 * item types fail to parse and are skipped.
 */
const finishedMcpCallSchema = z.object({
  type: z.literal('mcpToolCall'),
  id: z.string(),
  status: z.string(),
  result: z.object({
    content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
  }).nullish().catch(null),
  error: z.object({ message: z.string() }).nullish().catch(null),
});

/**
 * Notification params by method. Raw reasoning text (`item/reasoning/textDelta`)
 * is left out: Codex sends it only with `show_raw_agent_reasoning`, next to the
 * summary it always sends. Every other method is dropped too.
 */
export const notificationSchemas = new Map([
  ['item/agentMessage/delta', z.object({ ...turnScoped, itemId: z.string(), delta: z.string() })],
  ['item/reasoning/summaryTextDelta', z.object({
    ...turnScoped,
    itemId: z.string(),
    summaryIndex: z.number().int(),
    delta: z.string(),
  })],
  ['item/started', z.object({ ...turnScoped, item: toolItemSchema })],
  ['item/completed', z.object({ ...turnScoped, item: finishedMcpCallSchema })],
  ['thread/tokenUsage/updated', z.object({
    ...turnScoped,
    tokenUsage: z.object({ total: tokenUsageBreakdownSchema, last: tokenUsageBreakdownSchema }),
  })],
  ['turn/completed', z.object({
    threadId: z.string(),
    // `completed`, `interrupted`, `failed` or `inProgress`; read as text so a new status cannot strand a turn.
    turn: z.object({ id: z.string(), status: z.string() }),
  })],
  ['serverRequest/resolved', z.object({ threadId: z.string(), requestId: requestIdSchema })],
]);

/** Params of the approval requests OpenChamber answers, by method. Codex gets an error for any other request. */
export const approvalRequestSchemas = new Map([
  ['item/commandExecution/requestApproval', z.object({
    ...turnScoped,
    itemId: z.string(),
    command: z.string().nullish(),
    cwd: z.string().nullish(),
    reason: z.string().nullish(),
  })],
  ['item/fileChange/requestApproval', z.object({
    ...turnScoped,
    itemId: z.string(),
    reason: z.string().nullish(),
  })],
]);
