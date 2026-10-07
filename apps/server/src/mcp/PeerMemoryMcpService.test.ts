import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PeerHubMemoryExecuteInput,
  type PeerHubMemoryProjectInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Peer from "../peerHub/PeerHub.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Memory from "./PeerMemoryMcpService.ts";

const threadId = ThreadId.make("thread-memory-test");
const providerInstanceId = ProviderInstanceId.make("cursor-test");
const caller = {
  id: threadId,
  projectId: ProjectId.make("project-memory-test"),
  providerInstanceId,
  activeRunId: RunId.make("run-memory-test"),
  archivedAt: null,
  deletedAt: null,
  interactionMode: "default",
} as OrchestrationV2ThreadShell;
const invocation: Invocation.McpInvocationScope = {
  threadId,
  providerInstanceId,
  environmentId: EnvironmentId.make("environment-memory-test"),
  providerSessionId: "runtime-memory-test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const session = {
  workspace: "acme",
  project: "app",
  sessionId: `peer:${threadId}`,
  runtimeGeneration: invocation.providerSessionId,
  environmentId: invocation.environmentId,
  workId: `peer:${threadId}`,
  root: "/repo",
  adapter: "cursor",
};
const write: PeerHubMemoryExecuteInput = {
  workspace: "acme",
  project: "app",
  command: {
    schemaVersion: 1,
    operationId: "remember-mcp-1",
    type: "assertion.record",
    claim: "The regression fails at the observed revision.",
    contextIds: [],
    evidence: [],
  },
};
const harness = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  mode: "legacy" | "shadow" | "memory" = "memory",
) => {
  const memoryRuntime = vi.fn(() => Effect.succeed(session));
  const memoryAgentExecute = vi.fn(() =>
    Effect.succeed({ status: "pending_local" as const, operationId: write.command.operationId }),
  );
  const memorySearch = vi.fn(() =>
    Effect.succeed({
      records: [],
      cursor: 0,
      hasMore: false,
      memoryWatermark: 0,
      policyVersion: "peer-memory-v1" as const,
      traversalIncomplete: false,
    }),
  );
  const memoryAgentProject = vi.fn((_session: string, input: PeerHubMemoryProjectInput) =>
    Effect.succeed({
      text: "Company convention",
      manifest: {
        id: "company-projection",
        schemaVersion: 1 as const,
        createdAt: "2026-10-06T09:00:00Z",
        selected: [],
        contentHash: "projection-hash",
        policyVersion: "peer-memory-v1" as const,
        requested: input.projection,
        workspaceId: input.workspace,
        projectId: input.project,
        permissionScope: {
          email: "ana@acme.test",
          workspaceId: input.workspace,
          projectId: input.project,
        },
        memoryWatermark: 0,
        tokenEstimate: 4,
        tokenEstimateMethod: "chars/4" as const,
        omitted: [],
      },
    }),
  );
  const memoryAgentReceipt = vi.fn(() =>
    Effect.succeed({
      id: "company-receipt",
      state: "acknowledged" as const,
      at: "2026-10-06T09:00:00Z",
      createdBy: { email: "ana@acme.test", sessionId: session.sessionId },
      records: [],
      runtimeProjectId: "app",
    }),
  );
  const layer = Memory.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ ...caller, ...overrides }),
        } satisfies Partial<Threads.ThreadManagementService["Service"]>),
        Layer.mock(Peer.PeerHub)({
          memoryRuntime,
          memoryMode: () => Effect.succeed({ mode }),
          memoryAgentExecute,
          memorySearch,
          memoryAgentProject,
          memoryAgentReceipt,
        } satisfies Partial<Peer.PeerHub["Service"]>),
      ),
    ),
  );
  const run = <A, E>(
    use: (
      memory: Memory.PeerMemoryMcpService["Service"],
    ) => Effect.Effect<A, E, Invocation.McpInvocationContext>,
    scope = invocation,
  ) =>
    Effect.gen(function* () {
      const memory = yield* Memory.PeerMemoryMcpService;
      return yield* use(memory).pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
    }).pipe(Effect.provide(layer));
  return {
    run,
    memoryRuntime,
    memoryAgentExecute,
    memorySearch,
    memoryAgentProject,
    memoryAgentReceipt,
  };
};

