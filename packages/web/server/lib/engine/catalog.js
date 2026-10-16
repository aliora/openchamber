// The provider and model catalog the shared UI reads through @opencode/client:
// OpenCode 2.x `ModelInfo` and `ProviderInfo` records built from the engine
// adapters. DOCUMENTATION.md in this folder, *Catalog*, says where each field
// comes from.

// The token limits of a model whose CLI states none, below those of every
// model the engines list, so the UI's context meter never shows more room than
// the model has. The UI prints a 0 as a size, so an unknown size cannot be 0.
const CONSERVATIVE_LIMIT = { context: 200_000, output: 32_000 };

/** One model of an engine as OpenCode 2.x `ModelInfo`. */
const toModelInfo = (adapter, model) => ({
  id: model.id,
  modelID: model.id,
  providerID: adapter.providerID,
  family: model.family,
  name: model.name,
  // Every engine calls tools. A prompt reaches the CLI as text only
  // (`sendUserMessage(text)`), so no model takes an attachment through
  // OpenChamber, whatever the CLI itself accepts.
  capabilities: { tools: true, input: ['text'], output: ['text'] },
  // The UI's reasoning picker lists the variants and sends the picked one,
  // which the session model route stores as the effort.
  variants: (model.efforts ?? adapter.efforts ?? []).map((id) => ({ id })),
  time: { released: 0 },
  // The CLI bills its own account; OpenChamber knows no price, and a zero
  // price would show the model as free.
  cost: [],
  status: 'active',
  enabled: true,
  limit: { ...CONSERVATIVE_LIMIT, ...adapter.limit },
});

export const listModelInfos = (registry) => registry.list()
  .flatMap((adapter) => adapter.models.map((model) => toModelInfo(adapter, model)));

export const defaultModelInfo = (registry) => {
  const adapter = registry.getDefault();
  const model = adapter.models.find((candidate) => candidate.id === adapter.defaultModel);
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

const ENGINE_AVAILABILITY_TTL_MS = 30_000;

/**
 * Whether each engine's CLI is installed and signed in, without making a
 * catalog read wait for the CLI. A read answers the last known state and,
 * when that is missing or older than the TTL, starts a check after the
 * response went out: `installer.getStatus()` can spawn the CLI synchronously
 * and `auth.status()` runs it. An engine never checked, or whose check
 * failed, reads as not ready.
 */
export const createEngineAvailability = ({ ttlMs = ENGINE_AVAILABILITY_TTL_MS, now = Date.now } = {}) => {
  const entries = new Map();

  const check = async (adapter) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (!adapter.installer.getStatus().installed) return false;
    const auth = await adapter.auth.status();
    return auth?.loggedIn === true;
  };

  const refresh = (adapter, previous) => {
    const entry = { ready: previous?.ready ?? false, checkedAt: previous?.checkedAt ?? 0, checking: true };
    entries.set(adapter.id, entry);
    void check(adapter)
      .catch(() => false)
      .then((ready) => {
        entries.set(adapter.id, { ready, checkedAt: now(), checking: false });
      });
  };

  return {
    isReady: (adapter) => {
      const entry = entries.get(adapter.id);
      if (!entry || (!entry.checking && now() - entry.checkedAt >= ttlMs)) refresh(adapter, entry);
      return entry?.ready ?? false;
    },
  };
};
