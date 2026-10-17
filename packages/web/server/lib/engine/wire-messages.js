import { z } from 'zod';

// Stored engine messages (store.js, written by session-runtime.js and
// turn-translator.js) read back as OpenCode 2.x messages: the
// `SessionMessageUser` and `SessionMessageAssistant` records that
// `GET /api/session/:id/message` serves and the UI projects
// (packages/ui/src/lib/opencode/projection.ts).
//
// The UI derives part ids from content position: the n-th text item of an
// assistant message is `<messageID>:text:<n>`, the n-th reasoning item
// `<messageID>:reasoning:<n>`, and a tool item is its call id. The translator
// stores one non-empty part per run of text or reasoning, in stream order, and
// streamed that run with ordinal n, so serving the stored parts in order gives
// a message read back after a reload the same parts it was drawn with live.

const FINISH_BY_OUTCOME = new Map([
  ['succeeded', 'stop'],
  ['failed', 'error'],
  ['interrupted', 'unknown'],
]);

/** The `finish` of an assistant message whose turn ended with `outcome`. */
export const toWireFinish = (outcome) => FINISH_BY_OUTCOME.get(outcome) ?? 'unknown';

// Stored records are read with defaults rather than trusted: records written
// before a field existed lack it, and one unreadable part or message is left
// out without hiding the rest of the history.
const timestamp = z.number().nonnegative();
const jsonRecord = z.record(z.string(), z.json());

const storedText = z.object({
  type: z.literal('text'),
  text: z.string().optional(),
  // Records written through the plural `/api/sessions` routes keep it here.
  content: z.string().optional(),
});

const storedReasoning = storedText.extend({
  type: z.literal('reasoning'),
  time: z.object({ created: timestamp, completed: timestamp.optional() }).optional().catch(undefined),
});

const storedTool = z.object({
  type: z.literal('tool'),
  callID: z.string().min(1),
  tool: z.string().min(1),
  executed: z.boolean().optional().catch(undefined),
  state: z.object({
    status: z.enum(['pending', 'running', 'completed', 'error']),
    input: jsonRecord.catch({}),
    output: z.string().optional().catch(undefined),
    error: z.string().optional().catch(undefined),
    metadata: jsonRecord.optional().catch(undefined),
  }),
  time: z.object({
    created: timestamp,
    ran: timestamp.optional(),
    completed: timestamp.optional(),
  }).optional().catch(undefined),
});

const storedPart = z.discriminatedUnion('type', [storedText, storedReasoning, storedTool]);

// `total` is the context the turn ended with; records stored before it was
// kept have none, and the UI then adds up the other counts.
const storedTokens = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }),
  total: z.number().positive().optional().catch(undefined),
});

const storedMessage = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'assistant']),
  content: z.string().catch(''),
  createdAt: timestamp.catch(0),
  completedAt: timestamp.optional().catch(undefined),
  agent: z.string().min(1).optional().catch(undefined),
  model: z.string().min(1).optional().catch(undefined),
  outcome: z.enum(['succeeded', 'failed', 'interrupted']).optional().catch(undefined),
  tokens: storedTokens.optional().catch(undefined),
  error: z.object({ type: z.string(), message: z.string() }).optional().catch(undefined),
  parts: z.array(storedPart.nullable().catch(null)).catch([]),
  context: z.array(z.object({
    id: z.string().min(1),
    text: z.string(),
    description: z.string().optional().catch(undefined),
    metadata: jsonRecord.optional().catch(undefined),
    createdAt: timestamp.optional().catch(undefined),
  }).nullable().catch(null)).catch([]),
});

const textOf = (part) => part.text ?? part.content ?? '';

const toolText = (text) => [{ type: 'text', text }];

/** `SessionMessageToolState*`: the state a stored call reads as. */
const toWireToolState = (state) => {
  switch (state.status) {
    case 'pending':
      return { status: 'streaming', input: '' };
    case 'running':
      return { status: 'running', input: state.input, metadata: state.metadata ?? {} };
    case 'completed':
      return { status: 'completed', input: state.input, content: toolText(state.output ?? ''), metadata: state.metadata };
    case 'error':
      return {
        status: 'error',
        input: state.input,
        error: { type: 'tool', message: state.error || state.output || 'The tool failed' },
        content: state.output === undefined ? undefined : toolText(state.output),
        metadata: state.metadata,
      };
  }
};

/**
 * `SessionMessageAssistant.content`, in the order the parts were stored.
 * A record without parts, from before parts were stored, reads its text.
 */