describe("provider-scoped Peer Memory MCP", () => {
  it.effect("denies legacy Memory calls even when a runtime session already exists", () => {
    const test = harness({}, "legacy");
    return Effect.gen(function* () {
      for (const call of [
        (memory: Memory.PeerMemoryMcpService["Service"]) =>
          memory.search({ search: { contextIds: [] } }).pipe(Effect.asVoid),
        (memory: Memory.PeerMemoryMcpService["Service"]) =>
          memory.execute(write).pipe(Effect.asVoid),
        (memory: Memory.PeerMemoryMcpService["Service"]) =>
          memory
            .project({ projection: { include: [], purpose: "read convention" } })
            .pipe(Effect.asVoid),
      ]) {
        const denied = yield* test.run(call).pipe(Effect.flip);
        expect(denied.code).toBe("capability_denied");
      }
      expect(test.memorySearch).not.toHaveBeenCalled();
      expect(test.memoryAgentExecute).not.toHaveBeenCalled();
      expect(test.memoryAgentProject).not.toHaveBeenCalled();
    });
  });

  it.effect("derives omitted read and write scopes from the calling runtime", () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* test.run((memory) => memory.search({ search: { contextIds: [] } }));
      expect(test.memorySearch).toHaveBeenCalledWith({
        workspace: session.workspace,
        project: session.project,
        search: { contextIds: [] },
      });
      yield* test.run((memory) => memory.execute({ command: write.command }));
      expect(test.memoryAgentExecute).toHaveBeenCalledWith(session.sessionId, write);
    });
  });

  it.effect("keeps an explicit company read within the calling workspace", () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* test.run((memory) =>
        memory.search({ project: "company", search: { contextIds: [] } }),
      );
      expect(test.memorySearch).toHaveBeenCalledWith({
        workspace: session.workspace,
        project: "company",
        search: { contextIds: [] },
      });
    });
  });

  it.effect(
    "permits company projection and receipt tracking while company writes remain denied",
    () => {
      const test = harness({ interactionMode: "plan" });
      return Effect.gen(function* () {
        yield* test.run((memory) =>
          memory.project({
            workspace: "acme",
            project: "company",
            projection: { include: [], purpose: "read convention" },
          }),
        );
        expect(test.memoryAgentProject).toHaveBeenCalledWith(
          session.sessionId,
          expect.objectContaining({ project: "company" }),
        );
        yield* test.run((memory) =>
          memory.receipt({
            project: "company",
            projectionId: "company-projection",
            records: [],
            state: "acknowledged",
          }),
        );
        expect(test.memoryAgentReceipt).toHaveBeenCalledWith(
          session.sessionId,
          expect.objectContaining({ project: "company" }),
        );
        const writer = harness();
        const denied = yield* writer
          .run((memory) => memory.execute({ ...write, project: "company" }))
          .pipe(Effect.flip);
        expect(denied.code).toBe("invalid_request");
        expect(writer.memoryAgentExecute).not.toHaveBeenCalled();
      });
    },
  );
  it.effect("binds a write to the live credential's thread and provider generation", () => {
    const test = harness();
    return Effect.gen(function* () {
      const result = yield* test.run((memory) => memory.execute(write, true));
      expect(result.status).toBe("pending_local");
      expect(test.memoryRuntime).toHaveBeenCalledWith(
        threadId,
        invocation.providerSessionId,
        providerInstanceId,
      );
      expect(test.memoryAgentExecute).toHaveBeenCalledWith(session.sessionId, write);
    });
  });

  it.effect("rejects cross-project reads and writes before accessing memory", () => {
    const test = harness();
    return Effect.gen(function* () {
      const error = yield* test
        .run((memory) => memory.execute({ ...write, project: "other" }))
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_request");
      expect(test.memoryAgentExecute).not.toHaveBeenCalled();
      const readError = yield* test
        .run((memory) =>
          memory.search({ workspace: "other", project: "company", search: { contextIds: [] } }),
        )
        .pipe(Effect.flip);
      expect(readError.code).toBe("invalid_request");
      expect(test.memorySearch).not.toHaveBeenCalled();
    });
  });

  it.effect("permits a company read in planning mode but refuses a memory mutation", () => {
    const test = harness({ interactionMode: "plan" });
    return Effect.gen(function* () {
      yield* test.run((memory) =>
        memory.search({ workspace: "acme", project: "company", search: { contextIds: [] } }),
      );
      expect(test.memorySearch).toHaveBeenCalledTimes(1);
      const error = yield* test.run((memory) => memory.execute(write)).pipe(Effect.flip);
      expect(error.code).toBe("capability_denied");
      expect(test.memoryAgentExecute).not.toHaveBeenCalled();
    });
  });

  it.effect("rejects an ended run, another provider, and an orchestration-free credential", () =>
    Effect.gen(function* () {
      for (const overrides of [
        { activeRunId: null },
        { providerInstanceId: ProviderInstanceId.make("replacement") },
      ]) {
        const test = harness(overrides);
        const error = yield* test.run((memory) => memory.execute(write)).pipe(Effect.flip);
        expect(error.code).toBe("parent_not_active");
        expect(test.memoryRuntime).not.toHaveBeenCalled();
      }
      const test = harness();
      const error = yield* test
        .run((memory) => memory.execute(write), { ...invocation, capabilities: new Set() })
        .pipe(Effect.flip);
      expect(error.code).toBe("capability_denied");
      expect(test.memoryRuntime).not.toHaveBeenCalled();
    }),
  );

  it.effect("never accepts a fabricated delivery receipt from the runtime", () => {
    const test = harness();
    return Effect.gen(function* () {
      const error = yield* test
        .run((memory) =>
          memory.receipt({
            state: "delivered",
            projectionId: "projection-1",
            records: [{ id: "assertion-1", version: 1 }],
          }),
        )
        .pipe(Effect.flip);
      expect(error.code).toBe("invalid_request");
    });
  });
});
