import { describe, expect, it } from "@effect/vitest";
import {
  ThreadId,
  ProviderThreadId,
  ProviderDriverKind,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderContinuationRequests from "../orchestration-v2/ProviderContinuationRequests.ts";
import { queueCoordinationWake } from "./coordinationWake.ts";

const threadId = ThreadId.make("thread-peer-wake");
const providerId = ProviderThreadId.make("provider-peer-wake");
const fixture = () => {
  const state = {
    archived: false,
    runtime: "ready",
    nativeId: "native-one",
    available: true,
    reject: false,
  };
  const offered: ProviderContinuationRequests.ProviderContinuationRequest[] = [];
  const shell = () =>
    ({
      id: threadId,
      activeProviderThreadId: providerId,
      archivedAt: state.archived ? "2026-10-07" : null,
      deletedAt: null,
    }) as unknown as OrchestrationV2ThreadShell;
  const layer = Layer.merge(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(state.available ? shell() : null),
      getShellSnapshot: ({ location } = {}) =>
        Effect.succeed({
          threads: state.available && (location === "archive") === state.archived ? [shell()] : [],
        } as never),
      getThreadRecords: () =>
        Effect.succeed({
          providerThreads: [
            {
              id: providerId,
              driver: ProviderDriverKind.make("codex"),
              status: "idle",
              providerSessionId: "session-one",
              nativeThreadRef: { nativeId: state.nativeId },
            },
          ],
          providerSessions: [{ id: "session-one", status: state.runtime }],
        } as never),
    }),
    Layer.succeed(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: (request) =>
        Effect.gen(function* () {
          offered.push(request);
          if (state.reject) yield* request.onDispatchFailure?.() ?? Effect.void;
          else yield* request.dispatchIfCurrent?.(Effect.void) ?? Effect.void;
        }),
      take: Effect.never,
    }),
  );
  return { state, offered, layer };
};

describe("Peer coordination wake admission", () => {
  it.effect("returns failure to retain pending news when continuation admission fails", () => {
    const f = fixture();
    f.state.reject = true;
    return Effect.gen(function* () {
      expect(
        yield* queueCoordinationWake("native-one", "Keep this update", `peer:${threadId}`),
      ).toBe("unavailable");
      expect(f.offered).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("admits a resident app thread as a message-text continuation", () => {
    const f = fixture();
    return Effect.gen(function* () {
      expect(
        yield* queueCoordinationWake("native-one", "Read context v2", `peer:${threadId}`),
      ).toBe("queued");
      expect(f.offered[0]).toMatchObject({
        threadId,
        providerThreadId: providerId,
        delivery: "message_text",
        detail: "Read context v2",
      });
      expect(Option.isSome(yield* f.offered[0]!.dispatchIfCurrent!(Effect.succeed("sent")))).toBe(
        true,
      );
      f.state.runtime = "stopped";
      let ran = false;
      expect(
        Option.isNone(
          yield* f.offered[0]!.dispatchIfCurrent!(
            Effect.sync(() => {
              ran = true;
            }),
          ),
        ),
      ).toBe(true);
      expect(ran).toBe(false);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect("finds app ownership before a hook has its app binding", () => {
    const f = fixture();
    return Effect.gen(function* () {
      expect(yield* queueCoordinationWake("native-one", "Update")).toBe("queued");
      f.state.archived = true;
      expect(yield* queueCoordinationWake("native-one", "Update")).toBe("unavailable");
      expect(f.offered).toHaveLength(1);
    }).pipe(Effect.provide(f.layer));
  });

  it.effect(
    "never falls back to native queue for a stopped, replaced, or missing bound thread",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        f.state.runtime = "stopped";
        expect(yield* queueCoordinationWake("native-one", "Update", `peer:${threadId}`)).toBe(
          "unavailable",
        );
        f.state.runtime = "ready";
        f.state.nativeId = "replacement";
        expect(yield* queueCoordinationWake("native-one", "Update", `peer:${threadId}`)).toBe(
          "unavailable",
        );
        f.state.available = false;
        expect(yield* queueCoordinationWake("native-one", "Update", `peer:${threadId}`)).toBe(
          "unavailable",
        );
        expect(f.offered).toHaveLength(0);
        expect(yield* queueCoordinationWake("external-native", "Update")).toBe("unbound");
      }).pipe(Effect.provide(f.layer));
    },
  );
});
