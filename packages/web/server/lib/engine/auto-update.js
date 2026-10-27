// Updates an engine's CLI by itself when its "auto update" switch is on.
// The installer's own update plan runs, so each engine uses its official
// command on every platform. A check is due once its interval has passed
// since the last one, and an update only starts while no session of that
// engine has a turn open.

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 30 * 1000;
const NUDGE_DELAY_MS = 5 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_UPDATE_INTERVALS = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS };

export const DEFAULT_AUTO_UPDATE_INTERVAL = 'daily';

/** The stored `{ enabled, interval, lastCheckAt }` of an engine, with defaults for what is missing. */
export const readAutoUpdateEntry = (stored, engineId) => {
  const entry = stored?.[engineId];
  return {
    enabled: entry?.enabled === true,
    interval: entry?.interval in AUTO_UPDATE_INTERVALS ? entry.interval : DEFAULT_AUTO_UPDATE_INTERVAL,
    lastCheckAt: Number.isFinite(entry?.lastCheckAt) ? entry.lastCheckAt : null,
  };
};

export const nextCheckAt = (entry, now) => {
  if (!entry.enabled) return null;
  return entry.lastCheckAt === null ? now : entry.lastCheckAt + AUTO_UPDATE_INTERVALS[entry.interval];
};

/**
 * `store.read()` resolves the stored `{ [engineId]: entry }` map and
 * `store.save(map)` replaces it. `isEngineBusy(engineId)` tells whether a
 * session of that engine has a turn open. `describe(engineId)` reports the
 * last automatic update attempt of this server run.
 */
export const createEngineAutoUpdater = ({ registry, store, isEngineBusy, now = Date.now, logger = console }) => {
  const lastRuns = new Map();
  let timer = null;
  let checking = null;

  const recordCheck = async (engineId) => {
    const stored = (await store.read()) ?? {};
    await store.save({ ...stored, [engineId]: { ...readAutoUpdateEntry(stored, engineId), lastCheckAt: now() } });
  };

  const updateEngine = async (adapter, status) => {
    const run = { at: now(), from: status.version, to: status.latestVersion, ok: false, error: null };
    try {
      const result = await adapter.installer.runAction('update');
      lastRuns.set(adapter.id, { ...run, ok: true, to: result?.version ?? run.to });
      logger.info(`[engine:${adapter.id}] Auto update installed ${result?.version ?? run.to}.`);
    } catch (error) {
      if (error?.code === 'busy') return false;
      lastRuns.set(adapter.id, { ...run, error: error.message });
      logger.error(`[engine:${adapter.id}] Auto update failed: ${error.message}`);
    }
    return true;
  };

  // A check that could not read the latest version, or found an update it may not install yet, is not recorded, so the next poll repeats it.
  const checkEngine = async (adapter, entry) => {
    if (!entry.enabled || nextCheckAt(entry, now()) > now()) return;
    const { installer } = adapter;
    if (!installer.latestVersion || await installer.latestVersion.fresh() === null) return;
    const status = await installer.getStatus(true);
    if (status.installed && status.updateAvailable && status.actions.update) {
      if (isEngineBusy(adapter.id) || status.state === 'installing') return;
      if (!(await updateEngine(adapter, status))) return;
    }
    await recordCheck(adapter.id);
  };

  const runChecks = async () => {
    const stored = (await store.read()) ?? {};
    for (const adapter of registry.list()) {
      try {
        await checkEngine(adapter, readAutoUpdateEntry(stored, adapter.id));
      } catch (error) {
        logger.error(`[engine:${adapter.id}] Auto update check failed: ${error.message}`);
      }
    }
  };

  const tick = () => {
    checking ??= runChecks().finally(() => { checking = null; });
    return checking;
  };

  const schedule = (delayMs) => {
    const handle = setTimeout(() => { void tick(); }, delayMs);
    handle.unref?.();
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
      timer.unref?.();
      schedule(FIRST_CHECK_DELAY_MS);
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    tick,
    nudge: () => schedule(NUDGE_DELAY_MS),
    describe: (engineId) => lastRuns.get(engineId) ?? null,
  };
};
