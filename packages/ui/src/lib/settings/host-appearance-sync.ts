import type { HostTransport } from '@/lib/hosts/host-transport';
import { parseHostLogos } from '@/lib/engineAppearance';
import { useUIStore } from '@/stores/useUIStore';

import { mergeHostAppearance, type HostAppearance } from './host-appearance';
import { profileFanOut } from './profile-fan-out';
import { parseSettingsDocument } from './registry';
import { SETTINGS_SURFACE_QUERY, getSettingsSurface } from './surface';

const REQUEST_TIMEOUT_MS = 15_000;

const appearanceOf = (settings: Partial<HostAppearance>): HostAppearance => ({
  hostLabels: settings.hostLabels ?? {},
  hostLogos: settings.hostLogos ?? {},
  hostAppearanceStamps: settings.hostAppearanceStamps ?? {},
});

const isSame = (left: HostAppearance, right: HostAppearance): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Reads one watched host's shared names and icons, merges them into this device, and sends back what the host lacks. */
export const reconcileHostAppearance = async (target: Pick<HostTransport, 'fetch'>): Promise<void> => {
  const path = `/api/config/settings?${SETTINGS_SURFACE_QUERY}=${getSettingsSurface()}`;
  const result = await target.fetch(path, { accept: 'application/json', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!result.ok) return;
  const remote = parseSettingsDocument(await result.response.json().catch(() => null));
  if (!remote) return;
  const { hostLabels, hostLogos, hostAppearanceStamps } = useUIStore.getState();
  const local = appearanceOf({ hostLabels, hostLogos, hostAppearanceStamps });
  const merged = mergeHostAppearance(local, appearanceOf(remote), Date.now());
  const settings = { ...merged, hostLogos: parseHostLogos(merged.hostLogos) ?? {} };
  if (!isSame(merged, local)) useUIStore.setState(settings);
  if (isSame(merged, appearanceOf(remote))) return;
  const now = Date.now();
  profileFanOut.queue(settings, { hostLabels: now, hostLogos: now, hostAppearanceStamps: now });
};
