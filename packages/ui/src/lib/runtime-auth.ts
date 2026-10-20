import { currentRuntimeTransport } from '@/lib/hosts/runtime/runtime-transport';
import type { MintedUrlAuthToken, RuntimeAuth, RuntimeAuthCredentialProvider } from '@/lib/hosts/runtime/transport-auth';

export {
  getLocalRuntimeUrlAuthTokenSync,
  refreshLocalRuntimeUrlAuthToken,
  setLocalRuntimeUrlAuthToken,
} from '@/lib/hosts/runtime/transport-auth';

const currentAuth = (): RuntimeAuth => currentRuntimeTransport().auth;

export const clearRuntimeUrlAuthToken = (): void => {
  currentAuth().clearUrlToken();
};

export const setRuntimeAuthCredentialProvider = (provider: RuntimeAuthCredentialProvider): void => {
  currentAuth().setCredentialProvider(provider);
};

export const clearRuntimeAuthCredentialProvider = (): void => {
  currentAuth().clearCredentialProvider();
};

export const setRuntimeBearerToken = (token: string | null | undefined): void => {
  currentAuth().setBearerToken(token);
};

export const setRuntimeExtraHeaders = (headers: Record<string, string> | null | undefined): void => {
  currentAuth().setExtraHeaders(headers);
};

export const getRuntimeExtraHeadersSync = (): Record<string, string> => currentAuth().extraHeaders();

export const getRuntimeBearerTokenSync = (): string => currentAuth().bearerToken();

export const setRuntimeUrlAuthToken = (token: string | null | undefined, expiresAt: number | null | undefined): void => {
  currentAuth().setUrlToken(token, expiresAt);
};

export const getRuntimeUrlAuthTokenSync = (): string => currentAuth().urlToken();

/**
 * A token that opens only one guest's package files. It is never cached: the
 * guest iframe URL is readable by the guest's own script, so every mount gets a
 * fresh token that is worthless outside `/api/guests/<id>/`.
 */
export const mintGuestFrameUrlAuthToken = (guestId: string): Promise<MintedUrlAuthToken> => currentAuth().mintGuestFrameUrlToken(guestId);

export const refreshRuntimeUrlAuthToken = (apiBaseUrl?: string | null): Promise<string> => currentAuth().refreshUrlToken(apiBaseUrl);

export const acquireRuntimeUrlAuthToken = (apiBaseUrl?: string | null): (() => void) => currentAuth().acquireUrlToken(apiBaseUrl);

export const subscribeRuntimeUrlAuthToken = (listener: () => void): (() => void) => currentAuth().subscribeUrlToken(listener);

export const buildRuntimeAuthHeaders = (headers?: HeadersInit): Promise<Headers> => currentAuth().buildHeaders(headers);
