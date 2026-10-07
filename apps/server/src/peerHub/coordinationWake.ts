import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderContinuationRequests from "../orchestration-v2/ProviderContinuationRequests.ts";
import { harnessForDriver } from "./hubPolicy.ts";
import { nativeRuntimePresent } from "./workLifecycle.ts";

/** App-owned native threads must enter through admission, never the CLI's independent queue. */
export const queueCoordinationWake = Effect.fn("PeerHub.queueCoordinationWake")(function* (
  nativeId: string,
  text: string,
  boundThread?: string,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  let threadId = boundThread?.startsWith("peer:") ? ThreadId.make(boundThread.slice(5)) : undefined;
  if (threadId === undefined) {
    // A hook can arrive before its app binding is persisted. Check historical native
    // refs too: a stopped or replaced app runtime must not fall back to `codex queue`.
    for (const location of ["active", "archive"] as const) {
      const shell = yield* projections.getShellSnapshot({ location });
      for (const thread of shell.threads) {
        const records = yield* projections.getThreadRecords(thread.id, ["providerThreads"]);
        if (
          records.providerThreads.some(
            (provider) =>
              harnessForDriver(provider.driver) === "codex" &&
              provider.nativeThreadRef?.nativeId === nativeId,
          )
        ) {
          threadId = thread.id;
          break;
        }
      }
      if (threadId !== undefined) break;
    }
  }
  if (threadId === undefined) return "unbound" as const;
  const id = threadId;
  const current = Effect.gen(function* () {
    const shell = yield* projections.getThreadShell(id);
    if (shell === null || shell.archivedAt !== null || shell.deletedAt !== null) return undefined;
    const records = yield* projections.getThreadRecords(id, [
      "providerThreads",
      "providerSessions",
    ]);
    const provider = records.providerThreads.find(
      (entry) => entry.id === shell.activeProviderThreadId,
    );
    return provider?.nativeThreadRef?.nativeId === nativeId &&
      harnessForDriver(provider.driver) === "codex" &&
      nativeRuntimePresent(provider, records.providerSessions)
      ? provider
      : undefined;
  });
  const provider = yield* current;
  if (provider === undefined) return "unavailable" as const;
  const admitted = yield* Deferred.make<boolean>();
  const reject = () => Deferred.succeed(admitted, false).pipe(Effect.asVoid);
  yield* requests.offer({
    threadId: id,
    providerThreadId: provider.id,
    driver: provider.driver,
    detail: text,
    delivery: "message_text",
    clearIfCurrent: reject,
    onDispatchFailure: reject,
    notification: {
      source: { kind: "background_task" },
      outcome: "updated",
      summary: "Peer coordination update",
      detail: text,
    },
    // Closing, replacing, or stopping the runtime while queued revokes this wake.
    dispatchIfCurrent: (effect) =>
      Effect.gen(function* () {
        const latest = yield* current.pipe(Effect.orElseSucceed(() => undefined));
        if (latest?.id !== provider.id || latest.providerSessionId !== provider.providerSessionId) {
          yield* reject();
          return Option.none();
        }
        const result = yield* effect;
        yield* Deferred.succeed(admitted, true);
        return Option.some(result);
      }),
  });
  return (yield* Deferred.await(admitted)) ? ("queued" as const) : ("unavailable" as const);
});
