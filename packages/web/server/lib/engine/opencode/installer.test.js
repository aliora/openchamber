import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenCodeInstaller, inspectOpenCodeExecutable, openCodeNativePlan } from './installer.js';

test('recognizes actual v-prefixed CLI output and rejects incompatible releases', async () => {
  const resolveExecutable = async () => ({ command: 'fake', isWindows: false });
  const run = async () => ({ code: 0, stdout: 'opencode v2.0.31\n' });
  assert.equal((await inspectOpenCodeExecutable({ resolveExecutable, run })).version, '2.0.31');
  await assert.rejects(inspectOpenCodeExecutable({ resolveExecutable, run: async () => ({ code: 0, stdout: 'opencode v1.9.0' }) }), /requires OpenCode/);
});

test('plans npm install, update and uninstall for an npm-managed CLI', () => {
  const installer = new OpenCodeInstaller({ home: '/home/u', fetchLatest: async () => '2.2.5' });
  const fresh = installer.planActions({ installed: false });
  assert.equal(fresh.steps.install[0].display, 'npm install -g @opencode/cli@latest');
  assert.equal(fresh.steps.update, null);

  const managed = installer.planActions({ installed: true, managedByNpm: true, command: '/usr/local/bin/opencode', version: '2.0.31', isWindows: false });
  assert.equal(managed.installSource, 'npm');
  assert.equal(managed.steps.update[0].display, 'npm install -g @opencode/cli@latest');
  assert.equal(managed.steps.uninstall[0].display, 'npm uninstall -g @opencode/cli');
});

test('uses the CLI’s own upgrade and uninstall for a copy in ~/.opencode/bin', () => {
  const installer = new OpenCodeInstaller({ home: '/home/u', fetchLatest: async () => '2.2.5' });
  const native = installer.planActions({ installed: true, command: '/home/u/.opencode/bin/opencode', version: '2.0.31', isWindows: false });
  assert.equal(native.installSource, 'native');
  assert.deepEqual(native.steps.update[0].args, ['upgrade']);
  assert.deepEqual(native.steps.uninstall[0].args, ['uninstall', '--force']);

  assert.equal(openCodeNativePlan({ detection: { command: '/opt/homebrew/bin/opencode' }, home: '/home/u' }), null);
});
