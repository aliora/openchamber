import { isString } from '../../shared/guards.js';

const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const TODO_TOOL = 'TodoWrite';
const DETAIL_FIELDS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];
const MAX_ACTIVITY_LENGTH = 120;

/**
 * Claude's `Task`/`Agent` and `TodoWrite` calls under the names the chat draws
 * as a subagent row and a checklist.
 */
export const toCardTool = (name, input) => {
  if (SUBAGENT_TOOLS.has(name)) {
    return { name: 'subagent', input: { description: input?.description, agent: input?.subagent_type, prompt: input?.prompt } };
  }
  return { name: name === TODO_TOOL ? 'todo' : name, input };
};

/** One line for what a subagent's tool call does, such as `Read src/app.ts`. */
export const describeActivity = (name, input) => {
  const detail = DETAIL_FIELDS.map((field) => input?.[field]).find((value) => isString(value) && value.trim());
  const line = detail ? `${name} ${detail.trim().split('\n')[0]}` : name;
  return line.slice(0, MAX_ACTIVITY_LENGTH);
};
