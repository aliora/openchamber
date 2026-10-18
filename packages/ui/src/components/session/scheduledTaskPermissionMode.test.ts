import { describe, expect, test } from 'bun:test';

import type { EngineControlsCatalog } from '@/stores/useEngineControlsStore';
import { resolveTaskPermission, taskPermissionModeToSave } from './scheduledTaskPermissionMode';

const mode = (id: string, dangerous = false) => ({
  id,
  labelKey: `engine.permissionMode.antigravity.${id}.label`,
  descriptionKey: `engine.permissionMode.antigravity.${id}.description`,
  dangerous,
  appliesLive: false,
});

const catalog: EngineControlsCatalog = {
  defaultEngine: 'claude',
  engines: [
    {
      engine: 'antigravity',
      providerID: 'google',
      defaultPermissionMode: 'default',
      permissionModes: [mode('default'), mode('accept-edits'), mode('dangerously-skip-permissions', true)],
      defaultEffort: 'medium',
    },
    {
      engine: 'claude',
      providerID: 'anthropic',
      defaultPermissionMode: 'manual',
      permissionModes: [{ ...mode('manual'), labelKey: 'x', descriptionKey: 'y' }],
      defaultEffort: null,
    },
  ],
};

describe('resolveTaskPermission', () => {
  test('shows the stored mode of the model engine', () => {
    const resolved = resolveTaskPermission(catalog, 'google', 'dangerously-skip-permissions');
    expect(resolved?.engine.engine).toBe('antigravity');
    expect(resolved?.mode.id).toBe('dangerously-skip-permissions');
  });

  test('shows the engine default for no mode or another engine mode', () => {
    expect(resolveTaskPermission(catalog, 'google', '')?.mode.id).toBe('default');
    expect(resolveTaskPermission(catalog, 'anthropic', 'dangerously-skip-permissions')?.mode.id).toBe('manual');
  });

  test('offers nothing without engines or for a provider no engine serves', () => {
    expect(resolveTaskPermission(null, 'google', '')).toBeNull();
    expect(resolveTaskPermission(catalog, 'openai', '')).toBeNull();
  });
});

describe('taskPermissionModeToSave', () => {
  test('saves a mode the engine lists other than its default', () => {
    expect(taskPermissionModeToSave(catalog, 'google', 'dangerously-skip-permissions')).toBe('dangerously-skip-permissions');
  });

  test('drops the default and a mode of another engine', () => {
    expect(taskPermissionModeToSave(catalog, 'google', 'default')).toBeUndefined();
    expect(taskPermissionModeToSave(catalog, 'anthropic', 'dangerously-skip-permissions')).toBeUndefined();
    expect(taskPermissionModeToSave(catalog, 'google', '')).toBeUndefined();
  });

  test('keeps the stored mode while the engines are unknown', () => {
    expect(taskPermissionModeToSave(null, 'google', 'dangerously-skip-permissions')).toBe('dangerously-skip-permissions');
    expect(taskPermissionModeToSave(catalog, 'openai', 'dangerously-skip-permissions')).toBe('dangerously-skip-permissions');
  });
});
