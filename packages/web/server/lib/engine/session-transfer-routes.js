import { z } from 'zod';
import { ENTERPRISE_MODE_ERROR } from '../enterprise-mode.js';
import {
  applyGitChanges,
  buildTransferBundle,
  importedMetadata,
  resolveTargetCwd,
  runGit,
  TRANSFER_BUNDLE_VERSION,
  withTransferredTo,
} from './session-transfer.js';

// The three routes of a session transfer (session-transfer.js). The UI calls
// them in order: the bundle from the source host, the import on the target,
// then the mark on the source.

const messageSchema = z.object({ id: z.string().min(1), role: z.string().min(1) }).passthrough();

const bundleSchema = z.object({
  version: z.literal(TRANSFER_BUNDLE_VERSION),
  source: z.object({
    hostname: z.string().nullish(),
    sessionId: z.string().min(1),
    cwd: z.string().nullish(),
    homeRelativeCwd: z.string().nullish(),
  }),
  session: z.object({
    title: z.string().nullish(),
    engine: z.string().nullish(),
    model: z.string().nullish(),
    effort: z.string().nullish(),
    permissionMode: z.string().nullish(),
    metadata: z.record(z.string(), z.json()).nullish(),
  }).passthrough(),
  messages: z.array(messageSchema),
  git: z.object({
    branch: z.string().nullish(),
    head: z.string().nullish(),
    remoteUrl: z.string().nullish(),
    repoSubpath: z.string().nullish(),
    diff: z.string(),
    untracked: z.array(z.object({ path: z.string().min(1), contentBase64: z.string() })),
    skippedUntracked: z.array(z.string()).optional(),
  }).nullish(),
}).passthrough();

const importBodySchema = z.object({
  bundle: bundleSchema,
  cwd: z.string().min(1).optional(),
  model: z.object({ providerID: z.string().min(1), id: z.string().min(1), variant: z.string().optional() }).optional(),
  applyGitChanges: z.boolean().optional(),
  prompt: z.string().max(100_000).optional(),
  sourceHostLabel: z.string().max(200).optional(),
});

const markBodySchema = z.object({
  hostLabel: z.string().min(1).max(200),
  runtimeKey: z.string().max(500).optional(),
  targetSessionId: z.string().min(1).max(200),
  targetDirectory: z.string().max(4096).optional(),
});

const isTruthyQuery = (value) => value === '1' || value === 'true';

export const registerSessionTransferRoutes = (app, {
  store,
  registry,
  runtime,
  loadSession,
  createSession,
  promptSession,
  announceMetadata,
  isEnterpriseMode,
  readSettings,
  fallbackCwd,
  git = runGit,
}) => {
  // The bundle carries the conversation to another machine, which enterprise
  // mode does not allow.
  app.get('/api/sessions/:id/transfer-bundle', async (req, res) => {
    if (isEnterpriseMode()) return res.status(403).json({ error: ENTERPRISE_MODE_ERROR, code: 'enterprise_mode' });
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      if (runtime.isTurnActive(loaded.session.id)) {
        return res.status(409).json({ error: 'The session is still answering; stop it or wait before moving it.' });
      }
      const messages = await store.getMessages(loaded.session.id);
      res.json(await buildTransferBundle({
        session: loaded.session,
        messages,
        includeGitChanges: isTruthyQuery(req.query.includeGitChanges),
        git,
      }));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // The carried settings when this host's engine knows them, else the
  // engine's defaults: a model or mode the target lacks never fails the move.
  const createImportedSession = async (bundle, cwd, model) => {
    const title = bundle.session.title || undefined;
    if (model) return createSession({ title, model }, cwd);
    const engine = bundle.session.engine && registry.get(bundle.session.engine) ? bundle.session.engine : undefined;
    const carried = await createSession({
      title,
      engine,
      model: bundle.session.model || undefined,
      effort: bundle.session.effort || undefined,
      permissionMode: bundle.session.permissionMode || undefined,
    }, cwd);
    return carried.error ? createSession({ title, engine }, cwd) : carried;
  };

  app.post('/api/sessions/import-transfer', async (req, res) => {
    const parsed = importBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: `Invalid transfer: ${parsed.error.issues[0]?.message ?? 'bad body'}` });
    const { bundle, model, prompt } = parsed.data;
    try {
      const settings = await readSettings?.().catch(() => null);
      const { cwd, matchedBy } = await resolveTargetCwd({
        bundle,
        requestedCwd: parsed.data.cwd,
        projects: Array.isArray(settings?.projects) ? settings.projects : [],
        fallbackCwd: fallbackCwd(),
        git,
      });
      const created = await createImportedSession(bundle, cwd, model);
      if (created.error) return res.status(400).json({ error: created.error, field: created.field });

      const sessionId = created.session.id;
      await store.appendMessages(sessionId, bundle.messages);
      const metadata = importedMetadata(bundle.session.metadata, {
        hostLabel: parsed.data.sourceHostLabel ?? bundle.source.hostname ?? null,
        sessionId: bundle.source.sessionId,
        transferredAt: Date.now(),
      });
      // `handoff` makes the first prompt carry the stored conversation, since
      // this host's CLI has no transcript of it.
      const session = await store.updateSession(sessionId, { metadata, handoff: bundle.messages.length > 0 });
      announceMetadata(sessionId, metadata);

      const gitTransferResult = parsed.data.applyGitChanges && bundle.git
        ? await applyGitChanges(cwd, bundle.git, git)
        : null;

      let promptError = null;
      if (prompt?.trim()) {
        try {
          await promptSession(session, prompt.trim());
        } catch (error) {
          promptError = error instanceof Error ? error.message : String(error);
        }
      }

      res.status(201).json({
        data: {
          sessionId,
          directory: session.cwd,
          matchedBy,
          gitTransferResult,
          prompted: Boolean(prompt?.trim()) && promptError === null,
          promptError,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/sessions/:id/mark-transferred', async (req, res) => {
    const parsed = markBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'hostLabel and targetSessionId are required' });
    try {
      const loaded = await loadSession(req, res);
      if (!loaded) return;
      const transferredTo = { ...parsed.data, transferredAt: Date.now() };
      const metadata = withTransferredTo(loaded.session.metadata, transferredTo);
      await store.updateSession(loaded.session.id, { metadata });
      announceMetadata(loaded.session.id, metadata);
      res.json({ data: transferredTo });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
