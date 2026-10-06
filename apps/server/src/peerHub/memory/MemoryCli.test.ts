import { describe, expect, it, vi } from "@effect/vitest";
import type { PeerHubMemoryExecuteInput, PeerHubMemorySearchInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MemoryCli from "./MemoryCli.ts";
import * as MemoryService from "./MemoryService.ts";

const session: MemoryService.MemorySession = {
  workspace: "acme",
  project: "app",
  sessionId: "claude:cli-test",
  environmentId: "test",
  runtimeGeneration: "live-generation",
  workId: "work-test",
  adapter: "claude",
  root: "/unused",
  repositoryId: "repo",
};
const harness = () => {
  const execute = vi.fn((input: PeerHubMemoryExecuteInput) =>
    Effect.succeed({ status: "pending_local" as const, operationId: input.command.operationId }),
  );
  const search = vi.fn((_input: PeerHubMemorySearchInput) =>
    Effect.succeed({
      records: [],
      cursor: 0,
      hasMore: false,
      memoryWatermark: 1,
      policyVersion: "peer-memory-v1" as const,
    }),
  );
  const layer = MemoryCli.layer.pipe(
    Layer.provide(
      Layer.mock(MemoryService.MemoryService)({ execute, search } satisfies Partial<
        MemoryService.MemoryService["Service"]
      >),
    ),
  );
  const run = (args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const cli = yield* MemoryCli.MemoryCli;
      return yield* cli.run(session, "memory", args);
    }).pipe(Effect.provide(layer));
  return { run, execute, search };
};

describe("Peer memory agent CLI", () => {
  it.effect(
    "targets company reads without applying the current project's repository filter and denies writes",
    () => {
      const test = harness();
      return Effect.gen(function* () {
        yield* test.run(["search", "approved convention", "--project", "company"]);
        expect(test.search.mock.calls[0]?.[0].project).toBe("company");
        expect(test.search.mock.calls[0]?.[0].search.repositoryId).toBeUndefined();
        const denied = yield* test
          .run(["command", "--project", "company", "--json", "{}"])
          .pipe(Effect.flip);
        expect(denied.detail).toContain("mutations belong to its own project");
        expect(test.execute).not.toHaveBeenCalled();
      });
    },
  );
  it.effect("overrides caller-supplied actor fields with the registered runtime identity", () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* test.run([
        "command",
        "--json",
        '{"schemaVersion":1,"operationId":"op-1","type":"assertion.record","claim":"Observed behavior","contextIds":[],"evidence":[],"sessionId":"forged","environmentId":"other","runtimeGeneration":"old"}',
      ]);
      expect(test.execute.mock.calls[0]?.[0].command).toMatchObject({
        sessionId: session.sessionId,
        environmentId: session.environmentId,
        runtimeGeneration: session.runtimeGeneration,
        workId: session.workId,
      });
    });
  });

  it.effect("refuses human review authority and verified attestation even in JSON commands", () =>
    Effect.gen(function* () {
      for (const command of [
        '{"schemaVersion":1,"operationId":"publish","type":"record.publish","id":"assertion-1","expectedVersion":1,"targetProjectId":"company","text":"Approved finding","reason":"reviewed"}',
        '{"schemaVersion":1,"operationId":"attest","type":"assertion.attest","id":"assertion-1","expectedVersion":1,"grounding":"verified","method":"human review","scope":"commit","evidence":[]}',
      ]) {
        const test = harness();
        const error = yield* test.run(["command", "--json", command]).pipe(Effect.flip);
        expect(error.detail).toContain("requires a person");
        expect(test.execute).not.toHaveBeenCalled();
      }
    }),
  );

  it.effect("preserves explicit path, symbol and temporal filters for retrieval", () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* test.run([
        "search",
        "fix snapshot",
        "--file",
        "src/dates.ts",
        "--file",
        "tests/dates.test.ts",
        "--symbol",
        "snapshot",
        "--valid-at",
        "2026-09-20T00:00:00Z",
        "--known-at",
        "2026-09-21T00:00:00Z",
        "--include-archived",
      ]);
      expect(test.search.mock.calls[0]?.[0].search).toMatchObject({
        query: "fix snapshot",
        paths: ["src/dates.ts", "tests/dates.test.ts"],
        symbols: ["snapshot"],
        validAt: "2026-09-20T00:00:00Z",
        knownAt: "2026-09-21T00:00:00Z",
        includeArchived: true,
      });
    });
  });
});
