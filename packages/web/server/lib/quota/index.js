/**
 * Quota module
 *
 * Provides quota usage tracking for the Claude, Codex and Antigravity subscriptions.
 * @module quota
 */

/** @public */
export {
  listConfiguredQuotaProviders,
  fetchQuotaForProvider
} from './providers/index.js';
