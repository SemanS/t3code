import {
  PeerMemoryCommand,
  PeerMemoryEvidence,
  type PeerMemoryRecordRef,
} from "@t3tools/contracts";
import { parseMemoryReferences } from "@t3tools/client-runtime/peer-memory";
import * as Schema from "effect/Schema";

export const MEMORY_ACTIONS = {
  assertion: "Record a finding",
  context: "Create a topic",
  question: "Open a question",
  decision: "Propose a decision",
  correct: "Correct this assertion",
  update: "Edit topic",
  attach: "Attach evidence",
  attest: "Attest",
  dispute: "Dispute",
  retract: "Retract",
  supersede: "Supersede with another assertion",
  link: "Link a record",
  move: "Move topic",
  merge: "Merge topics",
  split: "Split topic",
  archive: "Archive topic",
  restore: "Restore an earlier version",
  approve: "Approve decision",
  reject: "Reject decision",
  replace: "Supersede decision",
  answer: "Answer question",
  close: "Close question",
  rejectKnowledge: "Reject knowledge candidate",
  publish: "Publish a generalized finding",
  end: "End relation",
  resolve: "Resolve conflict",
  erase: "Erase sensitive content",
} as const;
export type MemoryAction = keyof typeof MEMORY_ACTIONS;

const decodeCommand = Schema.decodeUnknownSync(PeerMemoryCommand);
const decodeEvidence = Schema.decodeUnknownSync(PeerMemoryEvidence);
const ids = (text = "") =>
  text
    .split(/[,\n]/)
    .map((id) => id.trim())
    .filter(Boolean);

export function memoryActionEvidence(fields: Readonly<Record<string, string>>) {
  if (
    !fields.evidencePath?.trim() &&
    !fields.evidenceCommand?.trim() &&
    !fields.evidenceUrl?.trim()
  )
    return [];
  const kind = fields.evidenceKind || "code";
  const revision = fields.revision?.trim();
  const blobHash = fields.blobHash?.trim();
  return [
    decodeEvidence({
      kind,
      ...(fields.repositoryId?.trim() ? { repositoryId: fields.repositoryId.trim() } : {}),
      ...(revision ? { revision } : {}),
      ...(fields.evidencePath?.trim() ? { path: fields.evidencePath.trim() } : {}),
      ...(blobHash ? { blobHash } : {}),
      ...(fields.evidenceCommand?.trim() ? { command: fields.evidenceCommand.trim() } : {}),
      ...(fields.evidenceResult?.trim() ? { result: fields.evidenceResult.trim() } : {}),
      ...(fields.evidenceUrl?.trim() ? { url: fields.evidenceUrl.trim() } : {}),
      weak: !revision || !/^[a-f0-9]{40,64}$/i.test(revision) || !blobHash,
    }),
  ];
}

