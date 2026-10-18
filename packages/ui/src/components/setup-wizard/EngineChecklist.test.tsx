import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { EngineChecklist } from './EngineChecklist';
import { deriveChecklist, type EngineSnapshot } from './engineSetupModel';

const snapshot = (engine: EngineSnapshot['status']['engine'], login: string): EngineSnapshot => ({
  status: {
    engine,
    displayName: engine,
    providerID: engine,
    installed: true,
    version: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
    canInstall: true,
    installCommand: 'npm install -g x',
    state: 'idle',
    lastError: null,
    installSource: 'npm',
    actions: { install: true, update: true, reinstall: true, uninstall: true, doctor: false },
    commands: { install: null, update: null, reinstall: null, uninstall: null, doctor: null, login, logout: null },
    currentAction: null,
    rawVersion: null,
    commandPath: null,
    detectionError: null,
  },
  readiness: 'signed-out',
  fixCommand: null,
});

const render = (value: EngineSnapshot, onRun: (() => void) | null) => renderToStaticMarkup(
  <I18nProvider>
    <EngineChecklist
      snapshot={value}
      checklist={deriveChecklist(value, { enterpriseMode: false })}
      modelCount={0}
      enterpriseMode={false}
      onInstall={() => undefined}
      onUpdate={() => undefined}
      onRun={onRun}
    />
  </I18nProvider>,
);

describe('EngineChecklist', () => {
  test('sign-in is a terminal command, update stays a server button', () => {
    const html = render(snapshot('claude', 'claude auth login'), () => undefined);
    expect(html).toContain('claude auth login');
    expect(html).toContain('Run in terminal');
    expect(html).toContain('>Update<');
    expect(html).not.toContain('>Sign in<');
  });

  test('agy sign-in says to type /login', () => {
    expect(render(snapshot('antigravity', 'agy'), () => undefined)).toContain('/login');
  });

  test('without a terminal only Copy is offered', () => {
    const html = render(snapshot('codex', 'codex login --device-auth'), null);
    expect(html).toContain('Copy');
    expect(html).not.toContain('Run in terminal');
  });
});
