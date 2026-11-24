import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { defineHostValue } from '@/lib/hosts/runtime/host-bindings';

const accountSchema = z.object({ id: z.string().min(1), label: z.string().min(1), isDefault: z.boolean() });
export const engineAccountsSchema = z.object({ data: z.array(accountSchema), supported: z.boolean() });
export type EngineAccount = z.infer<typeof accountSchema>;
export type EngineAccounts = z.infer<typeof engineAccountsSchema>;
const authSchema = z.object({ loggedIn: z.boolean(), email: z.string().nullish() });
const errorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

const sessionAccountSchema = z.object({
  data: z.object({ engine: z.string().min(1), accountId: z.string().min(1).default('default'), accountLabel: z.string().min(1).default('Default') }),
});
export type SessionEngineAccount = z.infer<typeof sessionAccountSchema>['data'];

/** The account each CLI signs in to on its own, outside any named account home. */
export const AMBIENT_ACCOUNT_ID = 'default';

export const engineAccountName = (account: { id: string; label: string }, ambientName: string): string =>
  account.id === AMBIENT_ACCOUNT_ID ? ambientName : account.label;

export const MULTI_ACCOUNT_ENGINES = ['claude', 'codex'] as const;
export type MultiAccountEngine = typeof MULTI_ACCOUNT_ENGINES[number];
export const isMultiAccountEngine = (engine: string | undefined): engine is MultiAccountEngine =>
  MULTI_ACCOUNT_ENGINES.some((candidate) => candidate === engine);

const accountChangeListeners = defineHostValue(() => new Set<() => void>());
const draftAccounts = defineHostValue(() => new Map<string, string>());

/** Catalog events also announce active-account changes made by another client. */
export const notifyEngineAccountsChanged = (): void => {
  for (const listener of accountChangeListeners()) listener();
};

export const subscribeEngineAccountChanges = (listener: () => void): (() => void) => {
  const listeners = accountChangeListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const engineAccountPath = (engine: string, accountId?: string): string =>
  `/api/engines/${encodeURIComponent(engine)}/accounts${accountId ? `/${encodeURIComponent(accountId)}` : ''}`;

const checkResponse = async (response: Response): Promise<Response> => {
  if (response.ok) return response;
  const error = errorSchema.safeParse(await response.json().catch(() => null));
  throw new Error(error.success ? error.data.error ?? error.data.message ?? `Request failed (${response.status})` : `Request failed (${response.status})`);
};

export const fetchEngineAccounts = async (engine: string): Promise<EngineAccounts> => {
  const response = await checkResponse(await runtimeFetch(engineAccountPath(engine)));
  return engineAccountsSchema.parse(await response.json());
};

export const fetchEngineAccountAuth = async (engine: string, accountId: string) => {
  const response = await checkResponse(await runtimeFetch(`${engineAccountPath(engine, accountId)}/auth/status`));
  return authSchema.parse(await response.json());
};

export const changeEngineAccount = async (engine: string, action: 'add' | 'default' | 'remove' | 'logout', accountId?: string, label?: string): Promise<void> => {
  const suffix = action === 'default' ? '/default' : action === 'logout' ? '/auth/logout' : '';
  await checkResponse(await runtimeFetch(`${engineAccountPath(engine, accountId)}${suffix}`, {
    method: action === 'remove' ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: action === 'add' ? JSON.stringify({ label }) : undefined,
  }));
};

export const fetchSessionEngineAccount = async (sessionId: string): Promise<SessionEngineAccount> => {
  const response = await checkResponse(await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}`));
  return sessionAccountSchema.parse(await response.json()).data;
};

/** Moves one session to another account of its engine; other sessions keep theirs. */
export const changeSessionEngineAccount = async (sessionId: string, accountId: string): Promise<SessionEngineAccount> => {
  const response = await checkResponse(await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId }),
  }));
  const account = sessionAccountSchema.parse(await response.json()).data;
  notifyEngineAccountsChanged();
  return account;
};

/** The account a draft composer picked for an engine; the session it becomes starts on it. */
export const readDraftEngineAccount = (engine: string): string | undefined => draftAccounts().get(engine);

export const setDraftEngineAccount = (engine: string, accountId: string | null): void => {
  if (accountId) draftAccounts().set(engine, accountId);
  else draftAccounts().delete(engine);
  notifyEngineAccountsChanged();
};
