import { OpenCode } from '@opencode/client';
import { asNonEmptyString } from '../shared/guards.js';

// The running OpenCode instance is the only transport this module has. It is
// wired once from `server/index.js`, and re-read on every call because the
// port and the server password both move across an OpenCode restart.
let connection = null;

/**
 * Wires this module to the running OpenCode instance. Pass `null` to detach.
 * Until it is wired, every lookup answers "no client", which the callers
 * report as "no small model available" rather than guessing.
 */
export function configureOpenCodeRuntimeProviders(next) {
  connection = next ?? null;
}

/**
 * Drops anything cached about the running instance. An OpenCode restart can
 * change the port, the password and the model list.
 */
export function resetOpenCodeRuntimeProviders() {
  modelCache = null;
  modelCacheKey = '';
  modelCacheAt = 0;
}

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

/**
 * A `@opencode/client` bound to the running instance and scoped to
 * `directory`, or `null` when OpenCode is not reachable yet.
 *
 * Built per call on purpose: `OpenCode.make` only closes over a base URL and
 * headers, and both change when OpenCode restarts.
 */
const SESSION_ID = /^[\w-]{1,128}$/;
const ACCOUNT = /^[a-z][\w-]*:[\w-]{1,128}$/;
const SCOPE_REFUSALS = { NotFoundError: 404, InvalidRequestError: 400 };

/**
 * A text drawn from a session runs on that session's engine account; one for
 * a draft that picked an account names it as `engine:accountId`. An id that
 * is not one is refused rather than dropped, so the text never falls back to
 * the host default account.
 */
export function getSmallModelClient(directory, { sessionID, account } = {}) {
  if (sessionID != null && !SESSION_ID.test(sessionID)) throw Object.assign(new Error('sessionID is not a session id'), { statusCode: 400 });
  if (account != null && !ACCOUNT.test(account)) throw Object.assign(new Error('account must be engine:accountId'), { statusCode: 400 });
  if (!connection) return null;
  let baseUrl;
  try {
    baseUrl = stripTrailingSlash(connection.buildOpenCodeUrl('', ''));
  } catch {
    // The port is not known yet — OpenCode has not finished starting.
    return null;
  }
  const headers = { ...connection.getOpenCodeAuthHeaders() };
  // Model and provider lists are read through a location; without a directory
  // OpenCode would start its own working directory, MCP servers included.
  const requested = typeof directory === 'string' ? directory.trim() : '';
  const scope = requested || connection.getDefaultDirectory?.() || null;
  if (scope) {
    headers['x-opencode-directory'] = encodeURIComponent(scope);
  }
  if (sessionID != null) headers['x-openchamber-session-id'] = sessionID;
  if (account != null) headers['x-openchamber-account'] = account;
  return OpenCode.make({ baseUrl, headers });
}

const MODEL_CACHE_TTL_MS = 30_000;
let modelCache = null;
let modelCacheKey = '';
let modelCacheAt = 0;

const unwrap = (payload) => (Array.isArray(payload?.data) ? payload.data : []);

/**
 * Every model the running OpenCode knows about for `directory`.
 *
 * Cached briefly: a generation needs the model's context and output limits,
 * and paying a round trip for them on every title or summary would be the
 * wrong trade. An empty array means "asked and got nothing", so callers fall
 * back to conservative defaults rather than refusing.
 *
 * An empty answer is not cached: OpenCode 2 answers with an empty catalog
 * while it is still starting, and keeping that would hide every provider from
 * the pickers until the cache expired.
 */
export async function listModelInfos(client, directory, catalogScope) {
  const key = `${typeof directory === 'string' ? directory : ''}\n${catalogScope ?? ''}`;
  if (modelCache && modelCacheKey === key && Date.now() - modelCacheAt < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }
  try {
    const models = unwrap(await client.model.list());
    if (models.length === 0) return models;
    modelCache = models;
    modelCacheKey = key;
    modelCacheAt = Date.now();
    return models;
  } catch (error) {
    // A read for a session or account the server refused is that refusal:
    // treating it as "nothing listed" would hide why no text was written.
    if (catalogScope && SCOPE_REFUSALS[error?._tag]) throw Object.assign(new Error(error.message), { statusCode: SCOPE_REFUSALS[error._tag] });
    // Keep the previous answer for this directory when there is one: a
    // momentarily unreachable OpenCode must not retract model limits.
    return modelCacheKey === key && modelCache ? modelCache : [];
  }
}

export async function listProviderInfos(client) {
  try {
    return unwrap(await client.provider.list());
  } catch {
    return [];
  }
}

/**
 * The model OpenCode would pick on its own, or `null` when it cannot say.
 */
export async function getDefaultModelInfo(client) {
  try {
    const payload = await client.model.default();
    const info = payload?.data ?? payload;
    return info && typeof info === 'object' && typeof info.id === 'string' ? info : null;
  } catch {
    return null;
  }
}

/**
 * The model and thinking variant the user configured for OpenCode's hidden
 * `title` agent, or `null` when there is none. OpenCode 2 merges
 * `agents.title.model` and the v1 `small_model` (migrated onto that agent)
 * across every config layer, and its own session titles run on this model
 * before any family scan.
 */
export async function getConfiguredSmallModelRef(client) {
  try {
    const { model } = (await client.agent.get({ agentID: 'title' })).data;
    if (!model) return null;
    const ref = { providerID: model.providerID, modelID: model.id };
    const variant = asNonEmptyString(model.variant);
    if (variant) ref.variant = variant;
    return ref;
  } catch {
    // No `title` agent (removed in config, or a cold location still loading
    // its agents) or OpenCode unreachable: nothing configured to honor.
    return null;
  }
}

/**
 * The model entry for a `provider/model` reference. `id` is the catalog key a
 * reference holds; `modelID` is the provider API name, shared by derived
 * entries (`gpt-6-luna` and `gpt-6-luna-fast`), so an exact `id` match wins.
 */
export function findModelInfo(models, providerID, modelID) {
  const ofProvider = models.filter((model) => model?.providerID === providerID);
  return ofProvider.find((model) => model.id === modelID)
    ?? ofProvider.find((model) => model.modelID === modelID)
    ?? null;
}
