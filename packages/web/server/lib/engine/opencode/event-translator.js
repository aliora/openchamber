/** Upstream OpenCode 2 events to the engine's stream contract. */
export const createOpenCodeEventTranslator = (sessionId, emit) => {
  const tools = new Map();
  let usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  const reset = () => { tools.clear(); usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }; };
  return (event) => {
    const data = event.data;
    if ((data?.sessionID ?? data?.form?.sessionID) !== sessionId) return;
    switch (event.type) {
      case 'session.text.delta': emit('text.delta', { text: data.delta }); break;
      case 'session.reasoning.delta': emit('reasoning.delta', { text: data.delta }); break;
      case 'session.tool.input.started':
        tools.set(data.id, data.name);
        emit('tool.started', { id: data.id, name: data.name, input: {} });
        break;
      case 'session.tool.called': emit('tool.called', { id: data.id, name: tools.get(data.id) || 'tool', input: data.input }); break;
      case 'session.tool.success':
      case 'session.tool.failed':
        emit('tool.completed', { id: data.id, output: data.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') || data.error?.message || '', isError: event.type === 'session.tool.failed' });
        break;
      case 'session.step.ended': {
        const tokens = data.tokens;
        usage.input += tokens.input; usage.output += tokens.output; usage.reasoning += tokens.reasoning;
        usage.cacheRead += tokens.cache.read; usage.cacheWrite += tokens.cache.write;
        usage.total = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
        break;
      }
      case 'session.execution.succeeded':
      case 'session.execution.failed':
        emit('turn.completed', { outcome: event.type === 'session.execution.succeeded' ? 'succeeded' : 'failed', usage, error: data.error });
        reset(); break;
      case 'session.execution.interrupted': emit('turn.interrupted', {}); reset(); break;
      case 'permission.asked': emit('permission.requested', { requestId: data.id, toolName: data.action, input: data.metadata?.input ?? { resources: data.resources }, summary: data.message || data.action }); break;
      case 'form.created': emit('form.requested', data.form); break;
      case 'form.replied':
      case 'form.cancelled': emit('form.settled', { id: data.id, answer: data.answer, cancelled: event.type === 'form.cancelled' }); break;
    }
  };
};
