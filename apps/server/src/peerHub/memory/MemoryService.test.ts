// @effect-diagnostics nodeBuiltinImport:off - isolated temporary client state.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PeerMemoryCommand,
  type PeerMemoryCommandResult,
  type PeerMemoryProjection,
  type PeerMemoryRecord,
  type PeerMemoryReceipt,
  type PeerMemoryReceiptInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as MemoryService from "./MemoryService.ts";
import * as MemoryTransport from "./MemoryTransport.ts";

const scope = { workspace: "acme", project: "app" };
const at = "2026-10-06T09:00:00Z";
const reference = { id: "assertion-1", version: 1 };
const decodeCommand = Schema.decodeUnknownEffect(PeerMemoryCommand);
const encodeReceiptKey = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      projectionId: Schema.optional(Schema.String),
      records: Schema.Array(Schema.Struct({ id: Schema.String, version: Schema.Number })),
      state: Schema.String,
      sessionId: Schema.String,
      environmentId: Schema.String,
      runtimeGeneration: Schema.String,
      runtimeProjectId: Schema.optional(Schema.String),
      outputRef: Schema.optional(Schema.Unknown),
    }),
  ),
);
const record: PeerMemoryRecord = {
  ...reference,
  schemaVersion: 1,
  workspaceId: "acme",
  projectId: "app",
  kind: "assertion",
  title: "Dates",
  text: "Hotel-local dates",
  aliases: [],
  createdBy: { email: "ana@acme.test" },
  createdAt: at,
  knownAt: at,
  recordedAt: at,
  applicability: {},
  sourceRefs: [],
  derivedFrom: [],
  operationId: "remember-1",
  contentHash: "record-hash",
  lifecycle: "active",
  grounding: "proposed",
  independence: "unknown",
  evidenceIds: [],
  evidenceMissing: true,
};
const command: PeerMemoryCommand = {
  schemaVersion: 1,
  operationId: "remember-1",
  type: "assertion.record",
  claim: record.text,
  contextIds: [],
  evidence: [],
};
const session: MemoryService.MemorySession = {
  ...scope,
  sessionId: "claude:one",
  environmentId: "test",
  runtimeGeneration: "generation-1",
  workId: "work-one",
  taskId: "task-one",
  adapter: "claude",
  repositoryId: "repo",
  root: "/unused",
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});
const temporary = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-memory-client-"));
  roots.push(root);
  return root;
};

class Hub {
  offline = false;
  memoryOffline = false;
  companyDenied = false;
  revoked = false;
  committedButResponseLost = false;
  email = "ana@acme.test";
  token = "hub-session-1";
  calls = 0;
  projectionNumber = 0;
  cursor = 0;
  rejectCommand = false;
  mode: "legacy" | "shadow" | "memory" = "memory";
  readonly registered = new Set<string>();
  readonly commands = new Map<string, PeerMemoryCommandResult>();
  readonly receipts: PeerMemoryReceipt[] = [];
  readonly receiptScopes: string[] = [];
  companyVersion = 1;
  companyCursor = 0;
  companyEvents: typeof this.events = [];
  resyncRequired = false;
  projectionSelected: ReadonlyArray<{ readonly id: string; readonly version: number }> | undefined;
  events: Array<{
    cursor: number;
    id: string;
    version: number;
    type: string;
    critical: boolean;
    affectedRecordIds?: string[];
    at: string;
  }> = [];

