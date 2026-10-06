// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off preferSchemaOverJson:off - private durable files and canonical content hashes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  PeerMemoryChange,
  PeerMemoryChanges,
  PeerMemoryCommand,
  PeerMemoryCommandResult,
  PeerMemoryMode,
  PeerMemoryProjection,
  PeerMemoryRecordView,
  PeerMemoryReceipt,
  PeerMemorySearchResult,
  type PeerHubMemoryExecuteInput,
  type PeerHubMemoryReadInput,
  type PeerHubMemorySearchInput,
  type PeerHubMemoryProjectInput,
  type PeerMemoryRecordRef,
  type PeerMemoryScope,
  type PeerMemoryState,
  type PeerMemoryWriteResult,
  type PeerMemoryReceiptInput,
  type PeerHubMemoryKeepInput,
  type PeerHubMemoryImportKnowledgeInput,
  type PeerMemoryQueue,
  type PeerHubMemoryRetryInput,
  type PeerHubMemoryDiscardInput,
  type PeerMemoryDiscarded,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as MemoryTransport from "./MemoryTransport.ts";
import * as MemoryKnowledge from "./knowledge.ts";

const Pending = Schema.Struct({
  command: PeerMemoryCommand,
  hash: Schema.String,
  at: Schema.String,
  blocked: Schema.optional(Schema.String),
});
const LocalSession = Schema.Struct({
  sessionId: Schema.String,
  runtimeGeneration: Schema.String,
  environmentId: Schema.String,
  workId: Schema.String,
  directory: Schema.String,
  selected: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.Number })),
  projections: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      at: Schema.String,
      selected: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.Number })),
      memoryWatermark: Schema.optional(Schema.Number),
    }),
  ),
  critical: Schema.Array(PeerMemoryChange),
  changed: Schema.Array(PeerMemoryChange),
  ended: Schema.Boolean,
});
const LocalState = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  authorizationKey: Schema.String,
  mode: PeerMemoryMode,
  available: Schema.Boolean,
  cursor: Schema.Number,
  lastSyncAt: Schema.NullOr(Schema.String),
  pending: Schema.Array(Pending),
  sessions: Schema.Array(LocalSession),
  discarded: Schema.Array(
    Schema.Struct({ command: PeerMemoryCommand, at: Schema.String, reason: Schema.String }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  registeredGenerations: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  reads: Schema.Array(Schema.Struct({ key: Schema.String, value: PeerMemoryRecordView })),
  searches: Schema.Array(Schema.Struct({ key: Schema.String, value: PeerMemorySearchResult })),
});
type LocalState = typeof LocalState.Type;
type LocalSession = typeof LocalSession.Type;
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(LocalState));
const encodeManifest = Schema.encodeSync(
  Schema.fromJsonString(PeerMemoryProjection.fields.manifest),
);
const encodeCommand = Schema.encodeSync(Schema.fromJsonString(PeerMemoryCommand));
const decodeCommand = Schema.decodeEffect(PeerMemoryCommand);
const Mode = Schema.Struct({ mode: PeerMemoryMode });
const Receipts = Schema.Struct({ receipts: Schema.Array(PeerMemoryReceipt) });
const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const part = (value: string) =>
  `${value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 48)}-${hash(value).slice(0, 12)}`;
const localError = (cause: unknown) =>
  new MemoryTransport.MemoryError({
    code: "local",
    detail: "Peer could not safely persist its local memory state.",
    cause,
  });
const disk = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: localError });

export interface MemorySession extends PeerMemoryScope {
  readonly sessionId: string;
  readonly environmentId: string;
  readonly runtimeGeneration: string;
  readonly workId: string;
  readonly taskId?: string;
  readonly repositoryId?: string;
  readonly adapter: string;
  readonly root: string;
}
export interface SessionProjection {
  readonly projection: PeerMemoryProjection;
  readonly projectionPath: string;
  readonly manifestPath: string;
  readonly currentPath: string;
}

export class MemoryService extends Context.Service<
  MemoryService,
  {
    readonly state: (
      scope: PeerMemoryScope,
    ) => Effect.Effect<PeerMemoryState, MemoryTransport.MemoryError>;
    readonly mode: (
      scope: PeerMemoryScope,
    ) => Effect.Effect<{ readonly mode: PeerMemoryMode }, MemoryTransport.MemoryError>;
    readonly setMode: (
      input: PeerMemoryScope & { readonly mode: PeerMemoryMode },
    ) => Effect.Effect<{ readonly mode: PeerMemoryMode }, MemoryTransport.MemoryError>;
    readonly execute: (
      input: PeerHubMemoryExecuteInput,
    ) => Effect.Effect<PeerMemoryWriteResult, MemoryTransport.MemoryError>;
    readonly search: (
      input: PeerHubMemorySearchInput,
    ) => Effect.Effect<PeerMemorySearchResult, MemoryTransport.MemoryError>;
    readonly read: (
      input: PeerHubMemoryReadInput,
    ) => Effect.Effect<PeerMemoryRecordView, MemoryTransport.MemoryError>;
    readonly project: (
      input: PeerHubMemoryProjectInput,
    ) => Effect.Effect<PeerMemoryProjection, MemoryTransport.MemoryError>;
    readonly changes: (
      input: PeerMemoryScope & {
        readonly after?: number | undefined;
        readonly limit?: number | undefined;
      },
    ) => Effect.Effect<PeerMemoryChanges, MemoryTransport.MemoryError>;
    readonly receipts: (
      input: PeerMemoryScope & { readonly recordId?: string | undefined },
    ) => Effect.Effect<typeof Receipts.Type, MemoryTransport.MemoryError>;
    readonly queue: (
      scope: PeerMemoryScope,
    ) => Effect.Effect<PeerMemoryQueue, MemoryTransport.MemoryError>;
    readonly retry: (
      input: PeerHubMemoryRetryInput,
    ) => Effect.Effect<PeerMemoryWriteResult, MemoryTransport.MemoryError>;
    readonly discard: (
      input: PeerHubMemoryDiscardInput,
    ) => Effect.Effect<PeerMemoryDiscarded, MemoryTransport.MemoryError>;
    readonly synchronize: (
      scope: PeerMemoryScope,
    ) => Effect.Effect<PeerMemoryState, MemoryTransport.MemoryError>;
    readonly prepareSession: (
      session: MemorySession,
      source: string,
    ) => Effect.Effect<
      { readonly mode: PeerMemoryMode; readonly currentPath: string; readonly notice: string },
      MemoryTransport.MemoryError
    >;
    readonly projectForSession: (
      session: MemorySession,
      projection: PeerHubMemoryProjectInput["projection"],
      targetScope?: PeerMemoryScope,
    ) => Effect.Effect<SessionProjection, MemoryTransport.MemoryError>;
    readonly checkpoint: (
      session: MemorySession,
      reason: string,
    ) => Effect.Effect<{ readonly path: string }, MemoryTransport.MemoryError>;
    readonly restoreCheckpoint: (
      session: MemorySession,
      name: string,
    ) => Effect.Effect<{ readonly path: string }, MemoryTransport.MemoryError>;
    readonly sessionNotice: (
      session: MemorySession,
    ) => Effect.Effect<string, MemoryTransport.MemoryError>;
    readonly receipt: (
      session: MemorySession,
      input: Omit<PeerMemoryReceiptInput, "sessionId" | "environmentId" | "runtimeGeneration">,
      targetScope?: PeerMemoryScope,
    ) => Effect.Effect<PeerMemoryReceipt, MemoryTransport.MemoryError>;
    readonly endSession: (
      session: MemorySession,
    ) => Effect.Effect<void, MemoryTransport.MemoryError>;
    readonly legacySnapshot: (
      session: MemorySession,
      text: string,
      source: string,
    ) => Effect.Effect<void, MemoryTransport.MemoryError>;
    readonly keep: (input: PeerHubMemoryKeepInput) => Effect.Effect<
      {
        readonly status: "kept_pending_review";
        readonly path: string;
        readonly operation: PeerMemoryWriteResult;
      },
      MemoryTransport.MemoryError,
      MemoryTransport.MemoryAuth
    >;
    readonly importKnowledge: (
      input: PeerHubMemoryImportKnowledgeInput,
    ) => Effect.Effect<
      { readonly operations: ReadonlyArray<PeerMemoryWriteResult> },
      MemoryTransport.MemoryError,
      MemoryTransport.MemoryAuth
    >;
  }
