// APNs (Apple Push Notification service) runtime for the native iOS mobile app.
//
// Device tokens are persisted per UI session (mirrors push-runtime.js). Delivery has two
// modes, chosen at send time:
//   - Direct (when an APNs key is configured): sign an ES256 JWT with Node crypto and send
//     over HTTP/2 ourselves. The key comes from OPENCHAMBER_APNS_*, the config dir's apns/
//     folder (AuthKey_<KEYID>.p8 + apns.json) or settings.apnsConfig.
//   - Relay (fallback without a key): POST tokens + generic text to the central relay, which
//     holds the upstream app's APNs key. OPENCHAMBER_PUSH_RELAY_DISABLED=true turns it off.
// Wired into the same trigger fanout as web push (see runtime.js); the relay carries only
// generic, model-based text (no session content) — see APNS.md.

import { sessionKeyFor, withHashedSessionKeys } from './session-key.js';
import { parsePushKey, sealPushContent } from './push-seal.js';
import {
  getOrCreateRelaySigningKeypair,
  signRelayMessage as signRelayMessageShared,
} from '../relay/signing-key.js';

const APNS_TOKENS_VERSION = 1;
const APNS_HOST_PRODUCTION = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
// APNs rejects auth tokens older than 1h; refresh well inside that window.
const JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_BUNDLE_ID = 'com.agft.openchamber';
const KEY_FILE_PATTERN = /^AuthKey_([A-Z0-9]+)\.p8$/;
const OTHER_USERS_ACCESS = 0o077;
const DEFAULT_RELAY_URL = 'https://api.openchamber.dev/v1/push/send';
const MAX_TOKENS_PER_SESSION = 10;
// APNs reasons that mean the token is permanently invalid → drop it.
const DEAD_TOKEN_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);
const MAX_CLIENT_CONNECTION_ID_LENGTH = 128;

const parseClientConnectionId = (value) => {
  if (typeof value !== 'string') return undefined;
  const id = value.trim();
  return id.length > 0 && id.length <= MAX_CLIENT_CONNECTION_ID_LENGTH ? id : undefined;
};

const trimmedEnv = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

// Env vars commonly store the .p8 with literal "\n" sequences; restore real newlines.
const normalizePem = (value) => (typeof value === 'string' ? value.replace(/\\n/g, '\n').trim() : '');

