import { inheritPermissionMode } from './permission-tiers.js';

// The provider and model catalog the shared UI reads through @opencode/client:
// OpenCode 2.x `ModelInfo` and `ProviderInfo` records built from the engine
// adapters. DOCUMENTATION.md in this folder, *Catalog*, says where each field
// comes from.

// The token limits of a model whose CLI states none, below those of every
// model the engines list, so the UI's context meter never shows more room than
// the model has. An adapter that cannot know its sizes states 0, which the UI
// reads as unknown.
const CONSERVATIVE_LIMIT = { context: 200_000, output: 32_000 };

/**
 * The reasoning efforts a model offers: its own list, else its engine's. An
 * empty list means the model takes no effort. The model picker offers these
 * as variants, and the session routes accept no other.
 */
export const modelEfforts = (adapter, model) => model.efforts ?? adapter.efforts ?? [];

/** The effort a model runs at when none was chosen, or undefined when it offers none. */
export const defaultModelEffort = (adapter, model) => (
  modelEfforts(adapter, model).includes(adapter.defaultEffort) ? adapter.defaultEffort : undefined
);

/** One model of an engine as OpenCode 2.x `ModelInfo`. */
const toModelInfo = (adapter, model) => ({
  id: model.id,
  modelID: model.id,
  providerID: adapter.providerID,
  family: model.family,
  name: model.name,
  capabilities: { tools: true, input: ['text', 'image', 'pdf', 'video'], output: ['text'] },
  // The UI's reasoning picker lists the variants and sends the picked one,
  // which the session model route stores as the effort.
  variants: modelEfforts(adapter, model).map((id) => ({ id })),
  time: { released: 0 },
  // The CLI bills its own account; OpenChamber knows no price, and a zero
  // price would show the model as free.
  cost: [],
  status: 'active',
  enabled: true,
  limit: { ...CONSERVATIVE_LIMIT, ...adapter.limit, ...adapter.modelLimit?.(model.id) },
});

export const listModelInfos = (registry) => registry.list()
  .flatMap((adapter) => adapter.modelCatalog().models.map((model) => toModelInfo(adapter, model)));

export const defaultModelInfo = (registry) => {
  const adapter = registry.getDefault();
  const { models, defaultModel } = adapter.modelCatalog();
  const model = models.find((candidate) => candidate.id === defaultModel);
  return model ? toModelInfo(adapter, model) : null;
};

/**
 * One engine as OpenCode 2.x `ProviderInfo`. `enabled` marks an engine whose
 * CLI is installed and signed in; any other engine answers `auto`, which the
 * UI lists the same way. `disabled` is the user's off switch in OpenCode and
 * hides the provider, so it is never sent.
 */
export const toProviderInfo = (adapter, ready) => ({
  id: adapter.providerID,
  name: adapter.displayName,
  activation: ready ? 'enabled' : 'auto',
  package: `openchamber/engine/${adapter.id}`,
});

/**
 * One engine for `GET /api/engines/readiness`: whether its CLI can run, and
 * the command the user runs in a terminal when it cannot. The model picker
 * greys out an engine that is `not-installed` or `signed-out` and leaves an
 * `unknown` one as it is. In enterprise mode a signed-out engine comes
 * without its sign-in command: signing in to a model provider through
 * OpenChamber is what the mode closes. The install command stays, because
 * installing a CLI adds no provider, key or endpoint.
 */
export const toEngineReadiness = (adapter, { state, installCommand }, { enterpriseMode }) => {
  let fixCommand = null;
  if (state === 'not-installed') fixCommand = installCommand;
  if (state === 'signed-out' && !enterpriseMode) fixCommand = adapter.auth.loginCommand ?? null;
  return { engine: adapter.id, providerID: adapter.providerID, state, fixCommand };
};

/**
 * What the composer lets the user choose for one engine's sessions
 * (`GET /api/engines/controls`). Each permission mode names the UI message
 * keys of its label and its one-line description, which the UI translates;
 * `dangerous` marks a mode that lets the CLI run every tool without asking,
 * and `appliesLive` a mode a running CLI takes at once. Any other mode
 * reaches the CLI when its next process starts, at the next prompt.
 * `defaultEffort` is the effort a model runs at when none was chosen.
 */
