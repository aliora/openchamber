import { createStore } from "zustand/vanilla";
import { persist } from "zustand/middleware";
import { z } from "zod";
import type { Session } from "@/lib/opencode/model";
import {
    permissionPolicyWireSchema,
    policySnapshotFromWire,
    resolvePermissionMode,
    type PermissionMode,
    type PermissionModeMap,
    type PermissionPolicySnapshot,
} from "./utils/permissionAutoAccept";
import { getAllSyncSessionMap } from "@/sync/sync-refs";
import { runtimeFetch, type RuntimeFetchOptions } from "@/lib/runtime-fetch";
import { spaceIdOfDirectory } from "@/lib/spaces/space-route";
import { isVSCodeRuntime } from "@/lib/desktop";
import { createDeferredSafeJSONStorage, getSafeStorage } from "./utils/safeStorage";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { opencodeClient } from "@/lib/opencode/client";
import { defineHostStore, defineHostValue } from "@/lib/hosts/runtime/host-bindings";
import type { HostRuntime } from "@/lib/hosts/runtime/types";

interface PermissionStore {
    /** The host's policy: every session that is not in an isolated space. */
    modes: PermissionModeMap;
    /**
     * Each isolated space's own policy, by space id: the server inside the space keeps the modes
     * of its sessions and answers their requests, so it is read and written there.
     */
    spaceModes: Readonly<Record<string, PermissionModeMap>>;
    loaded: boolean;
    saving: boolean;
    lastAppliedRevision: number;
    legacyCandidate: Record<string, boolean> | null;
    legacyRuntimeKey: string | null;
    hydrate: () => Promise<void>;
    /** Applies a policy from its owner: the host (`''`, the default) or the space with that id. */
    applySnapshot: (snapshot: PermissionPolicySnapshot, expectedRuntimeKey?: string, owner?: string) => void;
    /** Reads one isolated space's policy from that space; a space that cannot be read keeps what was known. */
    refreshSpaceModes: (spaceId: string) => Promise<boolean>;
    reset: () => void;
    getSessionMode: (sessionId: string) => PermissionMode;
    setSessionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
}

const readSnapshot = async (response: Response): Promise<PermissionPolicySnapshot> => {
    if (!response.ok) throw new Error(`Permission auto-accept request failed (${response.status})`);
    const parsed = permissionPolicyWireSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Invalid permission auto-accept response");
    return policySnapshotFromWire(parsed.data);
};

const requestSnapshot = async (path: string, init?: RuntimeFetchOptions) => readSnapshot(await runtimeFetch(path, init));

// `enabled` rides along for servers from before the modes and for VS Code's
// bridge, which know only on/off. The directory also picks the server: a
// space's session has its mode in that space.
const putSessionMode = (sessionId: string, mode: PermissionMode, directory?: string) => requestSnapshot(
    `/api/permission-auto-accept/sessions/${encodeURIComponent(sessionId)}`,
    {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, enabled: mode !== "ask", directory }),
        directory: directory ?? null,
    },
);

/** The owner of a session's mode: the space its directory lies in, or the host (''). */
const modeOwnerOf = (directory: string | null | undefined): string => spaceIdOfDirectory(directory) ?? "";

/** A session's directory, as the sync layer knows it, else as the session store resolves it. */
const sessionDirectoryOf = (sessionId: string, sessionById: ReadonlyMap<string, Session>): string | null => (
    sessionById.get(sessionId)?.directory ?? useSessionUIStore.getState().getDirectoryForSession(sessionId)
);

const modeOf = (modes: PermissionModeMap, sessionById: ReadonlyMap<string, Session>, sessionId: string) =>
    resolvePermissionMode({ modes, sessions: [], sessionById, sessionID: sessionId });

type PermissionOperation = { generation: number; runtimeKey: string; sequence: number };

type PermissionOperations = {
    hostId: string;
    generation: number;
    operationSequence: number;
    latestStartedSequence: number;
    pendingSavingOperations: Set<number>;
    /** Revisions of each space's policy, which numbers its own, by space id. */
    spaceRevisions: Map<string, number>;
};

const permissionOperations = defineHostValue<PermissionOperations>((host) => ({
    hostId: host.id,
    generation: 0,
    operationSequence: 0,
    latestStartedSequence: 0,
    pendingSavingOperations: new Set(),
    spaceRevisions: new Map(),
}));

