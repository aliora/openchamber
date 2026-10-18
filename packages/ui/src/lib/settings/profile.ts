import { z } from 'zod';

import { PROFILE_KEYS, isProfileSettingsKey, parseSettingsDocument, type DesktopSettings, type SettingsKey } from './registry';

export const PROFILE_STORAGE_KEY = 'openchamber.profile.v1';
export const PROFILE_UPDATED_AT_FIELD = '_profileUpdatedAt';

export type ProfileStamps = Partial<Record<SettingsKey, number>>;

export type DeviceProfile = {
  values: DesktopSettings;
  updatedAt: ProfileStamps;
};

export type ProfileMerge = {
  profile: DeviceProfile;
  document: DesktopSettings;
  adopted: DesktopSettings;
  push: DesktopSettings;
};

type ProfileStorage = Pick<Storage, 'getItem' | 'setItem'>;

export const emptyProfile = (): DeviceProfile => ({ values: {}, updatedAt: {} });

const stampsSchema = z.record(z.string(), z.unknown());
const storedProfileSchema = z.object({
  version: z.literal(1),
  values: z.unknown(),
  updatedAt: z.unknown(),
});

const isSameValue = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return JSON.stringify(left) === JSON.stringify(right);
};

const setValue = (target: DesktopSettings, key: SettingsKey, value: DesktopSettings[SettingsKey]): void => {
  Object.assign(target, { [key]: value });
};

const isStamp = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const parseProfileStamps = (payload: unknown): ProfileStamps | null => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const parsed = stampsSchema.safeParse(Reflect.get(payload, PROFILE_UPDATED_AT_FIELD));
  if (!parsed.success) return null;
  const stamps: ProfileStamps = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (isProfileSettingsKey(key) && isStamp(value)) stamps[key] = value;
  }
  return stamps;
};

const profileValuesOf = (settings: DesktopSettings): DesktopSettings => {
  const values: DesktopSettings = {};
  for (const key of PROFILE_KEYS) {
    if (settings[key] !== undefined) setValue(values, key, settings[key]);
  }
  return values;
};

export const parseStoredProfile = (raw: string | null): DeviceProfile => {
  if (!raw) return emptyProfile();
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return emptyProfile();
  }
  const stored = storedProfileSchema.safeParse(json);
  if (!stored.success) return emptyProfile();
  const values = profileValuesOf(parseSettingsDocument(stored.data.values) ?? {});
  const stamps = parseProfileStamps({ [PROFILE_UPDATED_AT_FIELD]: stored.data.updatedAt }) ?? {};
  const updatedAt: ProfileStamps = {};
  for (const key of PROFILE_KEYS) {
    if (values[key] !== undefined) updatedAt[key] = stamps[key] ?? 0;
  }
  return { values, updatedAt };
};

export const serializeProfile = (profile: DeviceProfile): string => JSON.stringify({
  version: 1,
  values: profile.values,
  updatedAt: profile.updatedAt,
});

export const recordProfileChanges = (
  profile: DeviceProfile,
  changes: DesktopSettings,
  now: number,
): { profile: DeviceProfile; changed: DesktopSettings } => {
  const values: DesktopSettings = { ...profile.values };
  const updatedAt: ProfileStamps = { ...profile.updatedAt };
  const changed: DesktopSettings = {};
  for (const key of PROFILE_KEYS) {
    const value = changes[key];
    if (value === undefined || isSameValue(values[key], value)) continue;
    setValue(values, key, value);
    setValue(changed, key, value);
    updatedAt[key] = now;
  }
  return { profile: { values, updatedAt }, changed };
};

export const mergeProfile = (
  local: DeviceProfile,
  remote: DesktopSettings,
  remoteStamps: ProfileStamps | null,
): ProfileMerge => {
  const values: DesktopSettings = { ...local.values };
  const updatedAt: ProfileStamps = { ...local.updatedAt };
  const document: DesktopSettings = { ...remote };
  const adopted: DesktopSettings = {};
  const push: DesktopSettings = {};

  const adopt = (key: SettingsKey, stamp: number): void => {
    setValue(values, key, remote[key]);
    setValue(adopted, key, remote[key]);
    updatedAt[key] = stamp;
  };

  for (const key of PROFILE_KEYS) {
    const remoteValue = remote[key];
    const localValue = local.values[key];
    if (remoteStamps === null) {
      if (remoteValue !== undefined && !isSameValue(localValue, remoteValue)) adopt(key, 0);
      continue;
    }
    if (remoteValue === undefined && localValue === undefined) continue;
    const remoteStamp = remoteStamps[key] ?? 0;
    const localStamp = local.updatedAt[key] ?? 0;
    if (localValue === undefined) {
      adopt(key, remoteStamp);
      continue;
    }
    if (remoteValue !== undefined && isSameValue(localValue, remoteValue)) {
      updatedAt[key] = Math.max(localStamp, remoteStamp);
      continue;
    }
    if (remoteValue !== undefined && remoteStamp > localStamp) {
      adopt(key, remoteStamp);
      continue;
    }
    setValue(document, key, localValue);
    setValue(push, key, localValue);
  }

  return { profile: { values, updatedAt }, document, adopted, push };
};

export const profileStampsFor = (profile: DeviceProfile, keys: readonly string[]): ProfileStamps => {
  const stamps: ProfileStamps = {};
  for (const key of keys) {
    if (!isProfileSettingsKey(key)) continue;
    const stamp = profile.updatedAt[key];
    if (stamp !== undefined) stamps[key] = stamp;
  }
  return stamps;
};

export type DeviceProfileStore = {
  read(): DeviceProfile;
  write(profile: DeviceProfile): void;
};

export const createDeviceProfileStore = (getStorage: () => ProfileStorage | null): DeviceProfileStore => ({
  read() {
    try {
      return parseStoredProfile(getStorage()?.getItem(PROFILE_STORAGE_KEY) ?? null);
    } catch {
      return emptyProfile();
    }
  },
  write(profile) {
    try {
      getStorage()?.setItem(PROFILE_STORAGE_KEY, serializeProfile(profile));
    } catch (error) {
      console.warn('Failed to store the device profile:', error);
    }
  },
});

export const deviceProfileStore = createDeviceProfileStore(() => globalThis.localStorage ?? null);
