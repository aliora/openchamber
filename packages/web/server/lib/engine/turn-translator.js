// Turns the engine-neutral events of one prompt into the OpenCode 2.x wire
// events the shared UI reads, and into the assistant message the store keeps.
// Every engine adapter reuses it, so a new CLI only maps its own output.
//
// The stored message is what `wire-messages.js` serves after a reload, so it
// keeps what the live events showed: the same times, and its parts in the
// order they first appeared on the stream.

import { toWireFinish } from './wire-messages.js';

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const toWireTokens = (usage) => {
  if (!usage) return EMPTY_TOKENS;
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    reasoning: usage.reasoning || 0,
    cache: { read: usage.cacheRead || 0, write: usage.cacheWrite || 0 },
  };
};

const UNFINISHED_TOOL_ERROR = 'The turn ended before this tool finished';

// Content order markers. A turn streams one text part and one reasoning part
// (ordinal 0 on the wire), so each kind appears once; tools appear by call id.
const TEXT = Symbol('text');
const REASONING = Symbol('reasoning');

/**
 * `describeToolResult(name, output)` lets the tool server attach the metadata
 * the chat reads to a result of one of its own tools (a page drawn from an
 * `openchamber_render` call, and the user's answer to it). It answers
 * `undefined` for any other tool.
 */
export const createTurnTranslator = ({ sessionId, assistantMessageID, agent, providerID, modelID, broadcast, describeToolResult = () => undefined }) => {
  // When `session.step.started` went out; the message's creation time.
  let startedAt = null;
  let text = '';
  let reasoning = '';
  let textOpen = false;
  let reasoningOpen = false;
  let reasoningTime = null;
  const order = [];
  // Call id -> { name, input, status, executed, output, error, metadata, time }.
  const tools = new Map();

  const emit = (type, data, created = Date.now()) => {
    broadcast({ type, created, data: { assistantMessageID, sessionID: sessionId, ...data } });
  };

  const closeReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    reasoningTime.completed = Date.now();
    emit('session.reasoning.ended', { ordinal: 0, text: reasoning }, reasoningTime.completed);
  };

  const startTool = (id, name) => {
    closeReasoning();
    const tool = { name, input: {}, status: 'pending', executed: false, time: { created: Date.now() } };
    tools.set(id, tool);
    order.push(id);
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
    'reasoning.delta': ({ text: delta }) => {
      if (!reasoningOpen) {
        reasoningOpen = true;
        const at = Date.now();
        if (!reasoningTime) {
          reasoningTime = { created: at };
          order.push(REASONING);
        }
        emit('session.reasoning.started', { ordinal: 0 }, at);
      }
      reasoning += delta;
      emit('session.reasoning.delta', { ordinal: 0, delta });
    },
    'text.delta': ({ text: delta }) => {
      closeReasoning();
      if (!textOpen) {
        textOpen = true;
        order.push(TEXT);
        emit('session.text.started', { ordinal: 0 });
      }
      text += delta;
      emit('session.text.delta', { ordinal: 0, delta });
    },
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

  // Parts in the order they appeared. `keep` decides which calls are listed.
  const storedParts = (keep) => order.flatMap((entry) => {
    if (entry === REASONING) {
      return reasoning ? [{ id: `${assistantMessageID}_r0`, type: 'reasoning', text: reasoning, time: { ...reasoningTime } }] : [];
    }
    if (entry === TEXT) return text ? [{ id: `${assistantMessageID}_t0`, type: 'text', text }] : [];
    const tool = tools.get(entry);
    return keep(tool) ? [storedToolPart(entry, tool)] : [];
  });

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
        content: text,
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
    finish({ outcome, usage }) {
      closeReasoning();
      for (const [id, tool] of tools) {
        if (tool.status === 'running') failTool(id, tool, UNFINISHED_TOOL_ERROR);
      }
      if (textOpen) {
        textOpen = false;
        emit('session.text.ended', { ordinal: 0, text });
      }
      const completedAt = Date.now();
      const tokens = toWireTokens(usage);
      emit('session.step.ended', { finish: toWireFinish(outcome), cost: 0, tokens }, completedAt);

      // Only calls the adapter reported running are stored; a call that was
      // only started has no input or outcome to keep.
      const parts = storedParts((tool) => tool.status !== 'pending');
      if (parts.length === 0) return null;
      return {
        id: assistantMessageID,
        role: 'assistant',
        agent,
        model: modelID,
        content: text,
        createdAt: startedAt ?? completedAt,
        completedAt,
        outcome,
        tokens,
        parts,
      };
    },
  };
};