const beginOperation = (operations: PermissionOperations): PermissionOperation => {
    operations.operationSequence += 1;
    const operation = { generation: operations.generation, runtimeKey: operations.hostId, sequence: operations.operationSequence };
    operations.latestStartedSequence = operation.sequence;
    return operation;
};

const isCurrentOperation = (operations: PermissionOperations, operation: PermissionOperation) => (
    operation.generation === operations.generation && operation.runtimeKey === operations.hostId
);

const legacySessionsSchema = z.record(z.string().min(1), z.boolean());

/** Version 1 kept the policy itself in localStorage as an on/off map. */
const persistedV1Schema = z.object({
    autoAccept: legacySessionsSchema.catch({}).default({}),
}).catch({ autoAccept: {} });

/** Version 2 keeps only a not-yet-migrated version 1 policy. */
const persistedV2Schema = z.object({
    legacyCandidate: legacySessionsSchema.nullable().catch(null).default(null),
    legacyRuntimeKey: z.string().nullable().catch(null).default(null),
}).catch({ legacyCandidate: null, legacyRuntimeKey: null });

const permissionStorage = createDeferredSafeJSONStorage<Pick<PermissionStore, "legacyCandidate" | "legacyRuntimeKey">>();

const LEGACY_PERMISSION_STORE_KEY = "permission-store";

const permissionStoreName = (hostId: string): string => `${LEGACY_PERMISSION_STORE_KEY}:${hostId}`;

const legacyPermissionOwnerSchema = z.object({ state: z.object({ legacyRuntimeKey: z.string().nullable().catch(null) }).catch({ legacyRuntimeKey: null }) });

const adoptLegacyPermissionStore = (hostId: string): void => {
    const storage = getSafeStorage();
    const raw = storage.getItem(LEGACY_PERMISSION_STORE_KEY);
    if (raw === null) return;
    let owner: string | null;
    try {
        const parsed = legacyPermissionOwnerSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) return;
        owner = parsed.data.state.legacyRuntimeKey;
    } catch {
        return;
    }
    if (owner !== null && owner !== hostId) return;
    if (storage.getItem(permissionStoreName(hostId)) === null) storage.setItem(permissionStoreName(hostId), raw);
    storage.removeItem(LEGACY_PERMISSION_STORE_KEY);
};

