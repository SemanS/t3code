import {
  OrchestratorMcpFailure,
  type PeerHubMemoryExecuteInput,
  type PeerHubMemorySearchInput,
  type PeerHubMemoryReadInput,
  type PeerHubMemoryProjectInput,
  type PeerHubMemoryChangesInput,
  type PeerMemoryReceiptInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerHub from "../peerHub/PeerHub.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { readMutationCaller } from "./threadAccess.ts";

const failure = (error: { readonly detail: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.detail });
const make = Effect.gen(function* () {
  const peer = yield* PeerHub.PeerHub;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const bind = Effect.fn("PeerMemoryMcpService.bind")(function* (
    input?: { readonly workspace?: string | undefined; readonly project?: string | undefined },
    sharedRead = false,
  ) {
    const { caller, scope } = yield* readMutationCaller().pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );
    if (!sharedRead && caller.interactionMode !== "default")
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "Peer Memory tools require a live default runtime.",
      });
    const session = yield* peer
      .memoryRuntime(scope.threadId, scope.providerSessionId, scope.providerInstanceId)
      .pipe(Effect.mapError(failure));
    if (
      input !== undefined &&
      ((input.workspace !== undefined && input.workspace !== session.workspace) ||
        (input.project !== undefined &&
          input.project !== session.project &&
          !(sharedRead && input.project === "company")))
    )
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The memory scope is unavailable to this runtime.",
      });
    return session;
  });
  return {
    search: Effect.fn("PeerMemoryMcpService.search")(function* (input: PeerHubMemorySearchInput) {
      yield* bind(input, true);
      return yield* peer.memorySearch(input).pipe(Effect.mapError(failure));
    }),
    read: Effect.fn("PeerMemoryMcpService.read")(function* (input: PeerHubMemoryReadInput) {
      yield* bind(input, true);
      return yield* peer.memoryRead(input).pipe(Effect.mapError(failure));
    }),
    changes: Effect.fn("PeerMemoryMcpService.changes")(function* (
      input: PeerHubMemoryChangesInput,
    ) {
      yield* bind(input, true);
      return yield* peer.memoryChanges(input).pipe(Effect.mapError(failure));
    }),
    project: Effect.fn("PeerMemoryMcpService.project")(function* (
      input: PeerHubMemoryProjectInput,
    ) {
      const session = yield* bind(input, true);
      return yield* peer
        .memoryAgentProject(session.sessionId, input)
        .pipe(Effect.mapError(failure));
    }),
    execute: Effect.fn("PeerMemoryMcpService.execute")(function* (
      input: PeerHubMemoryExecuteInput,
      rememberOnly = false,
    ) {
      if (rememberOnly && input.command.type !== "assertion.record")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Remember accepts an assertion.record command.",
        });
      const session = yield* bind(input);
      return yield* peer
        .memoryAgentExecute(session.sessionId, input)
        .pipe(Effect.mapError(failure));
    }),
    receipt: Effect.fn("PeerMemoryMcpService.receipt")(function* (
      input: Omit<
        PeerMemoryReceiptInput,
        "sessionId" | "environmentId" | "runtimeGeneration" | "runtimeProjectId"
      > & { readonly workspace?: string | undefined; readonly project?: string | undefined },
    ) {
      const session = yield* bind(input, true);
      if (input.state !== "acknowledged" && input.state !== "consumed")
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "A runtime acknowledges an exact projection or cites concrete output evidence for consumption.",
        });
      return yield* peer
        .memoryAgentReceipt(session.sessionId, input)
        .pipe(Effect.mapError(failure));
    }),
    context: Effect.fn("PeerMemoryMcpService.context")(function* (input: {
      readonly action: "notice" | "checkpoint";
      readonly reason?: string | undefined;
    }) {
      const session = yield* bind();
      return yield* peer
        .memoryAgentContext(session.sessionId, input.action, input.reason)
        .pipe(Effect.mapError(failure));
    }),
  };
});
/** @effect-expect-leaking McpInvocationContext */
export class PeerMemoryMcpService extends Context.Service<
  PeerMemoryMcpService,
  Effect.Success<typeof make>
>()("t3/mcp/PeerMemoryMcpService") {}
export const layer = Layer.effect(PeerMemoryMcpService, make);
