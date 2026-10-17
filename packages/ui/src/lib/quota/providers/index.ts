import type { QuotaProviderId } from '@/types';

interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
  /** The CLI whose login the provider reads, and the command that signs it in. */
  signIn: { cli: string; command: string };
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude', signIn: { cli: 'Claude Code', command: 'claude auth login' } },
  { id: 'codex', name: 'Codex', signIn: { cli: 'Codex', command: 'codex login' } },
];
