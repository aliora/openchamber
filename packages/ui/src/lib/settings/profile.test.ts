import { describe, expect, test } from 'bun:test';

import {
  PROFILE_STORAGE_KEY,
  createDeviceProfileStore,
  emptyProfile,
  mergeProfile,
  parseProfileStamps,
  profileStampsFor,
  recordProfileChanges,
  type DeviceProfile,
} from './profile';
import { DESKTOP_SHELL_KEYS, PROFILE_KEYS, isProfileSettingsKey } from './registry';

const profileOf = (values: DeviceProfile['values'], updatedAt: DeviceProfile['updatedAt']): DeviceProfile => ({ values, updatedAt });

const memoryStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
};

describe('profile keys', () => {
  test('carry preferences only, never instance facts, secrets or desktop shell keys', () => {
    expect(PROFILE_KEYS).toContain('fontSize');
    expect(PROFILE_KEYS).toContain('themeId');
    expect(PROFILE_KEYS).toContain('defaultModel');
    expect(PROFILE_KEYS).toContain('favoriteModels');
    expect(PROFILE_KEYS).toContain('hiddenModels');
    for (const key of ['projects', 'homeDirectory', 'terminalShell', 'desktopUiPassword', 'managedRemoteTunnelToken', 'githubClientId', 'mobileKeyboardMode', ...DESKTOP_SHELL_KEYS]) {
      expect(isProfileSettingsKey(key)).toBe(false);
    }
  });
});

describe('mergeProfile', () => {
  test('the newer side wins field by field', () => {
    const local = profileOf({ fontSize: 18, uiFont: 'system' }, { fontSize: 200, uiFont: 100 });
    const merge = mergeProfile(local, { fontSize: 12, uiFont: 'inter' }, { fontSize: 150, uiFont: 300 });

    expect(merge.document.fontSize).toBe(18);
    expect(merge.document.uiFont).toBe('inter');
    expect(merge.push).toEqual({ fontSize: 18 });
    expect(merge.adopted).toEqual({ uiFont: 'inter' });
    expect(merge.profile.values).toEqual({ fontSize: 18, uiFont: 'inter' });
    expect(merge.profile.updatedAt).toEqual({ fontSize: 200, uiFont: 300 });
  });

  test('a tie keeps the device value and sends it to the host', () => {
    const merge = mergeProfile(profileOf({ fontSize: 18 }, { fontSize: 100 }), { fontSize: 12 }, { fontSize: 100 });

    expect(merge.document.fontSize).toBe(18);
    expect(merge.push).toEqual({ fontSize: 18 });
    expect(merge.adopted).toEqual({});
  });

  test('equal values send nothing and keep the newer stamp', () => {
    const merge = mergeProfile(profileOf({ fontSize: 18 }, { fontSize: 100 }), { fontSize: 18 }, { fontSize: 400 });

    expect(merge.push).toEqual({});
    expect(merge.adopted).toEqual({});
    expect(merge.profile.updatedAt.fontSize).toBe(400);
  });

  test('a value the host lacks is sent; a value the device lacks is adopted with its stamp', () => {
    const merge = mergeProfile(profileOf({ fontSize: 18 }, { fontSize: 5 }), { uiFont: 'inter' }, { uiFont: 7 });

    expect(merge.push).toEqual({ fontSize: 18 });
    expect(merge.adopted).toEqual({ uiFont: 'inter' });
    expect(merge.document).toEqual({ fontSize: 18, uiFont: 'inter' });
    expect(merge.profile.updatedAt).toEqual({ fontSize: 5, uiFont: 7 });
  });

  test('instance keys pass through untouched and never enter the profile or the push', () => {
    const local = profileOf({ fontSize: 18 }, { fontSize: 100 });
    const merge = mergeProfile(local, { projects: [], terminalShell: 'zsh', homeDirectory: '/home/b' }, { fontSize: 1 });

    expect(merge.document.homeDirectory).toBe('/home/b');
    expect(merge.document.terminalShell).toBe('zsh');
    expect(merge.profile.values).toEqual({ fontSize: 18 });
    expect(Object.keys(merge.push)).toEqual(['fontSize']);
  });

  test('a host without stamps keeps the previous behavior: its values win with an unknown age', () => {
    const merge = mergeProfile(profileOf({ fontSize: 18, uiFont: 'system' }, { fontSize: 100, uiFont: 100 }), { fontSize: 12, uiFont: 'system' }, null);

    expect(merge.document).toEqual({ fontSize: 12, uiFont: 'system' });
    expect(merge.push).toEqual({});
    expect(merge.adopted).toEqual({ fontSize: 12 });
    expect(merge.profile.updatedAt).toEqual({ fontSize: 0, uiFont: 100 });
  });

  test('an empty profile is seeded from the host with the host stamps', () => {
    const merge = mergeProfile(emptyProfile(), { fontSize: 12, themeId: 'flexoki-dark', projects: [] }, { fontSize: 50, themeId: 60 });

    expect(merge.profile.values).toEqual({ fontSize: 12, themeId: 'flexoki-dark' });
    expect(merge.profile.updatedAt).toEqual({ fontSize: 50, themeId: 60 });
    expect(merge.push).toEqual({});
  });
});