export const toEngineControls = (adapter) => {
  const live = adapter.livePermissionModes ?? [];
  const dangerous = adapter.dangerousPermissionModes ?? [];
  return {
    engine: adapter.id,
    providerID: adapter.providerID,
    defaultPermissionMode: adapter.defaultPermissionMode,
    permissionModes: adapter.permissionModes.map((id) => ({
      id,
      labelKey: `engine.permissionMode.${adapter.id}.${id}.label`,
      descriptionKey: `engine.permissionMode.${adapter.id}.${id}.description`,
      dangerous: dangerous.includes(id),
      tier: adapter.permissionModeTiers[id],
      appliesLive: live.includes(id),
    })),
    defaultEffort: adapter.defaultEffort ?? null,
  };
};

/**
 * The mode a chat runs in after it moves from the `source` engine to the
 * `target` engine: the same mode when the target has it, else the target's
 * mode on the same rung of the permission ladder (the nearest one below when
 * it has none), so full permission stays full. A mode the source does not know
 * takes the target's default.
 */
export const carryPermissionMode = (mode, source, target) => {
  if (target.permissionModes.includes(mode)) return mode;
  if (!source.permissionModeTiers?.[mode]) return target.defaultPermissionMode;
  return inheritPermissionMode(mode, source, target);
};

// A ready engine is checked again after 30 seconds. One that is not ready is
// checked again after 5, so an engine the user just installed or signed in to
// is offered again the next time the picker opens.
const READY_TTL_MS = 30_000;
const NOT_READY_TTL_MS = 5_000;

const UNKNOWN = { state: 'unknown', installCommand: null };

/**
 * Whether each engine's CLI is installed and signed in, without making a read
 * wait for the CLI. `read(adapter)` answers the last known
 * `{ state, installCommand }` and, when that is missing or stale, starts a
 * check after the response went out: `installer.getStatus()` and
 * `auth.status()` run the CLI. `state` is `ready`,
 * `not-installed`, `signed-out`, or `unknown` for an engine not checked yet or
 * whose check threw. `invalidate(adapter)` drops what is known, so the next
 * read checks again and a check still running is not kept.
 */
export const createEngineAvailability = ({
  readyTtlMs = READY_TTL_MS,
  notReadyTtlMs = NOT_READY_TTL_MS,
  now = Date.now,
  onStateChange = () => {},
} = {}) => {
  const entries = new Map();

  const check = async (adapter) => {
    await new Promise((resolve) => setImmediate(resolve));
    const install = await adapter.installer.getStatus();
    const installCommand = install.installCommand ?? null;
    if (!install.installed) return { state: 'not-installed', installCommand };
    const auth = await adapter.auth.status();
    return { state: auth?.loggedIn === true ? 'ready' : 'signed-out', installCommand };
  };

  const isStale = (entry) => now() - entry.checkedAt >= (entry.state === 'ready' ? readyTtlMs : notReadyTtlMs);

  const refresh = (adapter, previous) => {
    const token = {};
    entries.set(adapter.id, { ...(previous ?? UNKNOWN), checkedAt: previous?.checkedAt ?? 0, checking: true, token });
    void check(adapter)
      .catch(() => UNKNOWN)
      .then((result) => {
        if (entries.get(adapter.id)?.token !== token) return;
        entries.set(adapter.id, { ...result, checkedAt: now(), checking: false, token });
        if (previous && previous.state !== UNKNOWN.state && previous.state !== result.state) onStateChange(adapter);
      });
  };

  return {
    read: (adapter) => {
      const entry = entries.get(adapter.id);
      if (!entry || (!entry.checking && isStale(entry))) refresh(adapter, entry);
      return { state: entry?.state ?? UNKNOWN.state, installCommand: entry?.installCommand ?? null };
    },
    invalidate: (adapter) => {
      entries.delete(adapter.id);
    },
  };
};