  readonly transport = MemoryTransport.MemoryTransport.of({
    identity: Effect.sync(() => ({
      hubUrl: "https://hub.test",
      email: this.email,
      token: this.token,
      environmentId: "test",
    })),
    authorize: () =>
      Effect.suspend(() =>
        this.offline
          ? Effect.fail(new MemoryTransport.MemoryError({ code: "unavailable", detail: "offline" }))
          : this.revoked
            ? Effect.fail(
                new MemoryTransport.MemoryError({ code: "not_found", detail: "no access" }),
              )
            : Effect.void,
      ),
    request: (identity, scope, method, path, schema, body) =>
      Effect.gen({ self: this }, function* () {
        this.calls += 1;
        if (this.offline)
          return yield* new MemoryTransport.MemoryError({ code: "unavailable", detail: "offline" });
        if (this.memoryOffline && path !== "/mode" && !path.includes("/coord"))
          return yield* new MemoryTransport.MemoryError({
            code: "unavailable",
            detail: "memory backend offline",
          });
        if (scope.project === "company" && this.companyDenied && path === "/mode")
          return yield* new MemoryTransport.MemoryError({
            code: "not_found",
            detail: "company scope unavailable",
          });
        let output: unknown;
        const company = scope.project === "company";
        const selected = company
          ? { id: "company-assertion-1", version: this.companyVersion }
          : reference;
        const scopedRecord = { ...record, ...selected, projectId: scope.project };
        const cursor = company ? this.companyCursor : this.cursor;
        if (path === "/v1/workspaces/acme/coord") {
          const report = body as {
            historicalSessions: Array<{ id: string; runtimeGeneration: string }>;
            sessions?: unknown;
          };
          expect(report.sessions).toBeUndefined();
          for (const entry of report.historicalSessions)
            this.registered.add(`${entry.id}/${entry.runtimeGeneration}`);
          output = {};
        } else if (path === "/mode") output = { mode: this.mode };
        else if (path === "/commands") {
          const input = yield* decodeCommand(body).pipe(Effect.orDie);
          if (this.rejectCommand)
            return yield* new MemoryTransport.MemoryError({
              code: "conflict",
              detail: "expectedVersion changed",
            });
          if (
            input.sessionId !== undefined &&
            !this.registered.has(`${input.sessionId}/${input.runtimeGeneration}`)
          )
            return yield* new MemoryTransport.MemoryError({
              code: "invalid",
              detail: "unregistered generation",
            });
          const previous = this.commands.get(input.operationId);
          if (previous === undefined) {
            this.cursor += 1;
            this.commands.set(input.operationId, {
              operationId: input.operationId,
              replayed: false,
              records: [record],
              cursor: this.cursor,
              topologyRevision: 0,
            });
          }
          if (this.committedButResponseLost) {
            this.committedButResponseLost = false;
            return yield* new MemoryTransport.MemoryError({
              code: "unavailable",
              detail: "response lost",
            });
          }
          output = { ...this.commands.get(input.operationId)!, replayed: previous !== undefined };
        } else if (path.startsWith("/changes")) {
          const after = Number(new URL(`https://hub.test${path}`).searchParams.get("after"));
          output = {
            changes: (company ? this.companyEvents : this.events).filter(
              (event) => event.cursor > after,
            ),
            cursor,
            hasMore: false,
            resyncRequired: this.resyncRequired,
          };
          this.resyncRequired = false;
        } else if (path === "/search")
          output = {
            records: [{ record: scopedRecord, whyIncluded: ["search match"], conflicts: [] }],
            cursor: 1,
            hasMore: false,
            memoryWatermark: this.cursor,
            policyVersion: "peer-memory-v1",
          };
        else if (path.startsWith("/records/"))
          output = { record: scopedRecord, history: [scopedRecord], conflicts: [], related: [] };
        else if (path === "/projections") {
          const text = `Projection ${++this.projectionNumber}: ${this.projectionSelected?.length === 0 ? "No shared records selected." : record.text}`;
          output = {
            text,
            manifest: {
              id: `projection-${this.projectionNumber}`,
              schemaVersion: 1,
              createdAt: at,
              selected: this.projectionSelected ?? [selected],
              contentHash: NodeCrypto.createHash("sha256").update(text).digest("hex"),
              policyVersion: "peer-memory-v1",
              requested: body as PeerMemoryProjection["manifest"]["requested"],
              workspaceId: "acme",
              projectId: scope.project,
              permissionScope: {
                email: identity.email,
                workspaceId: "acme",
                projectId: scope.project,
              },
              memoryWatermark: cursor,
              tokenEstimate: 20,
              tokenEstimateMethod: "chars/4",
              omitted: [],
            },
          } satisfies PeerMemoryProjection;
        } else if (path === "/receipts" && method === "POST") {
          const input = body as PeerMemoryReceiptInput;
          this.receiptScopes.push(scope.project);
          const key = yield* encodeReceiptKey(input).pipe(Effect.orDie);
          const id = NodeCrypto.createHash("sha256").update(key).digest("hex");
          const previous = this.receipts.find((receipt) => receipt.id === id);
          const receipt = previous ?? {
            id,
            state: input.state,
            at,
            createdBy: {
              email: identity.email,
              sessionId: input.sessionId,
              environmentId: input.environmentId,
              runtimeGeneration: input.runtimeGeneration,
            },
            records: input.records,
            ...(input.runtimeProjectId === undefined
              ? {}
              : { runtimeProjectId: input.runtimeProjectId }),
            ...(input.projectionId === undefined ? {} : { projectionId: input.projectionId }),
            ...(input.outputRef === undefined ? {} : { outputRef: input.outputRef }),
          };
          if (previous === undefined) this.receipts.push(receipt);
          output = receipt;
        } else throw new Error(`Unexpected request ${method} ${path}`);
        return yield* Schema.decodeUnknownEffect(schema)(output).pipe(Effect.orDie);
      }),
  });
}
const withMemory = <A, E>(
  root: string,
  hub: Hub,
  use: (memory: MemoryService.MemoryService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const memory = yield* MemoryService.MemoryService;
      return yield* use(memory);
    }).pipe(
      Effect.provide(
        MemoryService.layer.pipe(
          Layer.provide(Layer.succeed(MemoryTransport.MemoryTransport, hub.transport)),
          Layer.provide(ServerConfig.layerTest(root, root).pipe(Layer.provide(NodeServices.layer))),
        ),
      ),
    ),
  );

