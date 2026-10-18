import { describe, expect, test } from 'bun:test';

import { getSettingsItemScope, getSettingsPageScope } from './scope-markers';

describe('settings scope markers', () => {
  test('pages name where their settings live', () => {
    expect(getSettingsPageScope('appearance')).toBe('profile');
    expect(getSettingsPageScope('projects')).toBe('instance');
    expect(getSettingsPageScope('general')).toBeNull();
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
