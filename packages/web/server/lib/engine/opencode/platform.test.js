import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenCodeExecutable } from './platform.js';

test('administrator binary pin wins over environment and never falls back when missing', async () => {
  const resolved = await resolveOpenCodeExecutable({ env: process.env, readPolicy: () => ({ opencodeBinary: process.execPath }) });
  assert.equal(resolved.command, process.execPath);
  await assert.rejects(resolveOpenCodeExecutable({ env: process.env, readPolicy: () => ({ opencodeBinary: 'C:/nonexistent-opencode-pin.exe' }) }), /administrator/);
});