const createPermissionStore = (host: HostRuntime) => createStore<PermissionStore>()(persist((set, get) => ({
    modes: {},
    spaceModes: {},
    loaded: false,
    saving: false,
    lastAppliedRevision: -1,
    legacyCandidate: null,
    legacyRuntimeKey: null,

    hydrate: async () => {
        const operations = host.run(permissionOperations);
        const isCurrent = (operation: PermissionOperation) => isCurrentOperation(operations, operation);
        const operation = beginOperation(operations);
        const legacyCandidate = get().legacyCandidate;
        let legacyRuntimeKey = get().legacyRuntimeKey;
        if (legacyCandidate && !legacyRuntimeKey) {
            legacyRuntimeKey = operation.runtimeKey;
            set({ legacyRuntimeKey });
        }
        let snapshot = await host.run(() => requestSnapshot("/api/permission-auto-accept"));
        if (!isCurrent(operation)) return;
        const legacyEntries = legacyRuntimeKey === operation.runtimeKey
            ? Object.entries(legacyCandidate ?? {})
            : [];
        if (Object.keys(snapshot.modes).length === 0 && legacyEntries.length > 0) {
            for (const [sessionId, enabled] of legacyEntries) {
                if (!sessionId) continue;
                snapshot = await host.run(() => putSessionMode(sessionId, enabled ? "auto" : "ask"));
                if (!isCurrent(operation)) return;
            }
        }
        if (!isCurrent(operation)) return;
        if (snapshot.revision === undefined && operation.sequence !== operations.latestStartedSequence) return;
        get().applySnapshot(snapshot, operation.runtimeKey);
        if (legacyRuntimeKey === operation.runtimeKey) {
            set({ legacyCandidate: null, legacyRuntimeKey: null });
        }
    },

    reset: () => {
        const operations = host.run(permissionOperations);
        operations.generation += 1;
        operations.latestStartedSequence = 0;
        operations.pendingSavingOperations.clear();
        operations.spaceRevisions.clear();
        set({ modes: {}, spaceModes: {}, loaded: false, saving: false, lastAppliedRevision: -1 });
    },

    applySnapshot: (snapshot, expectedRuntimeKey, owner = "") => {
        if (expectedRuntimeKey && expectedRuntimeKey !== host.id) return;
        const { revision } = snapshot;
        if (owner) {
            const { spaceRevisions } = host.run(permissionOperations);
            if (revision !== undefined) {
                if (revision < (spaceRevisions.get(owner) ?? -1)) return;
                spaceRevisions.set(owner, revision);
            }
            set((state) => ({ spaceModes: { ...state.spaceModes, [owner]: snapshot.modes } }));
            return;
        }
        set((state) => {
            if (revision === undefined) {
                return state.lastAppliedRevision >= 0 ? state : { modes: snapshot.modes, loaded: true };
            }
            if (revision < state.lastAppliedRevision) return state;
            return { modes: snapshot.modes, loaded: true, lastAppliedRevision: revision };
        });
    },

    refreshSpaceModes: async (spaceId) => {
        const runtimeKey = host.id;
        let snapshot: PermissionPolicySnapshot;
        try {
            snapshot = await host.run(() => requestSnapshot("/api/permission-auto-accept", { directory: `/spaces/${spaceId}` }));
        } catch {
            return false;
        }
        get().applySnapshot(snapshot, runtimeKey, spaceId);
        return true;
    },

    getSessionMode: (sessionId) => {
        if (!sessionId) return "ask";
        const sessionById = host.run(getAllSyncSessionMap);
        const owner = modeOwnerOf(host.run(() => sessionDirectoryOf(sessionId, sessionById)));
        const modes = owner ? get().spaceModes[owner] ?? {} : get().modes;
        if (Object.keys(modes).length === 0) return "ask";
        return modeOf(modes, sessionById, sessionId);
    },

    setSessionMode: async (sessionId, mode) => {
        if (!sessionId) return;
        const operations = host.run(permissionOperations);
        const { pendingSavingOperations } = operations;
        const isCurrent = (operation: PermissionOperation) => isCurrentOperation(operations, operation);
        const operation = beginOperation(operations);
        pendingSavingOperations.add(operation.sequence);
        set({ saving: true });
        try {
            const directory = host.run(() => sessionDirectoryOf(sessionId, getAllSyncSessionMap())
                ?? opencodeClient.getDirectory()
                ?? undefined);
            const snapshot = await host.run(() => putSessionMode(sessionId, mode, directory));
            if (!isCurrent(operation)) return;
            if (snapshot.revision === undefined && operation.sequence !== operations.latestStartedSequence) return;
            get().applySnapshot(snapshot, operation.runtimeKey, modeOwnerOf(directory));
            if (isCurrent(operation) && isVSCodeRuntime() && mode !== "ask") {
                const { reconcileVSCodePendingPermissions } = await import("@/sync/vscode-permission-auto-accept");
                if (isCurrent(operation)) {
                    void host.run(() => reconcileVSCodePendingPermissions(directory)).catch(() => undefined);
                }
            }
        } finally {
            if (isCurrent(operation)) {
                pendingSavingOperations.delete(operation.sequence);
                set({ saving: pendingSavingOperations.size > 0 });
            }
        }
    },

}), {
    name: permissionStoreName(host.id),
    storage: permissionStorage,
    version: 2,
    migrate: (persisted, version) => {
        if (version < 2) {
            const legacyCandidate = persistedV1Schema.parse(persisted ?? {}).autoAccept;
            return {
                legacyCandidate: Object.keys(legacyCandidate).length > 0 ? legacyCandidate : null,
                legacyRuntimeKey: null,
            };
        }
        return persistedV2Schema.parse(persisted ?? {});
    },
    partialize: (state) => ({
        legacyCandidate: state.legacyCandidate,
        legacyRuntimeKey: state.legacyRuntimeKey,
    }),
}));

export const usePermissionStore = defineHostStore<PermissionStore>("permission", (host) => {
    adoptLegacyPermissionStore(host.id);
    return createPermissionStore(host);
});