const toAssistantContent = (record, owner) => {
  const parts = record.parts.filter((part) => part !== null);
  if (parts.length === 0) return record.content ? [{ type: 'text', text: record.content }] : [];
  return parts.flatMap((part) => {
    switch (part.type) {
      case 'text': {
        const text = textOf(part);
        return text ? [{ type: 'text', text }] : [];
      }
      case 'reasoning': {
        const text = textOf(part);
        if (!text) return [];
        return [{
          type: 'reasoning',
          text,
          time: { created: part.time?.created ?? owner.created, completed: part.time?.completed ?? owner.completed },
        }];
      }
      case 'tool':
        return [{
          type: 'tool',
          id: part.callID,
          name: part.tool,
          executed: part.executed,
          state: toWireToolState(part.state),
          time: {
            created: part.time?.created ?? owner.created,
            ran: part.time?.ran,
            completed: part.time?.completed ?? owner.completed,
          },
        }];
    }
  });
};

/** `SessionMessageUser`: the prompt's text. Engines take no attachments yet. */
const toWireUser = (record) => ({
  id: record.id,
  time: { created: record.createdAt },
  type: 'user',
  text: record.content || record.parts.filter((part) => part?.type === 'text').map(textOf).join('\n'),
});

/** `SessionMessageSynthetic`: context the client sent ahead of the prompt it belongs to. */
const toWireSynthetic = (record) => record.context.filter((item) => item !== null).map((item) => ({
  id: item.id,
  time: { created: item.createdAt ?? record.createdAt },
  type: 'synthetic',
  text: item.text,
  description: item.description,
  metadata: item.metadata,
}));

/**
 * `SessionMessageAssistant`. A running one (its turn has not ended) has no
 * completion, finish, cost or tokens yet, as on the live stream. A stored
 * one from before outcomes were stored reads as `stop`, the outcome of
 * almost every stored turn.
 */
const toWireAssistant = (record, { session, adapter }, running) => {
  const created = record.createdAt;
  const completed = running ? undefined : record.completedAt ?? created;
  return {
    id: record.id,
    time: { created, completed },
    type: 'assistant',
    agent: record.agent ?? adapter.id,
    model: { providerID: adapter.providerID, id: record.model ?? session.model ?? adapter.modelCatalog().defaultModel },
    content: toAssistantContent(record, { created, completed }),
    finish: running ? undefined : toWireFinish(record.outcome ?? 'succeeded'),
    cost: running ? undefined : 0,
    tokens: record.tokens,
    error: record.error,
  };
};

const toWireMessages = (records, context, running) => records.flatMap((record) => {
  const parsed = storedMessage.safeParse(record);
  if (!parsed.success) return [];
  const message = parsed.data;
  return message.role === 'user'
    ? [...toWireSynthetic(message), toWireUser(message)]
    : [toWireAssistant(message, context, running)];
});

/**
 * A session's whole history as wire messages, oldest first: the `stored`
 * records, then the assistant messages of turns still `running`. Creation
 * time orders the transcript, as in the UI; a tie keeps the stored order.
 * Fields left undefined are absent once serialized.
 */
export const toWireHistory = ({ stored, running, session, adapter }) => {
  const context = { session, adapter };
  const messages = [...toWireMessages(stored, context, false), ...toWireMessages(running, context, true)];
  return messages.sort((left, right) => left.time.created - right.time.created);
};

// --- Paging ---------------------------------------------------------------

const MESSAGE_TYPES = [
  'agent-switched', 'model-switched', 'location-switched', 'user', 'synthetic',
  'system', 'skill', 'shell', 'assistant', 'compaction',
];

/** The query `message.list` sends. `limit` and the rest arrive as strings. */
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  cursor: z.string().min(1).optional(),
  type: z.enum(MESSAGE_TYPES).optional(),
});

const cursorSchema = z.object({ order: z.enum(['asc', 'desc']), after: z.string().min(1) });

const encodeCursor = (position) => Buffer.from(JSON.stringify(position)).toString('base64url');

const decodeCursor = (cursor) => {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * One page of `messages` (oldest first) for a `message.list` query: newest
 * first unless `order` is `asc`, and only messages of `type` when one is
 * named. `next` continues after the page's last message in the same order
 * and is null when nothing remains. Returns null for a cursor that names no
 * message of this history.
 */
export const readHistoryPage = (messages, { limit, order, cursor, type }) => {
  let direction = order ?? 'desc';
  let after = null;
  if (cursor !== undefined) {
    const position = decodeCursor(cursor);
    if (!position) return null;
    direction = position.order;
    after = position.after;
  }
  const matching = type === undefined ? messages : messages.filter((message) => message.type === type);
  const ordered = direction === 'desc' ? [...matching].reverse() : matching;
  let start = 0;
  if (after !== null) {
    const index = ordered.findIndex((message) => message.id === after);
    if (index < 0) return null;
    start = index + 1;
  }
  const remaining = ordered.slice(start);
  const data = limit === undefined ? remaining : remaining.slice(0, limit);
  const next = data.length < remaining.length ? encodeCursor({ order: direction, after: data.at(-1).id }) : null;
  return { data, next };
};