describe("Peer memory durable client", () => {
  it.effect(
    "notices a new contradiction edge while the selected assertion remains version one",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const initial = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "dates" }),
        );
        const opposition = { id: "assertion-opposition", version: 1 };
        const edge = { id: "relation-contradicts", version: 1 };
        hub.cursor = 2;
        hub.events = [
          {
            cursor: 1,
            ...opposition,
            type: "assertion.record",
            critical: true,
            affectedRecordIds: [opposition.id],
            at,
          },
          {
            cursor: 2,
            ...edge,
            type: "assertion.dispute",
            critical: true,
            affectedRecordIds: [reference.id, opposition.id],
            at,
          },
        ];
        yield* withMemory(root, hub, (memory) => memory.synchronize(scope));
        expect(yield* withMemory(root, hub, (memory) => memory.sessionNotice(session))).toContain(
          `${edge.id}@1`,
        );
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(session, {
            state: "acknowledged",
            projectionId: initial.projection.manifest.id,
            records: initial.projection.manifest.selected,
          }),
        );
        expect(yield* withMemory(root, hub, (memory) => memory.sessionNotice(session))).toContain(
          `${edge.id}@1`,
        );
        hub.projectionSelected = [reference, opposition, edge];
        const fresh = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "read the dispute" }),
        );
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(session, {
            state: "acknowledged",
            projectionId: fresh.projection.manifest.id,
            records: fresh.projection.manifest.selected,
          }),
        );
        expect(
          yield* withMemory(root, hub, (memory) => memory.sessionNotice(session)),
        ).not.toContain("critical");
      }),
  );

  it.effect(
    "purges unvalidated shared files after retention loss and clears resync only with a fresh empty projection",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const initial = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "before erase" }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(initial.currentPath, "Private reasoning I own"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(initial.manifestPath, "corrupted cached manifest"),
        );
        hub.cursor = 8;
        hub.resyncRequired = true;
        hub.events = [];
        hub.projectionSelected = [];
        yield* withMemory(root, hub, (memory) => memory.synchronize(scope));
        for (const path of [initial.projectionPath, initial.manifestPath])
          expect(
            yield* Effect.promise(() =>
              NodeFSP.access(path).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false);
        const resumed = { ...session, runtimeGeneration: "resync-resumed" };
        const prepared = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(resumed, "resume"),
        );
        expect(prepared.notice).toContain("resync_required");
        expect(prepared.notice).not.toContain("Latest immutable projection");
        expect(yield* Effect.promise(() => NodeFSP.readFile(prepared.currentPath, "utf8"))).toBe(
          "Private reasoning I own",
        );
        const staleAck = yield* withMemory(root, hub, (memory) =>
          memory.receipt(resumed, {
            state: "acknowledged",
            projectionId: initial.projection.manifest.id,
            records: initial.projection.manifest.selected,
          }),
        ).pipe(Effect.flip);
        expect(staleAck).toMatchObject({ code: "invalid" });
        const fresh = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(resumed, {
            include: [],
            purpose: "resync after the last shared record was erased",
          }),
        );
        expect(fresh.projection.manifest.memoryWatermark).toBe(8);
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(resumed, {
            state: "acknowledged",
            projectionId: fresh.projection.manifest.id,
            records: [],
          }),
        );
        expect(
          yield* withMemory(root, hub, (memory) => memory.sessionNotice(resumed)),
        ).not.toContain("resync_required");
        const consumed = yield* withMemory(root, hub, (memory) =>
          memory.receipt(resumed, {
            state: "consumed",
            projectionId: fresh.projection.manifest.id,
            records: [],
            outputRef: {
              kind: "artifact",
              weak: false,
              outputHash: "output-hash",
              result: "completed",
            },
          }),
        ).pipe(Effect.flip);
        expect(consumed).toMatchObject({ code: "invalid" });
      }),
  );

  it.effect(
    "preserves private notes offline while shared projection offers and resume copies require current ACL",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const initial = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "cached context" }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(initial.currentPath, "Private notes usable offline"),
        );
        hub.offline = true;
        const existing = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "resume"),
        );
        expect(existing.notice).not.toContain("Latest immutable projection");
        const resumed = { ...session, runtimeGeneration: "acl-offline-resumed" };
        const prepared = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(resumed, "resume"),
        );
        expect(prepared.notice).not.toContain("Latest immutable projection");
        expect(yield* Effect.promise(() => NodeFSP.readFile(prepared.currentPath, "utf8"))).toBe(
          "Private notes usable offline",
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(
              NodePath.join(
                NodePath.dirname(prepared.currentPath),
                NodePath.basename(initial.projectionPath),
              ),
            ).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
        hub.offline = false;
        hub.memoryOffline = true;
        const availableAcl = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "resume"),
        );
        expect(availableAcl.notice).toContain(
          "Latest immutable projection (stale; memory unavailable)",
        );
      }),
  );

  it.effect(
    "does not offer or copy company shared files when its memory endpoint denies a still-visible workspace",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const owner = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "startup"),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(owner.currentPath, "Private project notes"));
        const initial = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(
            session,
            { include: [{ id: "company-assertion-1", version: 1 }], purpose: "company context" },
            { workspace: "acme", project: "company" },
          ),
        );
        hub.companyDenied = true;
        expect(
          yield* withMemory(root, hub, (memory) => memory.sessionNotice(session)),
        ).not.toContain("company projection");
        const resumed = { ...session, runtimeGeneration: "company-denied-resumed" };
        const prepared = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(resumed, "resume"),
        );
        expect(prepared.notice).not.toContain("company projection");
        expect(yield* Effect.promise(() => NodeFSP.readFile(prepared.currentPath, "utf8"))).toBe(
          "Private project notes",
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.access(
              NodePath.join(
                NodePath.dirname(prepared.currentPath),
                NodePath.basename(initial.projectionPath),
              ),
            ).then(
              () => true,
              () => false,
            ),
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    "projects company memory without replacing own notes and tracks the actual source runtime",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const company = { workspace: "acme", project: "company" };
        const selected = { id: "company-assertion-1", version: 1 };
        const owner = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "startup"),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(owner.currentPath, "Private project reasoning"),
        );
        const bundle = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(
            session,
            { include: [selected], purpose: "company convention" },
            company,
          ),
        );
        expect(bundle.currentPath).toBe(owner.currentPath);
        expect(NodePath.dirname(bundle.projectionPath)).toBe(NodePath.dirname(owner.currentPath));
        expect(bundle.projection.manifest.projectId).toBe("company");
        expect(yield* Effect.promise(() => NodeFSP.readFile(owner.currentPath, "utf8"))).toBe(
          "Private project reasoning",
        );
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(
            session,
            {
              state: "acknowledged",
              projectionId: bundle.projection.manifest.id,
              records: [selected],
              runtimeProjectId: "forged-project",
            },
            company,
          ),
        );
        expect(hub.receiptScopes.every((project) => project === "company")).toBe(true);
        expect(hub.receipts.every((receipt) => receipt.runtimeProjectId === "app")).toBe(true);
        expect(
          hub.receipts.every(
            (receipt) => receipt.createdBy.runtimeGeneration === session.runtimeGeneration,
          ),
        ).toBe(true);
        hub.companyVersion = 2;
        hub.companyCursor = 1;
        hub.companyEvents = [
          { cursor: 1, id: selected.id, version: 2, type: "assertion.dispute", critical: true, at },
        ];
        yield* withMemory(root, hub, (memory) => memory.synchronize(company));
        const notice = yield* withMemory(root, hub, (memory) => memory.sessionNotice(session));
        expect(notice).toContain("Peer Memory company critical");
        expect(notice).toContain(`${selected.id}@2`);
        const resumed = { ...session, runtimeGeneration: "company-resumed-generation" };
        const prepared = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(resumed, "resume"),
        );
        expect(prepared.notice).toContain(`${selected.id}@2`);
        expect(yield* Effect.promise(() => NodeFSP.readFile(prepared.currentPath, "utf8"))).toBe(
          "Private project reasoning",
        );
        const fresh = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(
            resumed,
            {
              include: [{ ...selected, version: 2 }],
              purpose: "recheck company correction",
            },
            company,
          ),
        );
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(
            resumed,
            {
              state: "acknowledged",
              projectionId: fresh.projection.manifest.id,
              records: fresh.projection.manifest.selected,
            },
            company,
          ),
        );
        expect(
          yield* withMemory(root, hub, (memory) => memory.sessionNotice(resumed)),
        ).not.toContain("critical");
        const wrong = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(
            resumed,
            {
              include: [selected],
              purpose: "unavailable scope",
            },
            { workspace: "other", project: "company" },
          ),
        ).pipe(Effect.flip);
        expect(wrong).toMatchObject({ code: "invalid" });
      }),
  );

  it.effect(
    "keeps offline findings through restart and session end and retries the original operation",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        hub.offline = true;
        const queued = yield* withMemory(root, hub, (memory) =>
          memory.execute({
            ...scope,
            command: {
              ...command,
              sessionId: session.sessionId,
              environmentId: session.environmentId,
              runtimeGeneration: session.runtimeGeneration,
            },
          }),
        );
        expect(queued.status).toBe("pending_local");
        expect(hub.commands.size).toBe(0);
        yield* withMemory(root, hub, (memory) => memory.endSession(session));
        hub.offline = false;
        const state = yield* withMemory(root, hub, (memory) => memory.synchronize(scope));
        expect(state.pendingLocal).toBe(0);
        expect(hub.commands.size).toBe(1);
        expect(hub.commands.has(command.operationId)).toBe(true);
        expect(hub.registered.has(`${session.sessionId}/${session.runtimeGeneration}`)).toBe(true);
      }),
  );

  it.effect(
    "replays an acknowledged database commit whose network response was lost without a duplicate",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        hub.committedButResponseLost = true;
        expect(
          (yield* withMemory(root, hub, (memory) => memory.execute({ ...scope, command }))).status,
        ).toBe("pending_local");
        expect(hub.commands.size).toBe(1);
        expect(
          (yield* withMemory(root, hub, (memory) => memory.synchronize(scope))).pendingLocal,
        ).toBe(0);
        expect(hub.commands.size).toBe(1);
      }),
  );

  it.effect(
    "keeps own notes intact across refresh and creates immutable manifests and checkpoints",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const first = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "fix dates" }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(first.currentPath, "My own reasoning and notes."),
        );
        const second = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "refresh dates" }),
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(second.currentPath, "utf8"))).toBe(
          "My own reasoning and notes.",
        );
        expect(first.projectionPath).not.toBe(second.projectionPath);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(first.projectionPath, "utf8")),
        ).toContain("Projection 1");
        const checkpoint = yield* withMemory(root, hub, (memory) =>
          memory.checkpoint(session, "before compaction"),
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(checkpoint.path, "utf8"))).toBe(
          "My own reasoning and notes.",
        );
        expect(hub.receipts.every((receipt) => receipt.state === "requested")).toBe(true);
        const stat = yield* Effect.promise(() => NodeFSP.stat(second.currentPath));
        expect(stat.mode & 0o777).toBe(0o600);
      }),
  );

  it.effect(
    "requires exact projection acceptance before recording actual delivery and preserves output proof",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const bundle = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "understand dates" }),
        );
        expect(hub.receipts.map((receipt) => receipt.state)).toEqual(["requested"]);
        const wrong = yield* withMemory(root, hub, (memory) =>
          memory
            .receipt(session, {
              projectionId: bundle.projection.manifest.id,
              records: [],
              state: "acknowledged",
            })
            .pipe(Effect.result),
        );
        expect(wrong._tag).toBe("Failure");
        expect(hub.receipts).toHaveLength(1);
        yield* withMemory(root, hub, (memory) =>
          memory.receipt(session, {
            projectionId: bundle.projection.manifest.id,
            records: bundle.projection.manifest.selected,
            state: "acknowledged",
          }),
        );
        expect(hub.receipts.map((receipt) => receipt.state)).toEqual([
          "requested",
          "delivered",
          "acknowledged",
        ]);
        const incomplete = yield* withMemory(root, hub, (memory) =>
          memory
            .receipt(session, {
              projectionId: bundle.projection.manifest.id,
              records: bundle.projection.manifest.selected,
              state: "consumed",
            })
            .pipe(Effect.result),
        );
        expect(incomplete._tag).toBe("Failure");
      }),
  );

  it.effect(
    "keeps a blocked original payload and supports explicit retry and durable discard",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        hub.rejectCommand = true;
        const failed = yield* withMemory(root, hub, (memory) =>
          memory.execute({ ...scope, command }).pipe(Effect.result),
        );
        expect(failed._tag).toBe("Failure");
        const queued = yield* withMemory(root, hub, (memory) => memory.queue(scope));
        expect(queued.operations[0]?.status).toBe("blocked");
        expect(queued.operations[0]?.command).toEqual(command);
        hub.rejectCommand = false;
        const retried = yield* withMemory(root, hub, (memory) =>
          memory.retry({ ...scope, operationId: command.operationId }),
        );
        expect(retried.status).toBe("stored");
        expect(
          (yield* withMemory(root, hub, (memory) => memory.queue(scope))).operations,
        ).toHaveLength(0);
        hub.offline = true;
        yield* withMemory(root, hub, (memory) =>
          memory.execute({ ...scope, command: { ...command, operationId: "cancel-me" } }),
        );
        yield* withMemory(root, hub, (memory) =>
          memory.discard({
            ...scope,
            operationId: "cancel-me",
            reason: "Replace with a corrected observation",
          }),
        );
        expect(
          (yield* withMemory(root, hub, (memory) => memory.queue(scope))).operations,
        ).toHaveLength(0);
      }),
  );

  it.effect(
    "restores this same runtime's notes and critical notices into an explicit resumed generation",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const first = yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "resume" }),
        );
        yield* Effect.promise(() =>
          NodeFSP.writeFile(first.currentPath, "Private notes retained after restarting Peer."),
        );
        hub.cursor = 2;
        hub.events = [
          { id: reference.id, version: 2, cursor: 2, type: "record.retract", critical: true, at },
        ];
        yield* withMemory(root, hub, (memory) => memory.synchronize(scope));
        yield* withMemory(root, hub, (memory) => memory.endSession(session));
        const resumedSession = { ...session, runtimeGeneration: "generation-2" };
        const resumed = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(resumedSession, "resume"),
        );
        expect(resumed.currentPath).not.toBe(first.currentPath);
        expect(
          yield* Effect.promise(() => NodeFSP.readFile(resumed.currentPath, "utf8")),
        ).toContain("Private notes retained");
        expect(resumed.notice).toContain("record.retract");
      }),
  );

  it.effect(
    "proves managed behavior only in a fake adapter that reads the current file for each actual request",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        const bundle = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "startup"),
        );
        const requests: string[] = [];
        const fakeManagedAdapter = {
          nextCall: async () => {
            const actualInput = `System context:\n${await NodeFSP.readFile(bundle.currentPath, "utf8")}\nTask: fix dates`;
            requests.push(actualInput);
            return actualInput;
          },
        };
        yield* Effect.promise(() =>
          NodeFSP.writeFile(bundle.currentPath, "Previous working assumption"),
        );
        yield* Effect.promise(() => fakeManagedAdapter.nextCall());
        yield* Effect.promise(() =>
          NodeFSP.writeFile(bundle.currentPath, "Corrected working assumption"),
        );
        yield* Effect.promise(() => fakeManagedAdapter.nextCall());
        expect(requests[0]).toContain("Previous working assumption");
        expect(requests[1]).toContain("Corrected working assumption");
        expect(requests[1]).not.toContain("Previous working assumption");
        const state = yield* withMemory(root, hub, (memory) => memory.state(scope));
        expect(state.capabilities.every((capability) => capability.mode === "companion")).toBe(
          true,
        );
      }),
  );

  it.effect("does not let cached search bypass membership revocation or another account", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => temporary());
      const hub = new Hub();
      yield* withMemory(root, hub, (memory) =>
        memory.search({ ...scope, search: { query: "dates", contextIds: [] } }),
      );
      hub.revoked = true;
      const error = yield* withMemory(root, hub, (memory) =>
        memory.search({ ...scope, search: { query: "dates", contextIds: [] } }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ detail: "no access" });
      hub.email = "bob@other.test";
      hub.token = "other-session";
      hub.offline = true;
      expect((yield* withMemory(root, hub, (memory) => memory.state(scope))).pendingLocal).toBe(0);
    }),
  );

  it.effect(
    "durably preserves every critical invalidation until this runtime acknowledges the version",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => temporary());
        const hub = new Hub();
        yield* withMemory(root, hub, (memory) =>
          memory.projectForSession(session, { include: [reference], purpose: "fix dates" }),
        );
        hub.events = Array.from({ length: 42 }, (_, index) => ({
          cursor: index + 1,
          id: reference.id,
          version: index + 2,
          type: "assertion.dispute",
          critical: true,
          at,
        }));
        hub.cursor = 42;
        yield* withMemory(root, hub, (memory) => memory.synchronize(scope));
        const notice = yield* withMemory(root, hub, (memory) => memory.sessionNotice(session));
        expect(notice).toContain("assertion-1@43");
        expect(notice).toContain("critical");
        expect((yield* withMemory(root, hub, (memory) => memory.synchronize(scope))).cursor).toBe(
          42,
        );
        const resume = yield* withMemory(root, hub, (memory) =>
          memory.prepareSession(session, "resume"),
        );
        expect(resume.notice).toContain("assertion-1@43");
        expect(hub.receipts.some((receipt) => receipt.state === "delivered")).toBe(false);
      }),
  );
});
