import { z } from 'zod';

const LOCAL_HOST_ID = 'local';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

const trimmedStringSchema = z.string().trim().catch('');

const trimmedString = (value) => trimmedStringSchema.parse(value);

export const resolveFocusHostId = (rawId, { hosts, localAvailable }) => {
  const id = trimmedString(rawId);
  if (!id) return null;
  if (id === LOCAL_HOST_ID) return localAvailable ? id : null;
  return hosts.some((host) => host.id === id) ? id : null;
};

export const resolveInitialFocusHostId = ({ pendingFocusHostId, defaultHostId, hosts, localAvailable }) => (
  resolveFocusHostId(pendingFocusHostId, { hosts, localAvailable })
  ?? resolveFocusHostId(defaultHostId, { hosts, localAvailable })
);

export const withInitialFocus = (outcome, initialFocusHostId) => (
  initialFocusHostId && outcome?.status === 'ok' ? { ...outcome, initialFocusHostId } : outcome
);

const isLoopbackUrl = (raw) => {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(raw).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
};

export const findLoopbackHost = (hosts) => (
  hosts.find((host) => !host.relay && isLoopbackUrl(host.apiUrl || host.url)) ?? null
);

export const readLocalHostLabel = (root) => trimmedString(root?.desktopLocalHostLabel) || null;

export const applyLocalHostLabel = (root, config) => {
  if (!Object.prototype.hasOwnProperty.call(config || {}, 'localHostLabel')) return;
  const label = trimmedString(config.localHostLabel);
  if (label) {
    root.desktopLocalHostLabel = label;
    return;
  }
  delete root.desktopLocalHostLabel;
};

export const focusHostInWindow = ({ hostId, mainWindow, emit, remember }) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) {
    remember(hostId);
    return false;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  emit(mainWindow, 'openchamber:focus-host', { hostId });
  return true;
};