describe('parseProfileStamps', () => {
  test('keeps finite stamps of profile keys and drops unknown, instance and invalid entries', () => {
    expect(parseProfileStamps({
      _profileUpdatedAt: { fontSize: 10, projects: 20, nope: 30, uiFont: 'x', themeId: -1, locale: Number.NaN },
    })).toEqual({ fontSize: 10 });
  });

  test('is null when the host sends no stamps', () => {
    expect(parseProfileStamps({ fontSize: 12 })).toBeNull();
    expect(parseProfileStamps(null)).toBeNull();
  });
});

describe('recordProfileChanges', () => {
  test('stamps only profile keys whose value changed', () => {
    const { profile, changed } = recordProfileChanges(
      profileOf({ fontSize: 18 }, { fontSize: 100 }),
      { fontSize: 18, uiFont: 'inter', terminalShell: 'zsh' },
      500,
    );

    expect(changed).toEqual({ uiFont: 'inter' });
    expect(profile.values).toEqual({ fontSize: 18, uiFont: 'inter' });
    expect(profile.updatedAt).toEqual({ fontSize: 100, uiFont: 500 });
  });
});

describe('profileStampsFor', () => {
  test('names the stamps of the profile keys only', () => {
    expect(profileStampsFor(profileOf({ fontSize: 18 }, { fontSize: 100 }), ['fontSize', 'projects', 'uiFont'])).toEqual({ fontSize: 100 });
  });
});

describe('device profile store', () => {
  test('round-trips through one storage key that does not depend on the runtime', () => {
    const storage = memoryStorage();
    const store = createDeviceProfileStore(() => storage);
    store.write(profileOf({ fontSize: 18, themeId: 'flexoki-dark' }, { fontSize: 1, themeId: 2 }));

    expect([...storage.values.keys()]).toEqual([PROFILE_STORAGE_KEY]);
    expect(store.read()).toEqual(profileOf({ fontSize: 18, themeId: 'flexoki-dark' }, { fontSize: 1, themeId: 2 }));
  });

  test('drops values the registry rejects and keys outside the profile', () => {
    const storage = memoryStorage();
    storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify({
      version: 1,
      values: { fontSize: 'big', uiFont: 'inter', projects: [], homeDirectory: '/x' },
      updatedAt: { uiFont: 9, projects: 3 },
    }));

    expect(createDeviceProfileStore(() => storage).read()).toEqual(profileOf({ uiFont: 'inter' }, { uiFont: 9 }));
  });

  test('reads garbage as an empty profile', () => {
    const storage = memoryStorage();
    storage.setItem(PROFILE_STORAGE_KEY, '{not json');

    expect(createDeviceProfileStore(() => storage).read()).toEqual(emptyProfile());
  });
});
