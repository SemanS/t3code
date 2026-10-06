import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PeerMemoryMode = Schema.Literals(["legacy", "shadow", "memory"]);
export type PeerMemoryMode = typeof PeerMemoryMode.Type;
export const PeerMemoryScope = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  project: TrimmedNonEmptyString,
});
export type PeerMemoryScope = typeof PeerMemoryScope.Type;
export const PeerMemoryRecordRef = Schema.Struct({
  id: TrimmedNonEmptyString,
  version: PositiveInt,
});
export type PeerMemoryRecordRef = typeof PeerMemoryRecordRef.Type;
export const PeerMemoryEntityRef = Schema.Struct({
  kind: Schema.Literals(["record", "work", "task", "artifact"]),
  id: TrimmedNonEmptyString,
  version: Schema.optional(PositiveInt),
  projectId: Schema.optional(TrimmedNonEmptyString),
});
export const PeerMemoryRelation = Schema.Literals([
  "contains",
  "relates_to",
  "relevant_to",
  "supports",
  "contradicts",
  "supersedes",
  "derived_from",
  "governed_by",
  "depends_on",
  "affects",
  "promoted_as",
]);
export const PeerMemoryApplicability = Schema.Struct({
  repositoryId: Schema.optional(TrimmedNonEmptyString),
  revision: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(TrimmedNonEmptyString),
  deployment: Schema.optional(TrimmedNonEmptyString),
  baseRevision: Schema.optional(TrimmedNonEmptyString),
  diffHash: Schema.optional(TrimmedNonEmptyString),
});
export type PeerMemoryApplicability = typeof PeerMemoryApplicability.Type;
export const PeerMemoryEvidence = Schema.Struct({
  kind: Schema.Literals(["code", "test", "pr", "knowledge", "legacy", "artifact"]),
  repositoryId: Schema.optional(TrimmedNonEmptyString),
  revision: Schema.optional(TrimmedNonEmptyString),
  path: Schema.optional(TrimmedNonEmptyString),
  symbol: Schema.optional(TrimmedNonEmptyString),
  startLine: Schema.optional(PositiveInt),
  endLine: Schema.optional(PositiveInt),
  blobHash: Schema.optional(TrimmedNonEmptyString),
  command: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optional(TrimmedNonEmptyString),
  result: Schema.optional(Schema.String),
  outputHash: Schema.optional(TrimmedNonEmptyString),
  url: Schema.optional(TrimmedNonEmptyString),
  baseRevision: Schema.optional(TrimmedNonEmptyString),
  diffHash: Schema.optional(TrimmedNonEmptyString),
  weak: Schema.Boolean,
});
export type PeerMemoryEvidence = typeof PeerMemoryEvidence.Type;
export const PeerMemoryAuthor = Schema.Struct({
  email: Schema.String,
  sessionId: Schema.optional(Schema.String),
  environmentId: Schema.optional(Schema.String),
  runtimeGeneration: Schema.optional(Schema.String),
});
export const PeerMemoryGrounding = Schema.Literals(["proposed", "corroborated", "verified"]);
export const PeerMemoryIndependence = Schema.Literals(["independent", "dependent", "unknown"]);
export const PeerMemoryKnowledgeStatus = Schema.Literals([
  "candidate",
  "kept_pending_review",
  "approved",
  "rejected",
]);
export const PeerMemoryRecord = Schema.Struct({
  id: Schema.String,
  schemaVersion: Schema.Literal(1),
  version: PositiveInt,
  workspaceId: Schema.String,
  projectId: Schema.String,
  kind: Schema.Literals([
    "context",
    "assertion",
    "evidence",
    "decision",
    "question",
    "relation",
    "knowledge",
  ]),
  title: Schema.String,
  text: Schema.String,
  aliases: Schema.Array(Schema.String),
  createdBy: PeerMemoryAuthor,
  recordedBy: Schema.optional(PeerMemoryAuthor),
  createdAt: IsoDateTime,
  knownAt: IsoDateTime,
  recordedAt: IsoDateTime,
  observedAt: Schema.optional(IsoDateTime),
  validFrom: Schema.optional(IsoDateTime),
  validTo: Schema.optional(IsoDateTime),
  applicability: PeerMemoryApplicability,
  sourceRefs: Schema.Array(PeerMemoryEvidence),
  derivedFrom: Schema.Array(PeerMemoryRecordRef),
  operationId: Schema.String,
  contentHash: Schema.String,
  lifecycle: Schema.Literals(["active", "superseded", "retracted", "archived"]),
  grounding: PeerMemoryGrounding,
  independence: PeerMemoryIndependence,
  evidenceIds: Schema.Array(Schema.String),
  evidenceMissing: Schema.Boolean,
  attestations: Schema.optional(
    Schema.Array(
      Schema.Struct({
        author: PeerMemoryAuthor,
        at: IsoDateTime,
        method: Schema.String,
        scope: Schema.String,
        grounding: PeerMemoryGrounding,
        evidenceIds: Schema.Array(Schema.String),
      }),
    ),
  ),
  relation: Schema.optional(
    Schema.Struct({
      relation: PeerMemoryRelation,
      from: PeerMemoryEntityRef,
      to: PeerMemoryEntityRef,
      reason: Schema.String,
      resolved: Schema.Boolean,
    }),
  ),
  decision: Schema.optional(
    Schema.Struct({
      status: Schema.Literals(["proposed", "approved", "rejected", "superseded"]),
      reasons: Schema.String,
      alternatives: Schema.Array(Schema.String),
      approvedBy: Schema.optional(Schema.String),
    }),
  ),
  question: Schema.optional(
    Schema.Struct({
      owner: Schema.optional(Schema.String),
      closed: Schema.Boolean,
      answers: Schema.Array(
        Schema.Struct({
          text: Schema.String,
          author: PeerMemoryAuthor,
          at: IsoDateTime,
          references: Schema.Array(PeerMemoryRecordRef),
        }),
      ),
    }),
  ),
  knowledge: Schema.optional(
    Schema.Struct({
      status: PeerMemoryKnowledgeStatus,
      repositoryId: Schema.String,
      path: Schema.String,
      knowledgeId: Schema.String,
      commit: Schema.optional(Schema.String),
      blobHash: Schema.optional(Schema.String),
      reviewRef: Schema.optional(Schema.String),
    }),
  ),
  workId: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
});
export type PeerMemoryRecord = typeof PeerMemoryRecord.Type;

