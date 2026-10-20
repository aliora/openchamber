import { addedFileDiff, deletedFileDiff, toolFileDiff } from '../tool-file-diff.js';

const mcpResultText = (result) => (result?.content ?? [])
  .filter((block) => block.type === 'text' && block.text !== undefined)
  .map((block) => block.text)
  .join('\n');

const fileChangeCall = (changes) => {
  const [only] = changes;
  if (changes.length === 1 && only.kind.type === 'add') return { name: 'write', input: { path: only.path, content: only.diff } };
  if (changes.length === 1 && only.kind.type === 'update' && !only.kind.move_path) return { name: 'edit', input: { path: only.path } };
  return { name: 'patch', input: { changes: changes.map((change) => ({ path: change.path, kind: change.kind.type })) } };
};

const changeDiff = ({ path, kind, diff }) => {
  if (kind.type === 'add') return addedFileDiff(path, diff);
  if (kind.type === 'delete') return deletedFileDiff(path, diff);
  const target = kind.move_path || path;
  return toolFileDiff({ file: target, from: path, to: target, hunks: diff, status: 'modified' });
};

const commandResult = ({ id, status, exitCode, aggregatedOutput }) => {
  const output = aggregatedOutput ?? '';
  if (status === 'declined') return { id, output: 'The command was declined, so it did not run.', isError: true };
  const exited = exitCode !== null && exitCode !== 0;
  if (status === 'completed' && !exited) return { id, output, isError: false };
  return { id, output: exitCode === null ? output : `Exit code ${exitCode}\n${output}`, isError: true };
};

const FILE_CHANGE_FAILURES = {
  declined: 'The change was declined, so the file was not changed.',
  failed: 'Codex could not apply this change.',
};

const fileChangeResult = ({ id, status, changes }) => {
  const failure = status === 'completed' ? undefined : FILE_CHANGE_FAILURES[status] ?? FILE_CHANGE_FAILURES.failed;
  const result = { id, output: failure ?? '', isError: Boolean(failure) };
  if (fileChangeCall(changes).name === 'write') return result;
  return { ...result, metadata: { files: changes.map(changeDiff) } };
};

const mcpCallResult = ({ id, status, result, error }) => {
  const failed = status !== 'completed' || Boolean(error);
  return { id, output: failed && error ? error.message : mcpResultText(result), isError: failed };
};

const webSearchQuery = ({ query, action }) => query || action?.query || action?.queries?.join(', ') || action?.url || '';

export const startedToolCall = (item, toolServerName) => {
  switch (item.type) {
    case 'commandExecution':
      return { id: item.id, name: 'shell', input: { command: item.command, cwd: item.cwd } };
    case 'fileChange':
      return { id: item.id, ...fileChangeCall(item.changes) };
    case 'mcpToolCall': {
      const name = item.server === toolServerName ? item.tool : `mcp__${item.server}__${item.tool}`;
      return { id: item.id, name, input: item.arguments };
    }
  }
};

export const webSearchCall = (item) => ({ id: item.id, name: 'websearch', input: { query: webSearchQuery(item) } });

export const finishedToolResult = (item) => {
  switch (item.type) {
    case 'commandExecution':
      return commandResult(item);
    case 'fileChange':
      return fileChangeResult(item);
    case 'mcpToolCall':
      return mcpCallResult(item);
    case 'webSearch':
      return { id: item.id, output: '', isError: false };
  }
};
