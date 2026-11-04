import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectOpenCodeExecutable } from './installer.js';

test('recognizes actual v-prefixed CLI output and rejects incompatible releases', async () => {
  const resolveExecutable = async () => ({ command: 'fake', isWindows: false });
  const run = async () => ({ code: 0, stdout: 'opencode v2.0.31\n' });
  assert.equal((await inspectOpenCodeExecutable({ resolveExecutable, run })).version, '2.0.31');
  await assert.rejects(inspectOpenCodeExecutable({ resolveExecutable, run: async () => ({ code: 0, stdout: 'opencode v1.9.0' }) }), /requires OpenCode/);
});
