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

export const createTurnTranslator = ({ sessionId, assistantMessageID, agent, providerID, modelID, broadcast }) => {
  let text = '';
  let reasoning = '';
  let textOpen = false;
  let reasoningOpen = false;

  const emit = (type, data) => {
    broadcast({ type, created: Date.now(), data: { assistantMessageID, sessionID: sessionId, ...data } });
  };

  const closeReasoning = () => {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    emit('session.reasoning.ended', { ordinal: 0, text: reasoning });
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
      closeReasoning();
      emit('session.tool.input.started', { id, name });
    },
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
     * when the engine produced nothing for this turn.
     */
    finish({ outcome, usage }) {
      closeReasoning();
      if (textOpen) {
        textOpen = false;
        emit('session.text.ended', { ordinal: 0, text });
      }
      emit('session.step.ended', {
        finish: outcome === 'succeeded' ? 'stop' : outcome,
        cost: 0,
        tokens: toWireTokens(usage),
      });

      if (!text && !reasoning) return null;
      return {
        id: assistantMessageID,
        role: 'assistant',
        agent,
        model: modelID,
        content: text,
        createdAt: Date.now(),
        parts: [
          ...(reasoning ? [{ id: `${assistantMessageID}_r0`, type: 'reasoning', text: reasoning }] : []),
          ...(text ? [{ id: `${assistantMessageID}_t0`, type: 'text', text }] : []),
        ],
      };
    },
  };
};
