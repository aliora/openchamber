import type { IntegrationExternalMethod, IntegrationOAuthMethod } from '@opencode/client';

/**
 * Methods that sign in with a button rather than a pasted key: OAuth, and
 * external credentials OpenCode references outside its store (2.0.25+: an
 * Azure CLI login, an AWS profile). Kept in the integration's declared order.
 */
export type SignInMethod = IntegrationOAuthMethod | IntegrationExternalMethod;
