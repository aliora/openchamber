// Turns the engine-neutral events of one prompt into the OpenCode 2.x wire
// events the shared UI reads, and into the assistant message the store keeps.
// Every engine adapter reuses it, so a new CLI only maps its own output.
//
// The stored message is what `wire-messages.js` serves after a reload, so it
// keeps what the live events showed: the same parts, times and order.

import { toWireFinish } from './wire-messages.js';

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

// The counts add up every model call of the turn. `total` is the context the
// turn ended with, which the context meter reads instead of their sum.
const toWireTokens = (usage) => {
  if (!usage) return EMPTY_TOKENS;
  const tokens = {
    input: usage.input || 0,
    output: usage.output || 0,
    reasoning: usage.reasoning || 0,
    cache: { read: usage.cacheRead || 0, write: usage.cacheWrite || 0 },
  };
  if (usage.total > 0) tokens.total = usage.total;
  return tokens;
};

const UNFINISHED_TOOL_ERROR = 'The turn ended before this tool finished';

/**
 * `describeToolResult(name, output)` lets the tool server attach the metadata
 * the chat reads to a result of one of its own tools (a page drawn from an
 * `openchamber_render` call, and the user's answer to it). It answers
 * `undefined` for any other tool.
 */
export const createTurnTranslator = ({ sessionId, assistantMessageID, agent, providerID, modelID, broadcast, describeToolResult = () => undefined }) => {
  // When `session.step.started` went out; the message's creation time.
  let startedAt = null;
  // The turn's content in stream order: `{ type: 'text' | 'reasoning',
  // ordinal, text, time }` for each run of text or reasoning, and
  // `{ type: 'tool', id }` for each call. A run is one part on the wire,
  // numbered per type from 0, the way the UI numbers the n-th text or
  // reasoning item of a message read back from the history.
  const order = [];
  const runCount = { text: 0, reasoning: 0 };
  // The text or reasoning run still streaming, or null.
  let openRun = null;
  // Call id -> { name, input, status, executed, output, error, metadata, time }.
  const tools = new Map();

  const emit = (type, data, created = Date.now()) => {
    broadcast({ type, created, data: { assistantMessageID, sessionID: sessionId, ...data } });
  };

  const closeRun = () => {
    if (!openRun) return;
    const run = openRun;
    openRun = null;
    run.time.completed = Date.now();
    emit(`session.${run.type}.ended`, { ordinal: run.ordinal, text: run.text }, run.time.completed);
  };

  // A delta goes on the open run of its type. The other type or a tool call
  // in between closed that run, so the delta opens the next one. An empty
  // delta opens nothing: the history leaves out empty parts, and one it left
  // out would shift the numbers of the parts after it.
  const appendToRun = (type, delta) => {
    if (!delta) return;
    if (openRun?.type !== type) {
      closeRun();
      openRun = { type, ordinal: runCount[type], text: '', time: { created: Date.now() } };
      runCount[type] += 1;
      order.push(openRun);
      emit(`session.${type}.started`, { ordinal: openRun.ordinal }, openRun.time.created);
    }
    openRun.text += delta;
    emit(`session.${type}.delta`, { ordinal: openRun.ordinal, delta });
  };

  const startTool = (id, name) => {
    closeRun();
    const tool = { name, input: {}, status: 'pending', executed: false, time: { created: Date.now() } };
    tools.set(id, tool);
    order.push({ type: 'tool', id });
    emit('session.tool.input.started', { id, name }, tool.time.created);
    return tool;
  };

  const failTool = (id, tool, message) => {
    tool.status = 'error';
    tool.error = message;
    tool.time.completed = Date.now();
    emit('session.tool.failed', { id, error: { type: 'tool', message }, executed: tool.executed }, tool.time.completed);
  };

  const handlers = {
    'reasoning.delta': ({ text: delta }) => appendToRun('reasoning', delta),
    'text.delta': ({ text: delta }) => appendToRun('text', delta),
    'tool.started': ({ id, name }) => {
      if (tools.has(id)) return;
      startTool(id, name);
    },
    // The full input is known: the call runs now. A CLI that never streamed
    // the start reports it here first.
    'tool.called': ({ id, name, input }) => {
      const tool = tools.get(id) ?? startTool(id, name);
      if (tool.status !== 'pending') return;
      tool.status = 'running';
      tool.executed = true;
      tool.input = input;
      tool.time.ran = Date.now();
      emit('session.tool.called', { id, input, executed: true }, tool.time.ran);
    },
    'tool.completed': ({ id, output, isError }) => {
      const tool = tools.get(id);
      if (!tool || tool.status === 'completed' || tool.status === 'error') return;
      const metadata = describeToolResult(tool.name, output);
      tool.output = output;
      tool.metadata = metadata;
      tool.time.completed = Date.now();
      const content = [{ type: 'text', text: output }];
      if (isError) {
        tool.status = 'error';
        tool.error = output || 'The tool failed';
        emit('session.tool.failed', { id, error: { type: 'tool', message: tool.error }, content, metadata, executed: tool.executed }, tool.time.completed);
        return;
      }
      tool.status = 'completed';
      emit('session.tool.success', { id, content, metadata, executed: tool.executed }, tool.time.completed);
    },
  };

  // The stored form of a call: the tool part the UI keeps for it.
  const storedToolPart = (id, tool) => {
    const state = { status: tool.status, input: tool.input };
    if (tool.output !== undefined) state.output = tool.output;
    if (tool.error !== undefined) state.error = tool.error;
    if (tool.metadata !== undefined) state.metadata = tool.metadata;
    return { id, type: 'tool', callID: id, tool: tool.name, executed: tool.executed, state, time: { ...tool.time } };
  };

  // Parts in stream order. `keep` decides which calls are listed; leaving one
  // out renumbers nothing, because a call goes by its id.
  const storedParts = (keep) => order.flatMap((entry) => {
    switch (entry.type) {
      case 'text':
        return [{ id: `${assistantMessageID}_t${entry.ordinal}`, type: 'text', text: entry.text }];
      case 'reasoning':
        return [{ id: `${assistantMessageID}_r${entry.ordinal}`, type: 'reasoning', text: entry.text, time: { ...entry.time } }];
      case 'tool': {
        const tool = tools.get(entry.id);
        return keep(tool) ? [storedToolPart(entry.id, tool)] : [];
      }
    }
  });

  // The answer's text runs joined, which the store keeps as `content`.
  const fullText = () => order.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('');

  return {
    assistantMessageID,

    begin() {
      startedAt = Date.now();
      emit('session.step.started', { agent, model: { providerID, id: modelID } }, startedAt);
    },

    /**
     * The message as it stands while the turn runs, in the stored format, or
     * null before the turn began. A history read during the turn shows it,
     * including calls only started and a page still waiting for the user.
     */
    snapshot() {
      if (startedAt === null) return null;
      return {
        id: assistantMessageID,
        role: 'assistant',
        agent,
        model: modelID,
        content: fullText(),
        createdAt: startedAt,
        parts: storedParts(() => true),
      };
    },

    handle(eventName, payload) {
      handlers[eventName]?.(payload);
    },

    /**
     * Closes the open stream parts and returns the message to persist, or null
     * when the engine produced nothing for this turn. A call that ran and is
     * still open here (the turn was stopped, or the CLI died) ends as failed,
     * so no client shows it running, or a page waiting, forever. A call that
     * was only started is left as it was: some adapters report nothing more
     * about a call (Codex's commands and edits, agy's tools), and failing
     * those would mark work that succeeded.
     */
    finish({ outcome, usage, error }) {
      closeRun();
      for (const [id, tool] of tools) {
        if (tool.status === 'running') failTool(id, tool, UNFINISHED_TOOL_ERROR);
      }
      const completedAt = Date.now();
      const tokens = toWireTokens(usage);
      emit('session.step.ended', { finish: toWireFinish(outcome), cost: 0, tokens }, completedAt);

      // Only calls the adapter reported running are stored; a call that was
      // only started has no input or outcome to keep.
      const parts = storedParts((tool) => tool.status !== 'pending');
      const failure = outcome === 'failed' ? error : undefined;
      if (parts.length === 0 && !failure) return null;
      return {
        id: assistantMessageID,
        role: 'assistant',
        agent,
        model: modelID,
        content: fullText(),
        createdAt: startedAt ?? completedAt,
        completedAt,
        outcome,
        tokens,
        parts,
        ...(failure ? { error: failure } : {}),
      };
    },
  };
};