export const createApnsRuntime = (deps) => {
  const {
    fsPromises,
    path,
    crypto,
    http2,
    APNS_TOKENS_FILE_PATH,
    APNS_KEY_DIR,
    readSettingsFromDiskMigrated,
    // Host relay identity keys, shared with the private relay (relay/key-store.js).
    relayKeyStore,
  } = deps;

  let persistLock = Promise.resolve();
  let legacyKeysScrubQueued = false;
  let cachedJwt = null; // { token, issuedAtMs, keyId }
  let cachedRelayKey = null; // { generation, keypair: { privateKey, publicJwk } }
  let warnedUnconfigured = false;
  const warnedOpenKeyFiles = new Set();

  // ---------------------------------------------------------------------------
  // Per-server relay signing identity (ECDSA P-256). Auto-generated + persisted by
  // relay/key-store.js. The relay derives serverId = SHA-256(publicKey), verifies
  // each request's signature, and only delivers to tokens this server registered — so a leaked
  // device token alone can't be used to push. Zero-config: the keypair generates on first use.
  // ---------------------------------------------------------------------------

  // Key access lives in lib/relay/signing-key.js now (shared with the private
  // relay identity — same keypair, same storage, same serverId derivation).
  // Keyed by the store generation: resetting the relay identity mints a new key.
  const getOrCreateRelayKeypair = async () => {
    const generation = relayKeyStore.generation();
    if (cachedRelayKey?.generation === generation) return cachedRelayKey.keypair;
    const keypair = await getOrCreateRelaySigningKeypair({ crypto, relayKeyStore });
    cachedRelayKey = { generation, keypair };
    return keypair;
  };

  const signRelayMessage = (privateKey, message) => signRelayMessageShared({ crypto }, privateKey, message);

  // Trim to the 4 fields the relay's schema accepts (and that feed the serverId hash).
  const relayPublicJwk = (publicJwk) => ({
    kty: publicJwk.kty,
    crv: publicJwk.crv,
    x: publicJwk.x,
    y: publicJwk.y,
  });

  const registerTokenWithRelay = async (token, platform = 'ios') => {
    const delivery = await resolveDelivery();
    if (delivery?.kind !== 'relay') return;
    const { relay } = delivery;
    try {
      const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
      const ts = Date.now();
      // platform is part of the signed message so it can't be tampered en route.
      const sig = signRelayMessage(privateKey, `${ts}.${token}.${platform}`);
      const res = await fetch(relay.registerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, platform, publicKeyJwk: relayPublicJwk(publicJwk), ts, sig }),
      });
      if (!res.ok) console.warn(`[Push relay] register-token failed status=${res.status}`);
    } catch (error) {
      console.warn('[Push relay] register-token request failed:', error?.message ?? error);
    }
  };

  // ---------------------------------------------------------------------------
  // Token persistence (same shape + write-lock pattern as push-runtime.js)
  // ---------------------------------------------------------------------------

  const emptyStore = () => ({ version: APNS_TOKENS_VERSION, tokensBySession: {} });

  const readTokensFromDisk = async () => {
    try {
      const raw = await fsPromises.readFile(APNS_TOKENS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== APNS_TOKENS_VERSION) {
        return emptyStore();
      }
      const stored =
        parsed.tokensBySession && typeof parsed.tokensBySession === 'object' ? parsed.tokensBySession : {};
      const { bySession: tokensBySession, changed } = withHashedSessionKeys(stored);
      if (changed && !legacyKeysScrubQueued) {
        // Rewrite once so raw session tokens leave the disk now, not at the
        // next registration.
        legacyKeysScrubQueued = true;
        void persistTokenUpdate((current) => current).catch((error) => {
          console.warn('Failed to rewrite APNs tokens with hashed session keys:', error);
        });
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    } catch (error) {
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return emptyStore();
      }
      console.warn('Failed to read APNs tokens file:', error);
      return emptyStore();
    }
  };

  const writeTokensToDisk = async (data) => {
    await fsPromises.mkdir(path.dirname(APNS_TOKENS_FILE_PATH), { recursive: true });
    await fsPromises.writeFile(APNS_TOKENS_FILE_PATH, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  const persistTokenUpdate = async (mutate) => {
    const result = persistLock.then(async () => {
      const current = await readTokensFromDisk();
      const next = mutate({ version: APNS_TOKENS_VERSION, tokensBySession: current.tokensBySession || {} });
      await writeTokensToDisk(next);
      return next;
    });
    // Only this caller sees a failed write; the next registration still writes.
    persistLock = result.catch(() => {});
    return result;
  };

  const normalizeTokens = (record) => {
    if (!Array.isArray(record)) return [];
    return record
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;
        const deviceToken = entry.deviceToken;
        if (typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return null;
        return {
          deviceToken: deviceToken.trim(),
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : null,
          lastSeenAt: typeof entry.lastSeenAt === 'number' ? entry.lastSeenAt : null,
          userAgent: typeof entry.userAgent === 'string' ? entry.userAgent : undefined,
          // 'ios' (APNs) or 'android' (FCM). Older entries without one are APNs by default.
          platform: entry.platform === 'android' ? 'android' : 'ios',
          // APNs delivery environment for this token. Xcode/dev-signed installs produce
          // sandbox tokens, TestFlight/App Store produce production ones; the client reports
          // which at registration. Older entries without one default to production (matches
          // released builds).
          environment: entry.environment === 'sandbox' ? 'sandbox' : 'production',
          // The device's key for end-to-end sealed text (push-seal.js); absent for
          // apps from before it, which keep getting plain text.
          pushKey: parsePushKey(entry.pushKey) ?? undefined,
          clientConnectionId: parseClientConnectionId(entry.clientConnectionId),
        };
      })
      .filter(Boolean);
  };

  // Normalize an incoming platform hint to the two we support; default to APNs/iOS since that
  // was the only registrant before Android/FCM existed.
  const normalizePlatform = (platform) => (platform === 'android' ? 'android' : 'ios');

  const normalizeEnvironment = (environment) => (environment === 'sandbox' ? 'sandbox' : 'production');

  const addOrUpdateApnsToken = async (uiSessionToken, deviceToken, userAgent, platform, environment, pushKey, clientConnectionId) => {
    if (!uiSessionToken || typeof deviceToken !== 'string' || deviceToken.trim().length === 0) return;
    const token = deviceToken.trim();
    const sessionKey = sessionKeyFor(uiSessionToken);
    const tokenPlatform = normalizePlatform(platform);
    const tokenEnvironment = normalizeEnvironment(environment);
    const now = Date.now();

    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const existing = normalizeTokens(tokensBySession[sessionKey]);
      const filtered = existing.filter((entry) => entry.deviceToken !== token);
      filtered.unshift({
        deviceToken: token,
        createdAt: now,
        lastSeenAt: now,
        userAgent: typeof userAgent === 'string' && userAgent.length > 0 ? userAgent : undefined,
        platform: tokenPlatform,
        environment: tokenEnvironment,
        pushKey: parsePushKey(pushKey) ?? undefined,
        clientConnectionId: parseClientConnectionId(clientConnectionId),
      });
      tokensBySession[sessionKey] = filtered.slice(0, MAX_TOKENS_PER_SESSION);
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });

    // (Re)bind this token to our server on the relay so only we can push to it. The device
    // re-sends its token on each launch; this is an idempotent upsert relay-side, and binding
    // every time (not just for new tokens) keeps existing tokens bound after a relay/server
    // upgrade rather than silently going unbound. Platform is bound too so the relay routes
    // it to APNs vs FCM.
    await registerTokenWithRelay(token, tokenPlatform);
  };

  const removeApnsToken = async (uiSessionToken, deviceToken) => {
    if (!uiSessionToken || !deviceToken) return;
    const sessionKey = sessionKeyFor(uiSessionToken);
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      const filtered = normalizeTokens(tokensBySession[sessionKey]).filter(
        (entry) => entry.deviceToken !== deviceToken,
      );
      if (filtered.length === 0) delete tokensBySession[sessionKey];
      else tokensBySession[sessionKey] = filtered;
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  const removeApnsTokenFromAllSessions = async (deviceToken) => {
    if (!deviceToken) return;
    await persistTokenUpdate((current) => {
      const tokensBySession = { ...(current.tokensBySession || {}) };
      for (const [session, entries] of Object.entries(tokensBySession)) {
        const filtered = normalizeTokens(entries).filter((entry) => entry.deviceToken !== deviceToken);
        if (filtered.length === 0) delete tokensBySession[session];
        else tokensBySession[session] = filtered;
      }
      return { version: APNS_TOKENS_VERSION, tokensBySession };
    });
  };

  // ---------------------------------------------------------------------------
  // Config (env first, then the apns/ key dir, then settings.apnsConfig)
  // ---------------------------------------------------------------------------

  const readJsonFile = async (filePath) => {
    try {
      const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const warnIfOthersCanRead = async (filePath) => {
    if (warnedOpenKeyFiles.has(filePath)) return;
    const stats = await fsPromises.stat(filePath).catch(() => null);
    if (!stats || (stats.mode & OTHER_USERS_ACCESS) === 0) return;
    warnedOpenKeyFiles.add(filePath);
    console.warn(`[APNs] ${filePath} is readable by other users; run chmod 600 on it.`);
  };

  const findKeyFile = async (keyId) => {
    const names = await fsPromises.readdir(APNS_KEY_DIR).catch(() => null);
    if (!names) return null;
    const keyFiles = names
      .map((name) => ({ name, keyId: KEY_FILE_PATTERN.exec(name)?.[1] }))
      .filter((entry) => entry.keyId);
    const match = keyId ? keyFiles.find((entry) => entry.keyId === keyId) : keyFiles.length === 1 ? keyFiles[0] : null;
    return match ? { keyId: match.keyId, filePath: path.join(APNS_KEY_DIR, match.name) } : null;
  };

  const readKeyDirConfig = async () => {
    if (!APNS_KEY_DIR) return null;
    const stored = (await readJsonFile(path.join(APNS_KEY_DIR, 'apns.json'))) ?? {};
    const keyId = typeof stored.keyId === 'string' ? stored.keyId.trim() : null;
    const keyFile = await findKeyFile(keyId);
    if (!keyFile) return stored;
    await warnIfOthersCanRead(keyFile.filePath);
    try {
      const p8 = (await fsPromises.readFile(keyFile.filePath, 'utf8')).trim();
      return { ...stored, keyId: keyFile.keyId, p8 };
    } catch (error) {
      console.warn(`[APNs] Failed to read ${keyFile.filePath}:`, error?.code ?? 'unknown error');
      return stored;
    }
  };

  const readSettingsConfig = async () => {
    try {
      const settings = await readSettingsFromDiskMigrated();
      return settings?.apnsConfig && typeof settings.apnsConfig === 'object' ? settings.apnsConfig : null;
    } catch {
      return null;
    }
  };

  const trimmedField = (source, name) => (typeof source?.[name] === 'string' && source[name].trim().length > 0 ? source[name].trim() : null);

  const resolveApnsConfig = async () => {
    let keyId = trimmedEnv('OPENCHAMBER_APNS_KEY_ID');
    let teamId = trimmedEnv('OPENCHAMBER_APNS_TEAM_ID');
    let bundleId = trimmedEnv('OPENCHAMBER_APNS_BUNDLE_ID');
    let environment = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    let p8 = normalizePem(process.env.OPENCHAMBER_APNS_P8 || '');

    const p8Path = trimmedEnv('OPENCHAMBER_APNS_P8_PATH');
    if (!p8 && p8Path) {
      await warnIfOthersCanRead(p8Path);
      try {
        p8 = (await fsPromises.readFile(p8Path, 'utf8')).trim();
      } catch (error) {
        console.warn('[APNs] Failed to read OPENCHAMBER_APNS_P8_PATH:', error?.code ?? 'unknown error');
      }
    }

    for (const readSource of [readKeyDirConfig, readSettingsConfig]) {
      if (keyId && teamId && p8) break;
      const stored = await readSource();
      if (!stored) continue;
      keyId = keyId || trimmedField(stored, 'keyId');
      teamId = teamId || trimmedField(stored, 'teamId');
      bundleId = bundleId || trimmedField(stored, 'bundleId');
      environment = environment || (trimmedField(stored, 'environment') || '').toLowerCase();
      if (!p8 && typeof stored.p8 === 'string') p8 = normalizePem(stored.p8);
    }

    if (!keyId || !teamId || !p8) return null;

    return {
      keyId,
      teamId,
      p8,
      bundleId: bundleId || DEFAULT_BUNDLE_ID,
      // Explicit env/settings value forces every send to that environment; when unset (null),
      // each token is delivered to the environment it registered with.
      environment: environment === 'sandbox' ? 'sandbox' : environment === 'production' ? 'production' : null,
    };
  };

  // ---------------------------------------------------------------------------
  // JWT (ES256, JOSE/raw signature) + HTTP/2 send
  // ---------------------------------------------------------------------------

  const signApnsJwt = (config) => {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: config.keyId })).toString('base64url');
    const claims = Buffer.from(
      JSON.stringify({ iss: config.teamId, iat: Math.floor(Date.now() / 1000) }),
    ).toString('base64url');
    const signingInput = `${header}.${claims}`;
    const signature = crypto
      .sign('sha256', Buffer.from(signingInput), { key: config.p8, dsaEncoding: 'ieee-p1363' })
      .toString('base64url');
    return `${signingInput}.${signature}`;
  };

  const getJwt = (config) => {
    const now = Date.now();
    if (cachedJwt && cachedJwt.keyId === config.keyId && now - cachedJwt.issuedAtMs < JWT_TTL_MS) {
      return cachedJwt.token;
    }
    const token = signApnsJwt(config);
    cachedJwt = { token, issuedAtMs: now, keyId: config.keyId };
    return token;
  };

  const buildBody = (payload) => {
    const data = payload && typeof payload.data === 'object' && payload.data ? payload.data : {};
    return JSON.stringify({
      aps: {
        alert: {
          title: typeof payload?.title === 'string' ? payload.title : undefined,
          body: typeof payload?.body === 'string' ? payload.body : undefined,
        },
        badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
        sound: 'default',
        'thread-id': typeof payload?.tag === 'string' ? payload.tag : undefined,
        // Wakes the Notification Service Extension so it can refresh the home/lock-screen
        // widgets (attention count + unread dot) from the push, even when the app is closed.
        // No extra network call — just an extra key on the push we already send.
        'mutable-content': 1,
      },
      ...data,
    });
  };

  const sendOne = (client, deviceToken, body, jwt, config) =>
    new Promise((resolve) => {
      const headers = {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': config.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      };
      // collapse-id dedups like web-push tags; APNs caps it at 64 bytes.
      const collapseId = typeof config.tag === 'string' ? config.tag.slice(0, 64) : undefined;
      if (collapseId) headers['apns-collapse-id'] = collapseId;

      let req;
      try {
        req = client.request(headers);
      } catch (error) {
        console.warn('[APNs] request open failed:', error?.message ?? error);
        resolve();
        return;
      }

      let status = 0;
      let responseBody = '';
      req.on('response', (resHeaders) => {
        status = Number(resHeaders[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', async () => {
        if (status === 200) {
          resolve();
          return;
        }
        let reason = '';
        try {
          reason = JSON.parse(responseBody)?.reason || '';
        } catch {
          // non-JSON error body
        }
        if (status === 410 || DEAD_TOKEN_REASONS.has(reason)) {
          await removeApnsTokenFromAllSessions(deviceToken);
        } else {
          console.warn(`[APNs] push failed status=${status} reason=${reason || 'unknown'}`);
        }
        resolve();
      });
      req.on('error', (error) => {
        console.warn('[APNs] request error:', error?.message ?? error);
        resolve();
      });
      req.end(body);
    });

  // Relay mode (fallback without a key): the upstream app's APNs key lives in the central
  // relay, not on each user's server. The server just POSTs device tokens + generic text; the
  // relay signs + sends and reports which tokens to drop. It can only reach the upstream
  // bundle, so a configured key always wins (direct mode below).
  const resolveDelivery = async () => {
    const config = await resolveApnsConfig();
    if (config) return { kind: 'direct', config };
    const relay = resolveRelayConfig();
    if (relay) return { kind: 'relay', relay };
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        `[APNs] Relay disabled and no APNs key; put AuthKey_<KEYID>.p8 and apns.json in ${APNS_KEY_DIR || 'the OpenChamber config apns/ directory'} or set OPENCHAMBER_APNS_KEY_ID / OPENCHAMBER_APNS_TEAM_ID / OPENCHAMBER_APNS_P8.`,
      );
    }
    return null;
  };

  const resolveRelayConfig = () => {
    if (trimmedEnv('OPENCHAMBER_PUSH_RELAY_DISABLED') === 'true') return null;
    const url = trimmedEnv('OPENCHAMBER_PUSH_RELAY_URL') || DEFAULT_RELAY_URL;
    const override = (trimmedEnv('OPENCHAMBER_APNS_ENVIRONMENT') || '').toLowerCase();
    return {
      url,
      registerUrl: url.replace(/\/send$/, '/register-token'),
      // Explicit OPENCHAMBER_APNS_ENVIRONMENT forces every send to that environment; when
      // unset (null), each token is delivered to the environment it registered with.
      environment: override === 'sandbox' ? 'sandbox' : override === 'production' ? 'production' : null,
    };
  };

  const sendViaRelay = async (deviceTokens, payload, relay, environment) => {
    const tokens = deviceTokens.slice(0, 100);
    const title = typeof payload?.title === 'string' && payload.title.length > 0 ? payload.title : 'OpenChamber';
    const { privateKey, publicJwk } = await getOrCreateRelayKeypair();
    const ts = Date.now();
    // Sign over the same canonical form the relay verifies: ts.sortedTokens.title.
    const sig = signRelayMessage(privateKey, `${ts}.${[...tokens].sort().join(',')}.${title}`);
    const requestBody = JSON.stringify({
      tokens,
      title,
      body: typeof payload?.body === 'string' ? payload.body : '',
      badge: Number.isFinite(payload?.badge) && payload.badge >= 0 ? Math.trunc(payload.badge) : undefined,
      collapseId: typeof payload?.tag === 'string' ? payload.tag.slice(0, 64) : undefined,
      env: environment,
      data: payload?.data && typeof payload.data === 'object' ? payload.data : undefined,
      publicKeyJwk: relayPublicJwk(publicJwk),
      ts,
      sig,
    });
    try {
      const res = await fetch(relay.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      if (!res.ok) {
        console.warn(`[APNs relay] send failed status=${res.status}`);
        return;
      }
      const data = await res.json().catch(() => null);
      const results = Array.isArray(data?.results) ? data.results : [];
      for (const result of results) {
        if (result && result.drop === true && typeof result.token === 'string') {
          await removeApnsTokenFromAllSessions(result.token);
        }
      }
    } catch (error) {
      console.warn('[APNs relay] request failed:', error?.message ?? error);
    }
  };

  const sendViaDirectApns = async (tokenGroups, payload, config) => {
    const jwt = getJwt(config);
    const body = buildBody(payload);
    const sendConfig = { ...config, tag: typeof payload?.tag === 'string' ? payload.tag : undefined };

    // One HTTP/2 session per APNs environment; a sandbox token sent to the production host
    // (or vice versa) gets BadDeviceToken and would be wrongly dropped as dead.
    for (const [environment, deviceTokens] of tokenGroups) {
      const effectiveEnvironment = config.environment ?? environment;
      const host = effectiveEnvironment === 'sandbox' ? APNS_HOST_SANDBOX : APNS_HOST_PRODUCTION;

      let client;
      try {
        client = http2.connect(host);
      } catch (error) {
        console.warn('[APNs] connect failed:', error?.message ?? error);
        continue;
      }

      await new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          try {
            client.close();
          } catch {
            // ignore close errors
          }
          resolve();
        };
        client.on('error', (error) => {
          console.warn('[APNs] session error:', error?.message ?? error);
          finish();
        });
        Promise.all(
          deviceTokens.map((token) => sendOne(client, token, body, jwt, sendConfig)),
        ).finally(finish);
      });
    }
  };

  // NOT gated on UI visibility (unlike web push). A backgrounded WKWebView can't reliably
  // report "hidden" before iOS suspends it, so a visibility gate wrongly suppressed
  // background push for short responses. Instead we always send, and rely on iOS to NOT
  // display the alert while the app is foreground (presentationOptions: [] in
  // capacitor.config) — so there is no notification when the app is active, with no race.
  // `sealed` is the `{ title, body }` a phone with a key shows; without it the
  // phone opens the same text an app without a key gets in the clear.
  const sendApnsToAllUiSessions = async ({ sealed, ...payload } = {}, _options = {}) => {
    const sealedContent = sealed ?? { title: payload.title, body: payload.body };
    const store = await readTokensFromDisk();
    // Tokens are grouped by their registered APNs environment so each batch goes to the
    // endpoint that actually knows the token (Xcode builds → sandbox, TestFlight/App Store
    // → production). Mixing them gets BadDeviceToken and the token wrongly dropped as dead.
    const tokensByEnvironment = new Map();
    // Devices that gave a push key get their text sealed for them alone, and
    // devices that named their connection to this server get that name back,
    // so each is its own send; the rest share one batch per environment.
    const ownPayloadDevices = [];
    const seen = new Set();
    for (const record of Object.values(store.tokensBySession || {})) {
      for (const entry of normalizeTokens(record)) {
        if (seen.has(entry.deviceToken)) continue;
        seen.add(entry.deviceToken);
        if (entry.pushKey || entry.clientConnectionId) {
          ownPayloadDevices.push(entry);
          continue;
        }
        const group = tokensByEnvironment.get(entry.environment) || [];
        group.push(entry.deviceToken);
        tokensByEnvironment.set(entry.environment, group);
      }
    }
    if (seen.size === 0) return;

    const delivery = await resolveDelivery();
    if (!delivery) return;
    if (delivery.kind === 'relay') {
      const { relay } = delivery;
      for (const [environment, deviceTokens] of tokensByEnvironment) {
        await sendViaRelay(deviceTokens, payload, relay, relay.environment ?? environment);
      }
      for (const entry of ownPayloadDevices) {
        await sendViaRelay([entry.deviceToken], devicePayloadFor(payload, sealedContent, entry), relay, relay.environment ?? entry.environment);
      }
      return;
    }
    await sendViaDirectApns(tokensByEnvironment, payload, delivery.config);
    for (const entry of ownPayloadDevices) {
      await sendViaDirectApns(new Map([[entry.environment, [entry.deviceToken]]]), devicePayloadFor(payload, sealedContent, entry), delivery.config);
    }
  };

  // What the relay and the push service see for a device with a key: the
  // generic scenario title and an empty body, with the real title and body
  // sealed in `data.enc` for the phone to open.
  const sealedPayloadFor = (payload, content, pushKey) => ({
    ...payload,
    body: '',
    data: {
      ...(payload?.data && typeof payload.data === 'object' ? payload.data : {}),
      enc: sealPushContent(pushKey, { title: content.title, body: content.body }),
    },
  });

  const devicePayloadFor = (payload, content, entry) => {
    const devicePayload = entry.pushKey ? sealedPayloadFor(payload, content, entry.pushKey) : payload;
    if (!entry.clientConnectionId) return devicePayload;
    return {
      ...devicePayload,
      data: {
        ...(devicePayload?.data && typeof devicePayload.data === 'object' ? devicePayload.data : {}),
        cid: entry.clientConnectionId,
      },
    };
  };

  return {
    addOrUpdateApnsToken,
    removeApnsToken,
    removeApnsTokenFromAllSessions,
    sendApnsToAllUiSessions,
    resolveApnsConfig,
    // exposed for tests
    signApnsJwt,
  };
};