>()("t3/peerHub/memory/MemoryService") {}

/** Rename only after fsync: a successful local enqueue survives an ordinary process crash. */
const atomicWrite = async (path: string, text: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
  const directory = await NodeFSP.open(NodePath.dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};
const createOnce = async (path: string, text: string) => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
  try {
    const file = await NodeFSP.open(path, "wx", 0o600);
    try {
      await file.writeFile(text);
      await file.sync();
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
};
const createImmutable = async (path: string, text: string) => {
  await createOnce(path, text);
  if ((await NodeFSP.readFile(path, "utf8")) !== text)
    throw new Error("An immutable memory projection already has different content.");
};
const coalesce = (events: ReadonlyArray<typeof PeerMemoryChange.Type>) => {
  const latest = new Map<string, typeof PeerMemoryChange.Type>();
  for (const event of events)
    if ((latest.get(event.id)?.version ?? 0) <= event.version) latest.set(event.id, event);
  return [...latest.values()];
};
const sessionKey = (session: Pick<MemorySession, "sessionId" | "runtimeGeneration">) =>
  `${session.sessionId}/${session.runtimeGeneration}`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const transport = yield* MemoryTransport.MemoryTransport;
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const directoryOf = (identity: MemoryTransport.MemoryIdentity, scope: PeerMemoryScope) =>
    NodePath.join(
      config.stateDir,
      "memory",
      hash(`${identity.hubUrl}/${identity.email}`),
      part(scope.workspace),
      part(scope.project),
    );
  const load = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    scope: PeerMemoryScope,
  ) {
    const directory = directoryOf(identity, scope);
    const text = yield* disk(() =>
      NodeFSP.readFile(NodePath.join(directory, "state.json"), "utf8").catch((cause: unknown) => {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
        throw cause;
      }),
    );
    const authorizationKey = hash(`${identity.email}/${identity.token}`);
    const state: LocalState =
      text === null
        ? {
            schemaVersion: 1,
            authorizationKey,
            mode: "legacy",
            available: false,
            cursor: 0,
            lastSyncAt: null,
            pending: [],
            sessions: [],
            reads: [],
            searches: [],
            discarded: [],
            registeredGenerations: [],
          }
        : yield* decodeState(text).pipe(Effect.mapError(localError));
    // A refreshed login never inherits a previous credential's shared cache.
    return {
      directory,
      state:
        state.authorizationKey === authorizationKey
          ? state
          : { ...state, authorizationKey, reads: [], searches: [], available: false },
    };
  });
  const save = (directory: string, state: LocalState) =>
    disk(() => atomicWrite(NodePath.join(directory, "state.json"), encodeState(state)));
  const summarize = (state: LocalState, timestamp: number): PeerMemoryState => ({
    mode: state.mode,
    available: state.available,
    cursor: state.cursor,
    lastSyncAt: state.lastSyncAt,
    pendingLocal: state.pending.filter((pending) => pending.blocked === undefined).length,
    blockedLocal: state.pending.filter((pending) => pending.blocked !== undefined).length,
    ...(() => {
      const latest = state.sessions
        .flatMap((session) => session.projections)
        .map((projection) => DateTime.toEpochMillis(DateTime.makeUnsafe(projection.at)))
        .sort((a, b) => b - a)[0];
      return latest === undefined ? {} : { projectionAgeMs: Math.max(0, timestamp - latest) };
    })(),
    capabilities: ["codex", "claude", "cursor", "grok", "opencode", "antigravity", "pi"].map(
      (adapter) => ({ adapter, mode: "companion" }),
    ),
  });
  const invalidate = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    scope: PeerMemoryScope,
    error: MemoryTransport.MemoryError,
  ) {
    if (error.code !== "not_found") return;
    const { directory, state } = yield* load(identity, scope);
    yield* save(directory, { ...state, available: false, reads: [], searches: [] });
  });
  const authorize = (identity: MemoryTransport.MemoryIdentity, scope: PeerMemoryScope) =>
    transport.authorize(identity, scope).pipe(
      Effect.andThen(
        scope.project === "company"
          ? transport.request(identity, scope, "GET", "/mode", Mode).pipe(Effect.asVoid)
          : Effect.void,
      ),
      Effect.tapError((error) => invalidate(identity, scope, error)),
    );
  const registerPending = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    scope: PeerMemoryScope,
    directory: string,
    initial: LocalState,
  ) {
    let state = initial;
    const registrations = new Map<
      string,
      { id: string; runtimeGeneration: string; environment: string }
    >();
    for (const { command } of state.pending) {
      if (
        command.sessionId === undefined ||
        command.runtimeGeneration === undefined ||
        command.environmentId === undefined
      )
        continue;
      const key = `${command.sessionId}/${command.runtimeGeneration}`;
      if (!state.registeredGenerations.includes(key))
        registrations.set(key, {
          id: command.sessionId,
          runtimeGeneration: command.runtimeGeneration,
          environment: command.environmentId,
        });
    }
    for (const environment of new Set(
      [...registrations.values()].map((entry) => entry.environment),
    )) {
      const entries = [...registrations].filter(([, entry]) => entry.environment === environment);
      for (let offset = 0; offset < entries.length; offset += 50) {
        const batch = entries.slice(offset, offset + 50);
        // This registers provenance only. Omitted sessions preserves the actual live report.
        yield* transport.request(
          identity,
          scope,
          "PUT",
          `/v1/workspaces/${encodeURIComponent(scope.workspace)}/coord`,
          Schema.Unknown,
          {
            environment,
            historicalSessions: batch.map(([, entry]) => ({
              id: entry.id,
              runtimeGeneration: entry.runtimeGeneration,
              project: scope.project,
              label: "Archived Peer memory runtime",
              status: "done",
              files: [],
              claims: [],
            })),
          },
        );
        state = Object.assign({}, state, {
          registeredGenerations: state.registeredGenerations.concat(batch.map(([key]) => key)),
        });
        yield* save(directory, state);
      }
    }
    return state;
  });
  const synchronizeIdentity = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    scope: PeerMemoryScope,
  ) {
    let { state, directory } = yield* load(identity, scope);
    const authorized = yield* authorize(identity, scope).pipe(Effect.result);
    if (authorized._tag === "Failure") {
      state = {
        ...state,
        available: false,
        ...(authorized.failure.code === "not_found" ? { reads: [], searches: [] } : {}),
      };
      yield* save(directory, state);
      if (authorized.failure.code !== "unavailable") return yield* authorized.failure;
      return state;
    }
    const mode = yield* transport
      .request(identity, scope, "GET", "/mode", Mode)
      .pipe(Effect.result);
    if (mode._tag === "Failure") {
      if (mode.failure.code !== "unavailable") return yield* mode.failure;
      state = { ...state, available: false };
      yield* save(directory, state);
      return state;
    }
    state = { ...state, mode: mode.success.mode, available: true };
    const registered = yield* registerPending(identity, scope, directory, state).pipe(
      Effect.result,
    );
    if (registered._tag === "Failure") {
      yield* save(directory, { ...state, available: false });
      if (registered.failure.code !== "unavailable") return yield* registered.failure;
      return { ...state, available: false };
    }
    state = registered.success;
    for (const pending of state.pending) {
      if (pending.blocked !== undefined) continue;
      const result = yield* transport
        .request(identity, scope, "POST", "/commands", PeerMemoryCommandResult, pending.command)
        .pipe(Effect.result);
      if (result._tag === "Failure") {
        if (result.failure.code === "unavailable") {
          state = { ...state, available: false };
          break;
        }
        state = {
          ...state,
          pending: state.pending.map((entry) =>
            entry.command.operationId === pending.command.operationId
              ? { ...entry, blocked: result.failure.detail }
              : entry,
          ),
        };
      } else
        state = {
          ...state,
          pending: state.pending.filter(
            (entry) => entry.command.operationId !== pending.command.operationId,
          ),
          reads: [],
          searches: [],
        };
      yield* save(directory, state);
    }
    if (!state.available) {
      yield* save(directory, state);
      return state;
    }
    while (true) {
      const batch = yield* transport
        .request(
          identity,
          scope,
          "GET",
          `/changes?after=${state.cursor}&limit=200`,
          PeerMemoryChanges,
        )
        .pipe(Effect.result);
      if (batch._tag === "Failure") {
        if (batch.failure.code !== "unavailable") return yield* batch.failure;
        state = { ...state, available: false };
        break;
      }
      const { changes, cursor, hasMore, resyncRequired } = batch.success;
      const sessions: LocalSession[] = [];
      for (const session of state.sessions) {
        const relevant = changes.filter((change) =>
          session.selected.some(
            (selected) =>
              (selected.id === change.id && selected.version < change.version) ||
              (change.affectedRecordIds ?? []).includes(selected.id),
          ),
        );
        const critical = resyncRequired
          ? []
          : coalesce([...session.critical, ...relevant.filter((change) => change.critical)]);
        if (resyncRequired)
          for (const selected of coalesceRefs([...session.selected, ...session.critical]))
            critical.push({
              cursor,
              id: selected.id,
              version: selected.version,
              type: "resync_required",
              critical: true,
              at: yield* now,
            });
        const erased = new Set(
          changes.filter((change) => change.type === "record.erase").map((change) => change.id),
        );
        const projections = resyncRequired
          ? []
          : session.projections.filter(
              (projection) => !projection.selected.some((selected) => erased.has(selected.id)),
            );
        for (const projection of session.projections)
          if (!projections.includes(projection))
            yield* disk(() =>
              Promise.all([
                NodeFSP.rm(
                  NodePath.join(session.directory, `projection.${part(projection.id)}.md`),
                  { force: true },
                ),
                NodeFSP.rm(
                  NodePath.join(session.directory, `manifest.${part(projection.id)}.json`),
                  { force: true },
                ),
              ]),
            );
        sessions.push({
          ...session,
          selected: resyncRequired ? [] : session.selected,
          projections,
          critical: coalesce(critical),
          changed: coalesce([
            ...session.changed,
            ...relevant.filter((change) => !change.critical),
          ]).slice(-50),
        });
      }
      state = {
        ...state,
        sessions,
        cursor,
        lastSyncAt: yield* now,
        reads: changes.length > 0 || resyncRequired ? [] : state.reads,
        searches: changes.length > 0 || resyncRequired ? [] : state.searches,
      };
      // Persist the processed batch and invalidations together, before advancing its cursor.
      yield* save(directory, state);
      if (!hasMore) break;
    }
    yield* save(directory, state);
    return state;
  });
  const state = Effect.fn("MemoryService.state")(function* (scope: PeerMemoryScope) {
    const identity = yield* transport.identity;
    return summarize(
      (yield* load(identity, scope)).state,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  }, lock.withPermits(1));
  const synchronize = Effect.fn("MemoryService.synchronize")(function* (scope: PeerMemoryScope) {
    return summarize(
      yield* synchronizeIdentity(yield* transport.identity, scope),
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  }, lock.withPermits(1));
  const mode = Effect.fn("MemoryService.mode")(function* (scope: PeerMemoryScope) {
    const identity = yield* transport.identity;
    yield* authorize(identity, scope);
    const result = yield* transport.request(identity, scope, "GET", "/mode", Mode);
    const local = yield* load(identity, scope);
    yield* save(local.directory, { ...local.state, mode: result.mode });
    return result;
  }, lock.withPermits(1));
  const setMode = Effect.fn("MemoryService.setMode")(function* (
    input: PeerMemoryScope & { readonly mode: PeerMemoryMode },
  ) {
    const identity = yield* transport.identity;
    yield* authorize(identity, input);
    const result = yield* transport.request(identity, input, "PUT", "/mode", Mode, {
      mode: input.mode,
    });
    const local = yield* load(identity, input);
    yield* save(local.directory, { ...local.state, mode: result.mode });
    return result;
  }, lock.withPermits(1));
  const executeIdentity = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    input: PeerHubMemoryExecuteInput,
  ) {
    const command = yield* decodeCommand(input.command).pipe(
      Effect.mapError(
        (cause) =>
          new MemoryTransport.MemoryError({
            code: "invalid",
            detail: "The memory command is invalid.",
            cause,
          }),
      ),
    );
    let local = yield* load(identity, input);
    const payloadHash = hash(encodeCommand(command));
    const pending = local.state.pending.find(
      (entry) => entry.command.operationId === command.operationId,
    );
    if (local.state.discarded.some((entry) => entry.command.operationId === command.operationId))
      return yield* new MemoryTransport.MemoryError({
        code: "conflict",
        detail:
          "This operation was explicitly discarded. Use a new operation ID for a new finding.",
      });
    if (pending !== undefined && pending.hash !== payloadHash)
      return yield* new MemoryTransport.MemoryError({
        code: "conflict",
        detail: "This operation ID already belongs to a different pending command.",
      });
    const authorized = yield* authorize(identity, input).pipe(Effect.result);
    if (authorized._tag === "Failure" && authorized.failure.code !== "unavailable")
      return yield* authorized.failure;
    if (pending === undefined) {
      local = {
        ...local,
        state: {
          ...local.state,
          pending: [...local.state.pending, { command, hash: payloadHash, at: yield* now }],
        },
      };
      yield* save(local.directory, local.state);
    }
    if (authorized._tag === "Failure")
      return {
        status: "pending_local",
        operationId: command.operationId,
      } satisfies PeerMemoryWriteResult;
    const registered = yield* registerPending(identity, input, local.directory, local.state).pipe(
      Effect.result,
    );
    if (registered._tag === "Failure") {
      if (registered.failure.code !== "unavailable") return yield* registered.failure;
      return {
        status: "pending_local",
        operationId: command.operationId,
      } satisfies PeerMemoryWriteResult;
    }
    local = { ...local, state: registered.success };
    const result = yield* transport
      .request(identity, input, "POST", "/commands", PeerMemoryCommandResult, command)
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* save(local.directory, {
        ...local.state,
        available: false,
        pending: local.state.pending.map((entry) =>
          entry.command.operationId === command.operationId && result.failure.code !== "unavailable"
            ? { ...entry, blocked: result.failure.detail }
            : entry,
        ),
      });
      if (result.failure.code !== "unavailable") return yield* result.failure;
      return {
        status: "pending_local",
        operationId: command.operationId,
      } satisfies PeerMemoryWriteResult;
    }
    yield* save(local.directory, {
      ...local.state,
      available: true,
      pending: local.state.pending.filter(
        (entry) => entry.command.operationId !== command.operationId,
      ),
      reads: [],
      searches: [],
    });
    return {
      status: "stored",
      operationId: command.operationId,
      result: result.success,
    } satisfies PeerMemoryWriteResult;
  });
  const execute = Effect.fn("MemoryService.execute")(function* (input: PeerHubMemoryExecuteInput) {
    return yield* executeIdentity(yield* transport.identity, input);
  }, lock.withPermits(1));
  const queue = Effect.fn("MemoryService.queue")(function* (scope: PeerMemoryScope) {
    const local = yield* load(yield* transport.identity, scope);
    return {
      operations: local.state.pending.map((entry) => ({
        operationId: entry.command.operationId,
        command: entry.command,
        status: entry.blocked === undefined ? ("pending" as const) : ("blocked" as const),
        at: entry.at,
        ...(entry.blocked === undefined ? {} : { blockedReason: entry.blocked }),
      })),
    };
  }, lock.withPermits(1));
  const retry = Effect.fn("MemoryService.retry")(function* (input: PeerHubMemoryRetryInput) {
    const identity = yield* transport.identity;
    const local = yield* load(identity, input);
    const pending = local.state.pending.find(
      (entry) => entry.command.operationId === input.operationId,
    );
    if (pending === undefined)
      return yield* new MemoryTransport.MemoryError({
        code: "not_found",
        detail: "This local operation is no longer pending.",
      });
    yield* save(local.directory, {
      ...local.state,
      pending: local.state.pending.map((entry) =>
        entry.command.operationId === input.operationId
          ? { command: entry.command, hash: entry.hash, at: entry.at }
          : entry,
      ),
    });
    return yield* executeIdentity(identity, {
      workspace: input.workspace,
      project: input.project,
      command: pending.command,
    });
  }, lock.withPermits(1));
  const discard = Effect.fn("MemoryService.discard")(function* (input: PeerHubMemoryDiscardInput) {
    if (input.reason.trim() === "")
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail: "Explain why this pending operation should be discarded.",
      });
    const local = yield* load(yield* transport.identity, input);
    const pending = local.state.pending.find(
      (entry) => entry.command.operationId === input.operationId,
    );
    if (pending === undefined)
      return yield* new MemoryTransport.MemoryError({
        code: "not_found",
        detail: "This local operation is no longer pending.",
      });
    yield* save(local.directory, {
      ...local.state,
      pending: local.state.pending.filter(
        (entry) => entry.command.operationId !== input.operationId,
      ),
      discarded: [
        ...local.state.discarded,
        { command: pending.command, at: yield* now, reason: input.reason },
      ],
    });
    return { operationId: input.operationId, status: "discarded" as const };
  }, lock.withPermits(1));
  const fresh = Effect.fnUntraced(function* (scope: PeerMemoryScope) {
    const identity = yield* transport.identity;
    const state = yield* synchronizeIdentity(identity, scope);
    if (!state.available)
      return yield* new MemoryTransport.MemoryError({
        code: "unavailable",
        detail:
          "Peer Memory is unavailable. Your private context is preserved; shared reads wait for current authorization.",
      });
    return { identity, state, directory: directoryOf(identity, scope) };
  });
  const search = Effect.fn("MemoryService.search")(function* (input: PeerHubMemorySearchInput) {
    const local = yield* fresh(input);
    const key = hash(JSON.stringify(input.search));
    const cached = local.state.searches.find((entry) => entry.key === key);
    if (cached !== undefined) return cached.value;
    const value = yield* transport.request(
      local.identity,
      input,
      "POST",
      "/search",
      PeerMemorySearchResult,
      input.search,
    );
    yield* save(local.directory, {
      ...local.state,
      searches: [...local.state.searches, { key, value }].slice(-50),
    });
    return value;
  }, lock.withPermits(1));
  const read = Effect.fn("MemoryService.read")(function* (input: PeerHubMemoryReadInput) {
    const local = yield* fresh(input);
    const key = hash(
      JSON.stringify({ id: input.id, version: input.version, knownAt: input.knownAt }),
    );
    const cached = local.state.reads.find((entry) => entry.key === key);
    if (cached !== undefined) return cached.value;
    const parameters = new URLSearchParams();
    if (input.version !== undefined) parameters.set("version", String(input.version));
    if (input.knownAt !== undefined) parameters.set("knownAt", input.knownAt);
    const value = yield* transport.request(
      local.identity,
      input,
      "GET",
      `/records/${encodeURIComponent(input.id)}?${parameters}`,
      PeerMemoryRecordView,
    );
    yield* save(local.directory, {
      ...local.state,
      reads: [...local.state.reads, { key, value }].slice(-100),
    });
    return value;
  }, lock.withPermits(1));
  const verifyProjection = (
    identity: MemoryTransport.MemoryIdentity,
    scope: PeerMemoryScope,
    value: PeerMemoryProjection,
  ) => {
    const permitted = value.manifest.permissionScope;
    return value.manifest.workspaceId === scope.workspace &&
      value.manifest.projectId === scope.project &&
      permitted.email === identity.email &&
      permitted.workspaceId === scope.workspace &&
      permitted.projectId === scope.project &&
      hash(value.text) === value.manifest.contentHash
      ? Effect.succeed(value)
      : Effect.fail(
          new MemoryTransport.MemoryError({
            code: "invalid",
            detail: "The projection's scope or content hash did not match its manifest.",
          }),
        );
  };
  const project = Effect.fn("MemoryService.project")(function* (input: PeerHubMemoryProjectInput) {
    const local = yield* fresh(input);
    return yield* transport
      .request(
        local.identity,
        input,
        "POST",
        "/projections",
        PeerMemoryProjection,
        input.projection,
      )
      .pipe(Effect.flatMap((value) => verifyProjection(local.identity, input, value)));
  }, lock.withPermits(1));
  const changes = Effect.fn("MemoryService.changes")(function* (
    input: PeerMemoryScope & {
      readonly after?: number | undefined;
      readonly limit?: number | undefined;
    },
  ) {
    const identity = yield* transport.identity;
    yield* authorize(identity, input);
    return yield* transport.request(
      identity,
      input,
      "GET",
      `/changes?after=${input.after ?? 0}&limit=${input.limit ?? 200}`,
      PeerMemoryChanges,
    );
  }, lock.withPermits(1));
  const receipts = Effect.fn("MemoryService.receipts")(function* (
    input: PeerMemoryScope & { readonly recordId?: string | undefined },
  ) {
    const identity = yield* transport.identity;
    yield* authorize(identity, input);
    return yield* transport.request(
      identity,
      input,
      "GET",
      `/receipts${input.recordId === undefined ? "" : `?recordId=${encodeURIComponent(input.recordId)}`}`,
      Receipts,
    );
  }, lock.withPermits(1));
  const ensureSession = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    session: MemorySession,
  ) {
    if (
      session.environmentId !== identity.environmentId ||
      session.runtimeGeneration === "" ||
      session.sessionId === ""
    )
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail: "The runtime does not own this private memory context.",
      });
    const local = yield* load(identity, session);
    let current = local.state.sessions.find((entry) => sessionKey(entry) === sessionKey(session));
    if (current === undefined) {
      current = {
        sessionId: session.sessionId,
        environmentId: session.environmentId,
        runtimeGeneration: session.runtimeGeneration,
        workId: session.workId,
        directory: NodePath.join(
          local.directory,
          part(session.workId),
          part(session.sessionId),
          part(session.runtimeGeneration),
        ),
        selected: [],
        projections: [],
        critical: [],
        changed: [],
        ended: false,
      };
      local.state = { ...local.state, sessions: [...local.state.sessions, current] };
      yield* save(local.directory, local.state);
    }
    return { ...local, current };
  });
  const noticeOf = (
    session: LocalSession,
    includeContext = true,
    offerProjection = true,
    stale = false,
  ) =>
    [
      ...(includeContext
        ? [
            `Peer Memory companion context: ${NodePath.join(session.directory, "current.md")}. Edit this private file; share a selected finding with peer remember.`,
          ]
        : []),
      ...(!includeContext || !offerProjection || session.projections.length === 0
        ? []
        : [
            `Latest immutable projection${stale ? " (stale; memory unavailable)" : ""}: ${NodePath.join(session.directory, `projection.${part(session.projections.at(-1)!.id)}.md`)}; the manifest preserves the selected versions.`,
          ]),
      ...session.critical.map(
        (change) =>
          `Peer Memory critical: ${change.id}@${change.version} ${change.type}; read the current record and acknowledge the change. This notice remains pending until acknowledged.`,
      ),
      ...session.changed.map(
        (change) => `Peer Memory changed: ${change.id}@${change.version} ${change.type}.`,
      ),
    ].join("\n");
  const readingSession = (session: MemorySession, targetScope?: PeerMemoryScope) =>
    targetScope === undefined ||
    (targetScope.workspace === session.workspace &&
      (targetScope.project === session.project || targetScope.project === "company"))
      ? Effect.succeed({ ...session, ...targetScope })
      : Effect.fail(
          new MemoryTransport.MemoryError({
            code: "invalid",
            detail:
              "A runtime reads its own project or explicit company scope in the same workspace.",
          }),
        );
  const companyNotice = Effect.fnUntraced(function* (
    identity: MemoryTransport.MemoryIdentity,
    session: MemorySession,
  ) {
    if (session.project === "company") return "";
    const scope = { workspace: session.workspace, project: "company" };
    const local = yield* load(identity, scope);
    const current = local.state.sessions.find((entry) => sessionKey(entry) === sessionKey(session));
    if (current === undefined) return "";
    const authorized = yield* authorize(identity, scope).pipe(Effect.result);
    if (authorized._tag === "Failure") return "";
    const latest = current.projections.at(-1);
    return [
      ...(latest === undefined
        ? []
        : [
            `Peer Memory company projection${local.state.available ? "" : " (stale; memory unavailable)"}: ${NodePath.join(current.directory, `projection.${part(latest.id)}.md`)}. Use --project company when reading or acknowledging these records.`,
          ]),
      noticeOf(current, false).replaceAll("Peer Memory ", "Peer Memory company "),
    ]
      .filter((text) => text !== "")
      .join("\n");
  });
  const prepareSession = Effect.fn("MemoryService.prepareSession")(function* (
    session: MemorySession,
    source: string,
  ) {
    const identity = yield* transport.identity;
    yield* synchronizeIdentity(identity, session).pipe(
      Effect.catchTag("MemoryError", (error) =>
        error.code === "unavailable" ? Effect.succeed(undefined) : Effect.fail(error),
      ),
    );
    const authorization = yield* authorize(identity, session).pipe(Effect.result);
    if (authorization._tag === "Failure" && authorization.failure.code !== "unavailable")
      return yield* authorization.failure;
    const offerProjection = authorization._tag === "Success";
    const local = yield* ensureSession(identity, session);
    const currentPath = NodePath.join(local.current.directory, "current.md");
    const template = `# Private working context\n\nWork: ${session.workId}\n\n## Goal\n\n## Notes\n\n## Selected memory\n`;
    yield* disk(() => createOnce(currentPath, template));
    if (source === "resume" && local.current.projections.length === 0) {
      const previous = local.state.sessions
        .toReversed()
        .find(
          (entry) =>
            entry.sessionId === session.sessionId &&
            entry.workId === session.workId &&
            entry.runtimeGeneration !== session.runtimeGeneration,
        );
      if (
        previous !== undefined &&
        (yield* disk(() => NodeFSP.readFile(currentPath, "utf8"))) === template
      ) {
        // A provider explicitly resumes this same user's runtime. Preserve its own notes and
        // selected versions; another session's notes never become a handoff artifact.
        yield* disk(async () => {
          await atomicWrite(
            currentPath,
            await NodeFSP.readFile(NodePath.join(previous.directory, "current.md"), "utf8"),
          );
          for (const projection of offerProjection ? previous.projections : [])
            for (const filename of [
              `projection.${part(projection.id)}.md`,
              `manifest.${part(projection.id)}.json`,
            ])
              await createImmutable(
                NodePath.join(local.current.directory, filename),
                await NodeFSP.readFile(NodePath.join(previous.directory, filename), "utf8"),
              );
        });
        local.current = {
          ...local.current,
          selected: previous.selected,
          projections: offerProjection ? previous.projections : [],
          critical: previous.critical,
          changed: previous.changed,
        };
        local.state = {
          ...local.state,
          sessions: local.state.sessions.map((entry) =>
            sessionKey(entry) === sessionKey(session) ? local.current : entry,
          ),
        };
        yield* save(local.directory, local.state);
      }
    }
    if (source === "compact" || source === "resume") {
      const checkpointPath = NodePath.join(
        local.current.directory,
        "checkpoints",
        `${NodeCrypto.randomUUID()}.md`,
      );
      yield* disk(async () =>
        atomicWrite(checkpointPath, await NodeFSP.readFile(currentPath, "utf8")),
      );
    }
    if (source === "resume" && session.project !== "company") {
      const company = { ...session, project: "company" };
      const saved = yield* load(identity, company);
      const existing = saved.state.sessions.find(
        (entry) => sessionKey(entry) === sessionKey(session),
      );
      const previous = saved.state.sessions
        .toReversed()
        .find(
          (entry) =>
            entry.sessionId === session.sessionId &&
            entry.workId === session.workId &&
            entry.runtimeGeneration !== session.runtimeGeneration,
        );
      if (
        existing === undefined &&
        previous !== undefined &&
        (yield* authorize(identity, company).pipe(Effect.result))._tag === "Success"
      ) {
        const destination = yield* ensureSession(identity, company);
        yield* disk(async () => {
          for (const projection of previous.projections)
            for (const filename of [
              `projection.${part(projection.id)}.md`,
              `manifest.${part(projection.id)}.json`,
            ])
              await createImmutable(
                NodePath.join(local.current.directory, filename),
                await NodeFSP.readFile(NodePath.join(previous.directory, filename), "utf8"),
              );
        });
        yield* save(destination.directory, {
          ...destination.state,
          sessions: destination.state.sessions.map((entry) =>
            sessionKey(entry) === sessionKey(session)
              ? {
                  ...entry,
                  directory: local.current.directory,
                  selected: previous.selected,
                  projections: previous.projections,
                  critical: previous.critical,
                  changed: previous.changed,
                }
              : entry,
          ),
        });
      }
    }
    return {
      mode: local.state.mode,
      currentPath,
      notice: [
        noticeOf(local.current, true, offerProjection, !local.state.available),
        yield* companyNotice(identity, session),
      ]
        .filter((text) => text !== "")
        .join("\n"),
    };
  }, lock.withPermits(1));
  const projectForSession = Effect.fn("MemoryService.projectForSession")(function* (
    session: MemorySession,
    projection: PeerHubMemoryProjectInput["projection"],
    targetScope?: PeerMemoryScope,
  ) {
    const reading = yield* readingSession(session, targetScope);
    const local = yield* fresh(reading);
    const value = yield* transport
      .request(local.identity, reading, "POST", "/projections", PeerMemoryProjection, projection)
      .pipe(Effect.flatMap((result) => verifyProjection(local.identity, reading, result)));
    const current = yield* ensureSession(local.identity, reading);
    const owner =
      reading.project === session.project ? current : yield* ensureSession(local.identity, session);
    const projectionPath = NodePath.join(
      owner.current.directory,
      `projection.${part(value.manifest.id)}.md`,
    );
    const manifestPath = NodePath.join(
      owner.current.directory,
      `manifest.${part(value.manifest.id)}.json`,
    );
    const currentPath = NodePath.join(owner.current.directory, "current.md");
    yield* disk(async () => {
      await createImmutable(projectionPath, value.text);
      await createImmutable(manifestPath, encodeManifest(value.manifest));
      await createOnce(currentPath, value.text);
    });
    const next: LocalSession = {
      ...current.current,
      directory: owner.current.directory,
      selected: coalesceRefs([...current.current.selected, ...value.manifest.selected]),
      projections: [
        ...current.current.projections.filter((entry) => entry.id !== value.manifest.id),
        {
          id: value.manifest.id,
          at: value.manifest.createdAt,
          selected: value.manifest.selected,
          memoryWatermark: value.manifest.memoryWatermark,
        },
      ],
    };
    yield* save(current.directory, {
      ...current.state,
      sessions: current.state.sessions.map((entry) =>
        sessionKey(entry) === sessionKey(session) ? next : entry,
      ),
    });
    // Receiving a bundle in the host is a request. Hook output or logging alone proves no delivery.
    yield* transport
      .request(local.identity, reading, "POST", "/receipts", PeerMemoryReceipt, {
        projectionId: value.manifest.id,
        records: value.manifest.selected,
        state: "requested",
        sessionId: session.sessionId,
        environmentId: session.environmentId,
        runtimeGeneration: session.runtimeGeneration,
        runtimeProjectId: session.project,
      })
      .pipe(Effect.catchTag("MemoryError", () => Effect.succeed(undefined)));
    return { projection: value, projectionPath, manifestPath, currentPath };
  }, lock.withPermits(1));
  const checkpoint = Effect.fn("MemoryService.checkpoint")(function* (
    session: MemorySession,
    reason: string,
  ) {
    const local = yield* ensureSession(yield* transport.identity, session);
    const path = NodePath.join(
      local.current.directory,
      "checkpoints",
      `${NodeCrypto.randomUUID()}.md`,
    );
    yield* disk(async () => {
      await atomicWrite(
        path,
        await NodeFSP.readFile(NodePath.join(local.current.directory, "current.md"), "utf8"),
      );
      await atomicWrite(
        `${path}.json`,
        JSON.stringify({ reason, selected: local.current.selected }),
      );
    });
    return { path };
  }, lock.withPermits(1));
  const restoreCheckpoint = Effect.fn("MemoryService.restoreCheckpoint")(function* (
    session: MemorySession,
    name: string,
  ) {
    const local = yield* ensureSession(yield* transport.identity, session);
    if (!/^[a-f0-9-]+\.md$/.test(name))
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail: "Select a checkpoint filename from this runtime's own checkpoints.",
      });
    const path = NodePath.join(local.current.directory, "current.md");
    yield* disk(async () => {
      const saved = await NodeFSP.readFile(
        NodePath.join(local.current.directory, "checkpoints", name),
        "utf8",
      );
      await atomicWrite(
        NodePath.join(local.current.directory, "checkpoints", `${NodeCrypto.randomUUID()}.md`),
        await NodeFSP.readFile(path, "utf8"),
      );
      await atomicWrite(path, saved);
    });
    return { path };
  }, lock.withPermits(1));
  const sessionNotice = Effect.fn("MemoryService.sessionNotice")(function* (
    session: MemorySession,
  ) {
    const identity = yield* transport.identity;
    yield* authorize(identity, session);
    return [
      noticeOf((yield* ensureSession(identity, session)).current, false),
      yield* companyNotice(identity, session),
    ]
      .filter((text) => text !== "")
      .join("\n");
  }, lock.withPermits(1));
  const receipt = Effect.fn("MemoryService.receipt")(function* (
    session: MemorySession,
    input: Omit<PeerMemoryReceiptInput, "sessionId" | "environmentId" | "runtimeGeneration">,
    targetScope?: PeerMemoryScope,
  ) {
    if (input.state === "consumed" && input.records.length === 0)
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail: "Consumption needs an actual selected record version.",
      });
    if (
      (input.state === "delivered" || input.state === "consumed") &&
      (input.outputRef === undefined ||
        input.outputRef.weak ||
        input.outputRef.result === undefined ||
        (input.outputRef.outputHash === undefined && input.outputRef.revision === undefined))
    )
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail: "Delivery and consumption need concrete runtime acceptance or result evidence.",
      });
    const identity = yield* transport.identity;
    const reading = yield* readingSession(session, targetScope);
    yield* authorize(identity, reading);
    const local = yield* ensureSession(identity, reading);
    const projection = local.current.projections.find((entry) => entry.id === input.projectionId);
    if (
      (input.state === "acknowledged" || input.state === "consumed") &&
      (projection === undefined ||
        input.records.length !== projection.selected.length ||
        !projection.selected.every((selected) =>
          input.records.some((ref) => ref.id === selected.id && ref.version === selected.version),
        ))
    )
      return yield* new MemoryTransport.MemoryError({
        code: "invalid",
        detail:
          "Acknowledge an exact local projection with its projectionId and every selected record version.",
      });
    const bound = {
      ...input,
      sessionId: session.sessionId,
      environmentId: session.environmentId,
      runtimeGeneration: session.runtimeGeneration,
      runtimeProjectId: session.project,
    };
    if (input.state === "acknowledged" || input.state === "consumed") {
      // This incoming live CLI/MCP command is actual runtime acceptance of the exact bundle.
      // Replaying a stage is idempotent; a lost response does not invent a delivery.
      const proof = {
        kind: "artifact" as const,
        weak: false,
        environment: session.environmentId,
        command: "peer memory acknowledge",
        result: "The live runtime acknowledged the exact projection and record versions.",
        outputHash: hash(
          JSON.stringify({
            sessionId: session.sessionId,
            runtimeGeneration: session.runtimeGeneration,
            projectionId: input.projectionId,
            records: input.records,
          }),
        ),
      };
      yield* transport.request(identity, reading, "POST", "/receipts", PeerMemoryReceipt, {
        ...bound,
        state: "requested",
        outputRef: undefined,
      });
      yield* transport.request(identity, reading, "POST", "/receipts", PeerMemoryReceipt, {
        ...bound,
        state: "delivered",
        outputRef: proof,
      });
      if (input.state === "consumed")
        yield* transport.request(identity, reading, "POST", "/receipts", PeerMemoryReceipt, {
          ...bound,
          state: "acknowledged",
          outputRef: undefined,
        });
    }
    const result = yield* transport.request(
      identity,
      reading,
      "POST",
      "/receipts",
      PeerMemoryReceipt,
      bound,
    );
    if (input.state === "acknowledged" || input.state === "consumed") {
      const local = yield* ensureSession(identity, reading);
      const acknowledged = (change: typeof PeerMemoryChange.Type) =>
        (change.type === "resync_required" &&
          projection?.memoryWatermark !== undefined &&
          projection.memoryWatermark >= change.cursor) ||
        input.records.some((ref) => ref.id === change.id && ref.version >= change.version);
      yield* save(local.directory, {
        ...local.state,
        sessions: local.state.sessions.map((entry) =>
          sessionKey(entry) === sessionKey(session)
            ? {
                ...entry,
                critical: entry.critical.filter((change) => !acknowledged(change)),
                changed: entry.changed.filter((change) => !acknowledged(change)),
              }
            : entry,
        ),
      });
    }
    return result;
  }, lock.withPermits(1));
  const endSession = Effect.fn("MemoryService.endSession")(function* (session: MemorySession) {
    const identity = yield* transport.identity;
    for (const scope of [
      session,
      ...(session.project === "company" ? [] : [{ ...session, project: "company" }]),
    ]) {
      const local = yield* load(identity, scope);
      if (!local.state.sessions.some((entry) => sessionKey(entry) === sessionKey(session)))
        continue;
      yield* save(local.directory, {
        ...local.state,
        sessions: local.state.sessions.map((entry) =>
          sessionKey(entry) === sessionKey(session) ? { ...entry, ended: true } : entry,
        ),
      });
    }
  }, lock.withPermits(1));
  const legacySnapshot = Effect.fn("MemoryService.legacySnapshot")(function* (
    session: MemorySession,
    text: string,
    source: string,
  ) {
    if ((yield* state(session)).mode !== "shadow" || text.trim() === "") return;
    for (const claim of text.split("\n").filter((line) => line.trim() !== "")) {
      yield* execute({
        workspace: session.workspace,
        project: session.project,
        command: {
          schemaVersion: 1,
          operationId: `legacy:${hash(`${session.sessionId}/${source}/${claim}`)}`,
          type: "assertion.record",
          sessionId: session.sessionId,
          environmentId: session.environmentId,
          runtimeGeneration: session.runtimeGeneration,
          workId: session.workId,
          ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
          claim,
          contextIds: [],
          independence: "unknown",
          derivedFrom: [],
          evidence: [
            {
              kind: "legacy",
              weak: true,
              command: `Marked legacy ${source} excerpt`,
              outputHash: hash(claim),
              result: "Imported legacy excerpt; source confidence is unknown.",
            },
          ],
        },
      });
    }
  });
  const keep = Effect.fn("MemoryService.keep")(function* (input: PeerHubMemoryKeepInput) {
    const auth = yield* MemoryTransport.MemoryAuth;
    const repository = yield* auth.repository(input, input.repositoryId);
    const view = yield* read({ ...input, version: input.expectedVersion });
    const identity = yield* transport.identity;
    yield* authorize(identity, input);
    const staged = yield* MemoryKnowledge.keep(repository.root, view.record, input.path);
    const operation = yield* execute({
      workspace: input.workspace,
      project: input.project,
      command: {
        schemaVersion: 1,
        operationId: `keep:${hash(`${input.id}/${input.expectedVersion}/${staged.path}`)}`,
        type: "knowledge.keep",
        id: input.id,
        expectedVersion: input.expectedVersion,
        path: staged.path,
        applicability: { ...view.record.applicability, repositoryId: input.repositoryId },
      },
    });
    return { status: "kept_pending_review" as const, path: staged.path, operation };
  });
  const importKnowledge = Effect.fn("MemoryService.importKnowledge")(function* (
    input: PeerHubMemoryImportKnowledgeInput,
  ) {
    const auth = yield* MemoryTransport.MemoryAuth;
    const repository = yield* auth.repository(input, input.repositoryId);
    const identity = yield* transport.identity;
    yield* authorize(identity, input);
    const commands = yield* MemoryKnowledge.importCommands(repository, input);
    const operations: PeerMemoryWriteResult[] = [];
    for (const command of commands)
      operations.push(
        yield* execute({ workspace: input.workspace, project: input.project, command }),
      );
    return { operations };
  });
  return MemoryService.of({
    state,
    mode,
    setMode,
    execute,
    search,
    read,
    project,
    changes,
    receipts,
    queue,
    retry,
    discard,
    synchronize,
    prepareSession,
    projectForSession,
    checkpoint,
    restoreCheckpoint,
    sessionNotice,
    receipt,
    endSession,
    legacySnapshot,
    keep,
    importKnowledge,
  });
});
const coalesceRefs = (refs: ReadonlyArray<PeerMemoryRecordRef>) => {
  const unique = new Map<string, PeerMemoryRecordRef>();
  for (const ref of refs) unique.set(`${ref.id}@${ref.version}`, ref);
  return [...unique.values()];
};

export const layer = Layer.effect(MemoryService, make);