const envelope = {
  schemaVersion: Schema.Literal(1),
  operationId: TrimmedNonEmptyString,
  sessionId: Schema.optional(TrimmedNonEmptyString),
  environmentId: Schema.optional(TrimmedNonEmptyString),
  runtimeGeneration: Schema.optional(TrimmedNonEmptyString),
  workId: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(TrimmedNonEmptyString),
  observedAt: Schema.optional(IsoDateTime),
  validFrom: Schema.optional(IsoDateTime),
  validTo: Schema.optional(IsoDateTime),
  applicability: Schema.optional(PeerMemoryApplicability),
  consumed: Schema.optional(Schema.Array(PeerMemoryRecordRef)),
};
const mutation = { id: TrimmedNonEmptyString, expectedVersion: PositiveInt };
const command = <T extends string, F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ ...envelope, type: Schema.Literal(type), ...fields });
export const PeerMemoryCommand = Schema.Union([
  command("assertion.record", {
    claim: TrimmedNonEmptyString,
    contextIds: Schema.Array(Schema.String),
    evidence: Schema.Array(PeerMemoryEvidence),
    derivedFrom: Schema.optional(Schema.Array(PeerMemoryRecordRef)),
    independence: Schema.optional(PeerMemoryIndependence),
  }),
  command("context.create", {
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    aliases: Schema.Array(Schema.String),
  }),
  command("decision.record", {
    choice: TrimmedNonEmptyString,
    reasons: TrimmedNonEmptyString,
    alternatives: Schema.Array(Schema.String),
    contextIds: Schema.Array(Schema.String),
  }),
  command("question.record", {
    question: TrimmedNonEmptyString,
    owner: Schema.optional(Schema.String),
    contextIds: Schema.Array(Schema.String),
  }),
  command("evidence.attach", { ...mutation, evidence: Schema.Array(PeerMemoryEvidence) }),
  command("assertion.attest", {
    ...mutation,
    method: TrimmedNonEmptyString,
    scope: TrimmedNonEmptyString,
    grounding: Schema.Literals(["corroborated", "verified"]),
    evidence: Schema.Array(PeerMemoryEvidence),
  }),
  command("assertion.dispute", {
    ...mutation,
    reason: TrimmedNonEmptyString,
    evidence: Schema.Array(PeerMemoryEvidence),
  }),
  command("assertion.correct", {
    ...mutation,
    claim: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
    evidence: Schema.Array(PeerMemoryEvidence),
  }),
  command("context.update", {
    ...mutation,
    title: TrimmedNonEmptyString,
    description: Schema.optional(Schema.String),
    aliases: Schema.Array(Schema.String),
  }),
  command("record.retract", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("context.archive", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("question.close", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("assertion.supersede", {
    ...mutation,
    successor: PeerMemoryRecordRef,
    reason: TrimmedNonEmptyString,
  }),
  command("context.link", {
    relation: PeerMemoryRelation,
    from: PeerMemoryEntityRef,
    to: PeerMemoryEntityRef,
    reason: Schema.String,
  }),
  command("relation.end", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("relation.resolve", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("context.move", { ...mutation, parentIds: Schema.Array(Schema.String) }),
  command("context.merge", {
    ...mutation,
    sourceIds: Schema.Array(PeerMemoryRecordRef),
    reason: TrimmedNonEmptyString,
  }),
  command("context.split", {
    ...mutation,
    contexts: Schema.Array(
      Schema.Struct({
        title: TrimmedNonEmptyString,
        description: Schema.optional(Schema.String),
        memberIds: Schema.Array(Schema.String),
      }),
    ),
    reason: TrimmedNonEmptyString,
  }),
  command("record.restore", { ...mutation, version: PositiveInt, reason: TrimmedNonEmptyString }),
  command("decision.decide", {
    ...mutation,
    status: Schema.Literals(["approved", "rejected", "superseded"]),
    reason: TrimmedNonEmptyString,
  }),
  command("question.answer", {
    ...mutation,
    answer: TrimmedNonEmptyString,
    references: Schema.Array(PeerMemoryRecordRef),
  }),
  command("knowledge.import", {
    title: TrimmedNonEmptyString,
    text: Schema.String,
    source: PeerMemoryEvidence,
    knowledgeId: TrimmedNonEmptyString,
    reviewRef: TrimmedNonEmptyString,
  }),
  command("knowledge.keep", {
    ...mutation,
    path: Schema.optional(Schema.String),
    reason: Schema.optional(Schema.String),
  }),
  command("knowledge.reject", { ...mutation, reason: Schema.optional(Schema.String) }),
  command("record.publish", {
    ...mutation,
    targetProjectId: TrimmedNonEmptyString,
    text: TrimmedNonEmptyString,
    reason: TrimmedNonEmptyString,
  }),
  command("record.erase", { ...mutation, reason: TrimmedNonEmptyString }),
]);
export type PeerMemoryCommand = typeof PeerMemoryCommand.Type;
export const PeerMemoryCommandResult = Schema.Struct({
  operationId: Schema.String,
  replayed: Schema.Boolean,
  records: Schema.Array(PeerMemoryRecord),
  cursor: NonNegativeInt,
  topologyRevision: NonNegativeInt,
  published: Schema.optional(
    Schema.Struct({ workspaceId: Schema.String, projectId: Schema.String, cursor: NonNegativeInt }),
  ),
});
export type PeerMemoryCommandResult = typeof PeerMemoryCommandResult.Type;
export const PeerMemoryWriteResult = Schema.Struct({
  status: Schema.Literals(["stored", "pending_local"]),
  operationId: Schema.String,
  result: Schema.optional(PeerMemoryCommandResult),
});
export type PeerMemoryWriteResult = typeof PeerMemoryWriteResult.Type;
export const PeerMemorySearch = Schema.Struct({
  query: Schema.optional(Schema.String),
  taskId: Schema.optional(Schema.String),
  workId: Schema.optional(Schema.String),
  contextIds: Schema.Array(Schema.String),
  repositoryId: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
  symbols: Schema.optional(Schema.Array(Schema.String)),
  environment: Schema.optional(Schema.String),
  validAt: Schema.optional(IsoDateTime),
  knownAt: Schema.optional(IsoDateTime),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  cursor: Schema.optional(NonNegativeInt),
  includeArchived: Schema.optional(Schema.Boolean),
});
export const PeerMemorySearchResult = Schema.Struct({
  records: Schema.Array(
    Schema.Struct({
      record: PeerMemoryRecord,
      whyIncluded: Schema.Array(Schema.String),
      conflicts: Schema.Array(PeerMemoryRecord),
    }),
  ),
  cursor: NonNegativeInt,
  hasMore: Schema.Boolean,
  memoryWatermark: NonNegativeInt,
  policyVersion: Schema.Literal("peer-memory-v1"),
  traversalIncomplete: Schema.optional(Schema.Boolean),
});
export type PeerMemorySearchResult = typeof PeerMemorySearchResult.Type;
export const PeerMemoryRecordView = Schema.Struct({
  record: PeerMemoryRecord,
  history: Schema.Array(PeerMemoryRecord),
  conflicts: Schema.Array(PeerMemoryRecord),
  related: Schema.Array(PeerMemoryRecord),
});
export type PeerMemoryRecordView = typeof PeerMemoryRecordView.Type;
export const PeerMemoryProjectionInput = Schema.Struct({
  include: Schema.Array(PeerMemoryRecordRef),
  purpose: TrimmedNonEmptyString,
  budget: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 32, maximum: 32000 }))),
  repositoryId: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  environment: Schema.optional(Schema.String),
  validAt: Schema.optional(IsoDateTime),
  knownAt: Schema.optional(IsoDateTime),
  workWatermark: Schema.optional(Schema.String),
  knowledgeWatermark: Schema.optional(Schema.String),
});
export const PeerMemoryManifest = Schema.Struct({
  id: Schema.String,
  schemaVersion: Schema.Literal(1),
  createdAt: IsoDateTime,
  selected: Schema.Array(PeerMemoryRecordRef),
  contentHash: Schema.String,
  policyVersion: Schema.Literal("peer-memory-v1"),
  requested: PeerMemoryProjectionInput,
  workspaceId: Schema.String,
  projectId: Schema.String,
  permissionScope: Schema.Struct({
    email: Schema.String,
    workspaceId: Schema.String,
    projectId: Schema.String,
  }),
  memoryWatermark: NonNegativeInt,
  workWatermark: Schema.optional(Schema.String),
  knowledgeWatermark: Schema.optional(Schema.String),
  tokenEstimate: NonNegativeInt,
  tokenEstimateMethod: Schema.Literal("chars/4"),
  omitted: Schema.Array(PeerMemoryRecordRef),
});
export const PeerMemoryProjection = Schema.Struct({
  text: Schema.String,
  manifest: PeerMemoryManifest,
});
export type PeerMemoryProjection = typeof PeerMemoryProjection.Type;
export const PeerMemoryChange = Schema.Struct({
  cursor: NonNegativeInt,
  id: Schema.String,
  version: PositiveInt,
  type: Schema.String,
  critical: Schema.Boolean,
  affectedRecordIds: Schema.optional(Schema.Array(Schema.String)),
  at: IsoDateTime,
});
export type PeerMemoryChange = typeof PeerMemoryChange.Type;
export const PeerMemoryChanges = Schema.Struct({
  changes: Schema.Array(PeerMemoryChange),
  cursor: NonNegativeInt,
  hasMore: Schema.Boolean,
  resyncRequired: Schema.Boolean,
});
export type PeerMemoryChanges = typeof PeerMemoryChanges.Type;
export const PeerMemoryReceiptInput = Schema.Struct({
  projectionId: Schema.optional(Schema.String),
  records: Schema.Array(PeerMemoryRecordRef),
  state: Schema.Literals(["requested", "delivered", "acknowledged", "consumed"]),
  sessionId: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  runtimeGeneration: TrimmedNonEmptyString,
  runtimeProjectId: Schema.optional(TrimmedNonEmptyString),
  outputRef: Schema.optional(PeerMemoryEvidence),
});
export type PeerMemoryReceiptInput = typeof PeerMemoryReceiptInput.Type;
export const PeerMemoryReceipt = Schema.Struct({
  id: Schema.String,
  state: PeerMemoryReceiptInput.fields.state,
  at: IsoDateTime,
  createdBy: PeerMemoryAuthor,
  records: Schema.Array(PeerMemoryRecordRef),
  projectionId: Schema.optional(Schema.String),
  runtimeProjectId: Schema.optional(TrimmedNonEmptyString),
  outputRef: Schema.optional(PeerMemoryEvidence),
});
export type PeerMemoryReceipt = typeof PeerMemoryReceipt.Type;
export const PeerMemoryState = Schema.Struct({
  mode: PeerMemoryMode,
  available: Schema.Boolean,
  pendingLocal: NonNegativeInt,
  blockedLocal: NonNegativeInt,
  cursor: NonNegativeInt,
  lastSyncAt: Schema.NullOr(IsoDateTime),
  projectionAgeMs: Schema.optional(NonNegativeInt),
  capabilities: Schema.Array(
    Schema.Struct({ adapter: Schema.String, mode: Schema.Literal("companion") }),
  ),
});
export type PeerMemoryState = typeof PeerMemoryState.Type;
export const PeerHubMemoryStateInput = PeerMemoryScope;
export const PeerHubMemoryModeInput = PeerMemoryScope;
export const PeerHubMemorySetModeInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  mode: PeerMemoryMode,
});
export type PeerHubMemorySetModeInput = typeof PeerHubMemorySetModeInput.Type;
export const PeerHubMemorySearchInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  search: PeerMemorySearch,
});
export type PeerHubMemorySearchInput = typeof PeerHubMemorySearchInput.Type;
export const PeerHubMemoryReadInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  id: TrimmedNonEmptyString,
  version: Schema.optional(PositiveInt),
  knownAt: Schema.optional(IsoDateTime),
});
export type PeerHubMemoryReadInput = typeof PeerHubMemoryReadInput.Type;
export const PeerHubMemoryProjectInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  projection: PeerMemoryProjectionInput,
});
export type PeerHubMemoryProjectInput = typeof PeerHubMemoryProjectInput.Type;
export const PeerHubMemoryExecuteInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  command: PeerMemoryCommand,
});
export type PeerHubMemoryExecuteInput = typeof PeerHubMemoryExecuteInput.Type;
export const PeerHubMemoryChangesInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  after: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt),
});
export type PeerHubMemoryChangesInput = typeof PeerHubMemoryChangesInput.Type;
export const PeerHubMemoryReceiptsInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  recordId: Schema.optional(Schema.String),
});
export type PeerHubMemoryReceiptsInput = typeof PeerHubMemoryReceiptsInput.Type;
export const PeerHubMemoryKeepInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  ...mutation,
  repositoryId: TrimmedNonEmptyString,
  path: Schema.optional(Schema.String),
});
export type PeerHubMemoryKeepInput = typeof PeerHubMemoryKeepInput.Type;
export const PeerMemoryKept = Schema.Struct({
  status: Schema.Literal("kept_pending_review"),
  path: Schema.String,
  operation: PeerMemoryWriteResult,
});
export type PeerMemoryKept = typeof PeerMemoryKept.Type;
export const PeerHubMemoryImportKnowledgeInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  repositoryId: TrimmedNonEmptyString,
  commit: TrimmedNonEmptyString,
  reviewRef: TrimmedNonEmptyString,
  paths: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PeerHubMemoryImportKnowledgeInput = typeof PeerHubMemoryImportKnowledgeInput.Type;
export const PeerMemoryQueue = Schema.Struct({
  operations: Schema.Array(
    Schema.Struct({
      operationId: Schema.String,
      command: PeerMemoryCommand,
      status: Schema.Literals(["pending", "blocked"]),
      at: IsoDateTime,
      blockedReason: Schema.optional(Schema.String),
    }),
  ),
});
export type PeerMemoryQueue = typeof PeerMemoryQueue.Type;
export const PeerHubMemoryQueueInput = PeerMemoryScope;
export const PeerHubMemoryRetryInput = Schema.Struct({
  ...PeerMemoryScope.fields,
  operationId: TrimmedNonEmptyString,
});
export type PeerHubMemoryRetryInput = typeof PeerHubMemoryRetryInput.Type;
export const PeerHubMemoryDiscardInput = Schema.Struct({
  ...PeerHubMemoryRetryInput.fields,
  reason: TrimmedNonEmptyString,
});
export type PeerHubMemoryDiscardInput = typeof PeerHubMemoryDiscardInput.Type;
export const PeerMemoryDiscarded = Schema.Struct({
  operationId: Schema.String,
  status: Schema.Literal("discarded"),
});
export type PeerMemoryDiscarded = typeof PeerMemoryDiscarded.Type;
