import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { defineHostValue } from '@/lib/hosts/runtime/host-bindings';

const accountSchema = z.object({ id: z.string().min(1), label: z.string().min(1), isDefault: z.boolean() });
export const engineAccountsSchema = z.object({ data: z.array(accountSchema), supported: z.boolean() });
export type EngineAccount = z.infer<typeof accountSchema>;
export type EngineAccounts = z.infer<typeof engineAccountsSchema>;
const authSchema = z.object({ loggedIn: z.boolean(), email: z.string().nullish() });
const errorSchema = z.object({ error: z.string().optional(), message: z.string().optional() });

const accountChangeListeners = defineHostValue(() => new Set<() => void>());

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
