export type QuotaProviderId = 'claude' | 'codex';

export interface UsageWindow {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowSeconds: number | null;
  resetAfterSeconds: number | null;
  resetAt: number | null;
  resetAtFormatted: string | null;
  resetAfterFormatted: string | null;
  valueLabel?: string | null;
}

interface UsageWindows {
  windows: Record<string, UsageWindow>;
}

interface ProviderUsage extends UsageWindows {
  models?: Record<string, UsageWindows>;
}

export interface ProviderResult {
  providerId: QuotaProviderId;
  providerName: string;
  ok: boolean;
  configured: boolean;
  error?: string;
  /** Subscription tier reported by the provider, when it exposes one. */
  planLabel?: string | null;
  usage: ProviderUsage | null;
  fetchedAt: number;
}
