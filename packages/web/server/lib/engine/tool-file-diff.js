const NO_FILE = '/dev/null';

const contentLines = (text) => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

const countLines = (hunks, mark) => hunks.split('\n').filter((line) => line.startsWith(mark)).length;

const rangeStart = (start, length) => (length > 0 ? start : start - 1);

export const replacementHunk = (before, after, start = 1) => {
  const removed = contentLines(before);
  const added = contentLines(after);
  const header = `@@ -${rangeStart(start, removed.length)},${removed.length} +${rangeStart(start, added.length)},${added.length} @@`;
  return [header, ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join('\n') + '\n';
};

export const toolFileDiff = ({ file, from = file, to = file, hunks, status }) => ({
  file,
  patch: `--- ${from}\n+++ ${to}\n${hunks}`,
  additions: countLines(hunks, '+'),
  deletions: countLines(hunks, '-'),
  status,
});

export const addedFileDiff = (file, content) => toolFileDiff({ file, from: NO_FILE, hunks: replacementHunk('', content), status: 'added' });

export const deletedFileDiff = (file, content) => toolFileDiff({ file, to: NO_FILE, hunks: replacementHunk(content, ''), status: 'deleted' });
