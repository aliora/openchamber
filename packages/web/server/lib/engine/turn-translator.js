// Turns the engine-neutral events of one prompt into the OpenCode 2.x wire
// events the shared UI reads, and into the assistant message the store keeps.
// Every engine adapter reuses it, so a new CLI only maps its own output.

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

/**
 * `describeToolResult(name, output)` lets the tool server attach the metadata
 * the chat reads to a result of one of its own tools (a page drawn from an
 * `openchamber_render` call, and the user's answer to it). It answers
 * `undefined` for any other tool.
 */
export const createTurnTranslator = ({ sessionId, assistantMessageID, agent, providerID, modelID, broadcast, describeToolResult = () => undefined }) => {
  let text = '';
  let reasoning = '';
  let textOpen = false;
  let reasoningOpen = false;
  // Call id -> { name, input, status, output, error, metadata }, in call order.
  const tools = new Map();

  const emit = (type, data) => {
    broadcast({ type, created: Date.now(), data: { assistantMessageID, sessionID: sessionId, ...data } });
  };

  const closeReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    emit('session.reasoning.ended', { ordinal: 0, text: reasoning });
  };

  const startTool = (id, name) => {
    closeReasoning();
    const tool = { name, input: {}, status: 'pending' };
    tools.set(id, tool);
    emit('session.tool.input.started', { id, name });
    return tool;
  };

  const failTool = (id, tool, message) => {
    tool.status = 'error';
    tool.error = message;
    emit('session.tool.failed', { id, error: { type: 'tool', message }, executed: tool.executed === true });
  };

  const handlers = {
    'reasoning.delta': ({ text: delta }) => {
      if (!reasoningOpen) {
        reasoningOpen = true;
        emit('session.reasoning.started', { ordinal: 0 });
      }
      reasoning += delta;
      emit('session.reasoning.delta', { ordinal: 0, delta });
    },
    'text.delta': ({ text: delta }) => {
      closeReasoning();
      if (!textOpen) {
        textOpen = true;
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
      emit('session.tool.called', { id, input, executed: true });
    },
    'tool.completed': ({ id, output, isError }) => {
      const tool = tools.get(id);
      if (!tool || tool.status === 'completed' || tool.status === 'error') return;
      const metadata = describeToolResult(tool.name, output);
      tool.output = output;
      tool.metadata = metadata;
      const content = [{ type: 'text', text: output }];
      if (isError) {
        tool.status = 'error';
        tool.error = output || 'The tool failed';
        emit('session.tool.failed', { id, error: { type: 'tool', message: tool.error }, content, metadata, executed: tool.executed === true });
        return;
      }
      tool.status = 'completed';
      emit('session.tool.success', { id, content, metadata, executed: tool.executed === true });
    },
  };

  // The stored form of a call: the tool part the UI keeps for it.
  const storedToolPart = (id, tool) => {
    const state = { status: tool.status, input: tool.input };
    if (tool.output !== undefined) state.output = tool.output;
    if (tool.error !== undefined) state.error = tool.error;
    if (tool.metadata !== undefined) state.metadata = tool.metadata;
    return { id, type: 'tool', callID: id, tool: tool.name, state };
  };

  return {
    assistantMessageID,

    begin() {
      emit('session.step.started', { agent, model: { providerID, id: modelID } });
    },

    handle(eventName, payload) {
      handlers[eventName]?.(payload);
    },

    /**
     * Closes the open stream parts and returns the message to persist, or null
     * when the engine produced nothing for this turn. A call still open here
     * (the turn was stopped, or the CLI died) ends as failed, so no client
     * shows it running, or a page waiting, forever.
     */
    finish({ outcome, usage }) {
      closeReasoning();
      for (const [id, tool] of tools) {
        if (tool.status === 'pending' || tool.status === 'running') failTool(id, tool, UNFINISHED_TOOL_ERROR);
      }
      if (textOpen) {
        textOpen = false;
        emit('session.text.ended', { ordinal: 0, text });
      }
      emit('session.step.ended', {
        finish: outcome === 'succeeded' ? 'stop' : outcome,
        cost: 0,
        tokens: toWireTokens(usage),
      });

      if (!text && !reasoning && tools.size === 0) return null;
      const parts = [];
      if (reasoning) parts.push({ id: `${assistantMessageID}_r0`, type: 'reasoning', text: reasoning });
      for (const [id, tool] of tools) parts.push(storedToolPart(id, tool));
      if (text) parts.push({ id: `${assistantMessageID}_t0`, type: 'text', text });
      return {
        id: assistantMessageID,
        role: 'assistant',
        agent,
        model: modelID,
        content: text,
        createdAt: Date.now(),
        parts,
      };
    },
  };
};
