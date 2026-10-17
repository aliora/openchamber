export const HANDOFF_HISTORY_LIMIT = 60_000;

const partLine = (part) => {
  if (part?.type === 'text' && part.text) return part.text;
  if (part?.type === 'tool' && part.tool) return `[used tool: ${part.tool}]`;
  return null;
};

const messageEntry = (message) => {
  const parts = Array.isArray(message.parts) && message.parts.length > 0
    ? message.parts
    : [{ type: 'text', text: message.content }];
  const body = parts.map(partLine).filter(Boolean).join('\n').trim();
  if (!body) return null;
  return `${message.role === 'user' ? 'User' : 'Assistant'}:\n${body}`;
};

export const buildHandoffPrompt = (messages, text, limit = HANDOFF_HISTORY_LIMIT) => {
  const entries = messages.map(messageEntry).filter(Boolean);
  if (entries.length === 0) return text;

  const kept = [];
  let size = 0;
  for (const entry of entries.toReversed()) {
    if (size + entry.length > limit) break;
    kept.unshift(entry);
    size += entry.length;
  }
  const omitted = kept.length < entries.length ? '(Earlier messages were left out.)\n\n' : '';

  return [
    'This chat started with another assistant. The conversation so far is below; continue it.',
    `<previous_conversation>\n${omitted}${kept.join('\n\n')}\n</previous_conversation>`,
    text,
  ].join('\n\n');
};
