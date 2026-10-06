import {
  OrchestratorMcpFailure,
  PeerHubMemorySearchInput,
  PeerMemorySearchResult,
  PeerHubMemoryReadInput,
  PeerMemoryRecordView,
  PeerHubMemoryProjectInput,
  PeerMemoryProjection,
  PeerHubMemoryExecuteInput,
  PeerMemoryWriteResult,
  PeerHubMemoryChangesInput,
  PeerMemoryChanges,
  PeerMemoryReceiptInput,
  PeerMemoryReceipt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Memory from "../../PeerMemoryMcpService.ts";

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    Memory.PeerMemoryMcpService,
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const Search = Tool.make("peer_memory_search", {
  ...common,
  parameters: PeerHubMemorySearchInput,
  success: PeerMemorySearchResult,
  description:
    "Search durable Peer findings and contexts in the calling project, or explicit company scope. Choose records by provenance and applicability; conflicts remain visible.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const Read = Tool.make("peer_memory_read", {
  ...common,
  parameters: PeerHubMemoryReadInput,
  success: PeerMemoryRecordView,
  description:
    "Read an exact Peer record version or knownAt history, with evidence and conflicts. Current project permissions are rechecked.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const Changes = Tool.make("peer_memory_changes", {
  ...common,
  parameters: PeerHubMemoryChangesInput,
  success: PeerMemoryChanges,
  description:
    "Read the authorized memory changes after a cursor; resyncRequired means obtain a fresh index.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const Project = Tool.make("peer_memory_project", {
  ...common,
  parameters: PeerHubMemoryProjectInput,
  success: PeerMemoryProjection,
  description:
    "Build a bounded immutable projection from selected record versions. Mandatory conflict and evidence dependencies may expand selected. Existing private current notes are preserved; the receipt stays requested until this runtime acknowledges the exact bundle.",
}).annotate(Tool.Destructive, false);
const Remember = Tool.make("peer_memory_remember", {
  ...common,
  parameters: PeerHubMemoryExecuteInput,
  success: PeerMemoryWriteResult,
  description:
    "Persist an assertion.record command with a stable operationId and explicit evidence. The host binds actor fields to this runtime. pending_local means saved on this computer until the hub accepts it. Never claim independence after reading another finding.",
}).annotate(Tool.Destructive, false);
const Command = Tool.make("peer_memory_command", {
  ...common,
  parameters: PeerHubMemoryExecuteInput,
  success: PeerMemoryWriteResult,
  description:
    "Apply a versioned Peer memory command for evidence, dispute, correction, retraction, supersession, questions or context structure. Preserve operationId on retries; mutations require expectedVersion. Human review, publication, erasure and knowledge approval are unavailable to agents.",
}).annotate(Tool.Destructive, true);
const {
  sessionId: _session,
  environmentId: _environment,
  runtimeGeneration: _generation,
  runtimeProjectId: _runtimeProject,
  ...receiptFields
} = PeerMemoryReceiptInput.fields;
const Receipt = Tool.make("peer_memory_receipt", {
  ...common,
  parameters: Schema.Struct({
    ...receiptFields,
    workspace: Schema.optional(Schema.String),
    project: Schema.optional(Schema.String),
  }),
  success: PeerMemoryReceipt,
  description:
    "Acknowledge a local projection using projectionId and every exact selected record version after accepting it. Set project company for a company projection; workspace defaults to this runtime's workspace. The host binds the actual source project and runtime identity. This live command proves delivery. consumed additionally requires concrete outputRef; hooks and prepared files alone do not prove delivery.",
}).annotate(Tool.Destructive, false);
const Context = Tool.make("peer_memory_context", {
  ...common,
  parameters: Schema.Struct({
    action: Schema.Literals(["notice", "checkpoint"]),
    reason: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ text: Schema.String }),
  description:
    "Locate this runtime's private companion context and pending critical notices, or checkpoint its own notes before compaction. All production provider adapters use companion mode.",
}).annotate(Tool.Destructive, false);

export const PeerMemoryToolkit = Toolkit.make(
  Search,
  Read,
  Changes,
  Project,
  Remember,
  Command,
  Receipt,
  Context,
);
