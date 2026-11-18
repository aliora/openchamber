import { LOCAL_HOST_ID } from '@/lib/desktopCurrentHost';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { normalizeHostUrl, redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';

export type HostListState = {
  hosts: DesktopHost[];
  defaultHostId: string | null;
  localHostLabel: string | null;
};

export const addHostTo = (state: HostListState, host: DesktopHost): HostListState => ({
  ...state,
  hosts: [host, ...state.hosts],
});

export const renameHostIn = (state: HostListState, hostId: string, draft: string): HostListState => {
  const label = draft.trim();
  if (hostId === LOCAL_HOST_ID) return { ...state, localHostLabel: label || null };
  return {
    ...state,
    hosts: state.hosts.map((host) => (host.id === hostId ? { ...host, label: label || redactSensitiveUrl(host.url) } : host)),
  };
};

export const removeHostFrom = (state: HostListState, hostId: string): HostListState => ({
  ...state,
  hosts: state.hosts.filter((host) => host.id !== hostId),
  defaultHostId: state.defaultHostId === hostId ? LOCAL_HOST_ID : state.defaultHostId,
});

export const createDraftId = (): string => (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export type AddressDraft = {
  id: string;
  url: string;
};

export const createAddressDraft = (url = ''): AddressDraft => ({ id: createDraftId(), url });

export const moveListItem = <T>(items: T[], index: number, offset: -1 | 1): T[] => {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
};

export type FailoverAddressError = { reason: 'empty' } | { reason: 'invalid' | 'duplicate'; address: string };

export const failoverErrorText = (error: FailoverAddressError, t: (key: I18nKey, params?: I18nParams) => string): string => {
  if (error.reason === 'empty') return t('settings.remoteInstances.direct.failover.error.empty');
  return error.reason === 'invalid'
    ? t('settings.remoteInstances.direct.failover.error.invalid', { address: error.address })
    : t('settings.remoteInstances.direct.failover.error.duplicate', { address: error.address });
};

// A bare IP or host name is the same server on another network, so it keeps
// the main address's protocol and port.
const withMainScheme = (address: string, main: URL): string | null => {
  if (address.includes('://')) return normalizeHostUrl(address);
  try {
    const url = new URL(`${main.protocol}//${address}`);
    if (!url.port) url.port = main.port;
    return url.href;
  } catch {
    return null;
  }
};

/** The failover addresses typed for a host whose main address is `mainUrl`, as stored, or the first one at fault. */
export const resolveFailoverUrls = (mainUrl: string, drafts: string[]): { urls: string[] } | { error: FailoverAddressError } => {
  const main = new URL(mainUrl);
  const seen = new Set([main.href]);
  const urls: string[] = [];
  for (const draft of drafts) {
    const address = draft.trim();
    if (!address) return { error: { reason: 'empty' } };
    const resolved = withMainScheme(address, main);
    if (!resolved) return { error: { reason: 'invalid', address } };
    const href = new URL(resolved).href;
    if (seen.has(href)) return { error: { reason: 'duplicate', address } };
    seen.add(href);
    urls.push(href);
  }
  return { urls };
};
