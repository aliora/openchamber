import { describe, expect, test } from 'bun:test';

import { getSettingsItemScope, getSettingsPageScope } from './scope-markers';

describe('settings scope markers', () => {
  test('pages name where their settings live', () => {
    expect(getSettingsPageScope('appearance')).toBe('profile');
    expect(getSettingsPageScope('projects')).toBe('instance');
    expect(getSettingsPageScope('general')).toBeNull();
  });

  test('portable instance settings read as shared, and Engines names its picked host instead', () => {
    for (const page of ['mcp', 'agents', 'commands', 'skills.installed'] as const) expect(getSettingsPageScope(page)).toBe('profile');
    expect(getSettingsPageScope('providers')).toBeNull();
    expect(getSettingsPageScope('plugins')).toBe('instance');
    expect(getSettingsItemScope('git.identities')).toBe('profile');
    expect(getSettingsItemScope('projects.default-model')).toBe('profile');
  });

  test('items take their scope from the registry key they edit', () => {
    expect(getSettingsItemScope('sessions.default-model')).toBe('profile');
    expect(getSettingsItemScope('appearance.pwa-install-name')).toBe('instance');
    expect(getSettingsItemScope('sessions.retention-period')).toBe('instance');
    expect(getSettingsItemScope('appearance.mobile-keyboard-mode')).toBe('device');
    expect(getSettingsItemScope('appearance.scrollbars')).toBe('device');
    expect(getSettingsItemScope('chat.unknown-item')).toBeNull();
  });
});
