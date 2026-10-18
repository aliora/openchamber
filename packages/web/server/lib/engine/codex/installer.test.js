import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexInstaller, OFFICIAL_PACKAGE_NAME, detectCodexInstallation } from './installer.js';

describe('CodexInstaller', () => {
  let appData;

  beforeEach(() => {
    // A Windows npm prefix: %APPDATA%\npm\codex.cmd next to node_modules\@openai\codex.
    appData = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-codex-install-'));
    const prefix = path.join(appData, 'npm');
    fs.mkdirSync(path.join(prefix, 'node_modules', '@openai', 'codex'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@echo off\n');
    fs.writeFileSync(
      path.join(prefix, 'node_modules', '@openai', 'codex', 'package.json'),
      JSON.stringify({ name: '@openai/codex', version: '0.163.0' }),
    );
  });

  afterEach(() => {
    fs.rmSync(appData, { recursive: true, force: true });
  });

  it('installs the official npm package', () => {
    expect(OFFICIAL_PACKAGE_NAME).toBe('@openai/codex');
  });

  it('reads the version from the package next to the npm launcher', () => {
    const detection = detectCodexInstallation({ platform: 'win32', env: { APPDATA: appData } });
    expect(detection).toMatchObject({
      installed: true,
      version: '0.163.0',
      command: path.join(appData, 'npm', 'codex.cmd'),
      isWindows: true,
    });
  });

  it('reports the detected install and npm as the way to install', () => {
    const status = new CodexInstaller({ platform: 'win32', env: { APPDATA: appData } }).getStatus();
    expect(status).toMatchObject({
      state: 'idle',
      installed: true,
      version: '0.163.0',
      packageManager: 'npm',
      canInstall: true,
      installSource: 'npm',
      installCommand: 'npm install -g @openai/codex@latest',
    });
    expect(status.commands).toMatchObject({ uninstall: 'npm uninstall -g @openai/codex', doctor: `${path.join(appData, 'npm', 'codex.cmd')} doctor` });
  });

  it('streams install output as log events', () => {
    const installer = new CodexInstaller();
    const logs = [];
    installer.on('log', (entry) => logs.push([entry.stream, entry.text]));
    installer._appendLog('stdout', 'added 1 package\n');
    expect(logs).toEqual([['stdout', 'added 1 package\n']]);
    expect(installer.getLogs()).toHaveLength(1);
  });
});