/** Human forms use the same versioned command schemas as agent tools. */
export function buildMemoryAction(
  action: MemoryAction,
  fields: Readonly<Record<string, string>>,
  operationId: string,
  record?: PeerMemoryRecordRef,
) {
  const base = { schemaVersion: 1, operationId };
  const mutation = record === undefined ? {} : { id: record.id, expectedVersion: record.version };
  const evidence = memoryActionEvidence(fields);
  const text = fields.text?.trim() ?? "";
  const reason = fields.reason?.trim() ?? "";
  const contextIds = ids(fields.contextIds);
  const references = () => parseMemoryReferences(fields.references ?? "");
  const applicability = {
    ...(fields.repositoryId?.trim() ? { repositoryId: fields.repositoryId.trim() } : {}),
    ...(fields.revision?.trim() ? { revision: fields.revision.trim() } : {}),
    ...(fields.environment?.trim() ? { environment: fields.environment.trim() } : {}),
  };
  const created = {
    ...base,
    applicability,
    ...(fields.validFrom ? { validFrom: new Date(fields.validFrom).toISOString() } : {}),
    ...(fields.validTo ? { validTo: new Date(fields.validTo).toISOString() } : {}),
  };
  let body: object;
  switch (action) {
    case "assertion":
      body = { ...created, type: "assertion.record", claim: text, contextIds, evidence };
      break;
    case "context":
      body = {
        ...created,
        type: "context.create",
        title: fields.title,
        description: text,
        aliases: ids(fields.aliases),
      };
      break;
    case "question":
      body = {
        ...created,
        type: "question.record",
        question: text,
        contextIds,
        ...(fields.owner?.trim() ? { owner: fields.owner.trim() } : {}),
      };
      break;
    case "decision":
      body = {
        ...created,
        type: "decision.record",
        choice: text,
        reasons: reason,
        alternatives: ids(fields.alternatives),
        contextIds,
      };
      break;
    case "correct":
      body = { ...base, ...mutation, type: "assertion.correct", claim: text, reason, evidence };
      break;
    case "update":
      body = {
        ...base,
        ...mutation,
        type: "context.update",
        title: fields.title,
        description: text,
        aliases: ids(fields.aliases),
      };
      break;
    case "attach":
      body = { ...base, ...mutation, type: "evidence.attach", evidence };
      break;
    case "attest":
      body = {
        ...base,
        ...mutation,
        type: "assertion.attest",
        method: fields.method,
        scope: fields.attestationScope,
        grounding: fields.grounding || "corroborated",
        evidence,
      };
      break;
    case "dispute":
      body = { ...base, ...mutation, type: "assertion.dispute", reason, evidence };
      break;
    case "supersede": {
      const refs = references();
      if (refs.length !== 1) throw new Error("Choose exactly one successor as id@version.");
      body = { ...base, ...mutation, type: "assertion.supersede", reason, successor: refs[0] };
      break;
    }
    case "link": {
      const refs = references();
      if (refs.length !== 1) throw new Error("Choose exactly one target as id@version.");
      body = {
        ...base,
        type: "context.link",
        relation: fields.relation || "relates_to",
        from: { kind: "record", ...record },
        to: { kind: "record", ...refs[0] },
        reason,
      };
      break;
    }
    case "move":
      body = { ...base, ...mutation, type: "context.move", parentIds: ids(fields.contextIds) };
      break;
    case "merge":
      body = { ...base, ...mutation, type: "context.merge", sourceIds: references(), reason };
      break;
    case "split":
      body = {
        ...base,
        ...mutation,
        type: "context.split",
        reason,
        contexts: [
          { title: fields.firstTitle, memberIds: ids(fields.firstMembers) },
          { title: fields.secondTitle, memberIds: ids(fields.secondMembers) },
        ],
      };
      break;
    case "restore":
      body = {
        ...base,
        ...mutation,
        type: "record.restore",
        version: Number(fields.version),
        reason,
      };
      break;
    case "approve":
    case "reject":
    case "replace":
      body = {
        ...base,
        ...mutation,
        type: "decision.decide",
        status: action === "approve" ? "approved" : action === "reject" ? "rejected" : "superseded",
        reason,
      };
      break;
    case "answer":
      body = {
        ...base,
        ...mutation,
        type: "question.answer",
        answer: text,
        references: references(),
      };
      break;
    case "publish":
      body = {
        ...base,
        ...mutation,
        type: "record.publish",
        targetProjectId: fields.targetProjectId,
        text,
        reason,
      };
      break;
    case "erase":
      if (fields.confirmation !== record?.id)
        throw new Error("Type the record ID to confirm erasure.");
      body = { ...base, ...mutation, type: "record.erase", reason };
      break;
    default: {
      const type = {
        retract: "record.retract",
        archive: "context.archive",
        close: "question.close",
        rejectKnowledge: "knowledge.reject",
        end: "relation.end",
        resolve: "relation.resolve",
      }[action];
      body = { ...base, ...mutation, type, reason };
    }
  }
  return decodeCommand(body);
}
