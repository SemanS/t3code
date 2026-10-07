import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
  ProviderAdapterV2TurnInput,
} from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "./ProviderContinuationRequests.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

it.effect(
  "queues a Peer coordination continuation as a distinct run and preserves the user's final answer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("codex");
        const instanceId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId, model: "test-model" };
        const cwd = yield* checkpointWorkspace("coordination-continuation");
        const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
        const started = yield* Queue.unbounded<ProviderAdapterV2TurnInput>();
        const sharedRequests =
          yield* Deferred.make<
            (
              request: ProviderContinuationRequests.ProviderContinuationRequest,
            ) => Effect.Effect<void>
          >();
        const adapter: ProviderAdapterV2Shape = {
          instanceId,
          driver,
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
          openSession: (input) =>
            Effect.gen(function* () {
              const now = yield* DateTime.now;
              return {
                instanceId,
                driver,
                providerSessionId: input.providerSessionId,
                providerSession: {
                  id: input.providerSessionId,
                  driver,
                  providerInstanceId: instanceId,
                  status: "ready",
                  cwd,
                  model: modelSelection.model,
                  capabilities: CodexProviderCapabilitiesV2,
                  createdAt: now,
                  updatedAt: now,
                  lastError: null,
                },
                events: Stream.fromQueue(events),
                ensureThread: ({ threadId }) =>
                  Effect.succeed({
                    id: ProviderThreadId.make(`provider-thread:${threadId}`),
                    driver,
                    providerInstanceId: instanceId,
                    providerSessionId: input.providerSessionId,
                    appThreadId: threadId,
                    ownerNodeId: null,
                    nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                    nativeConversationHeadRef: null,
                    status: "idle",
                    firstRunOrdinal: null,
                    lastRunOrdinal: null,
                    handoffIds: [],
                    forkedFrom: null,
                    createdAt: now,
                    updatedAt: now,
                  }),
                resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
                startTurn: (turn) =>
                  Effect.gen(function* () {
                    yield* Queue.offer(started, turn);
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "running",
                        startedAt: now,
                        completedAt: null,
                      },
                    });
                  }),
                steerTurn: () =>
                  Effect.die("Coordination must queue instead of steering user work"),
                interruptTurn: () => Effect.void,
                respondToRuntimeRequest: () => Effect.void,
                readThreadSnapshot: () => Effect.die("unused"),
                rollbackThread: () => Effect.die("unused"),
                forkThread: () => Effect.die("unused"),
              };
            }),
        };
        const registry = ProviderAdapterRegistry.makeLayerEffect(
          Effect.gen(function* () {
            const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
            yield* Deferred.succeed(sharedRequests, requests.offer);
            return [adapter];
          }),
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const offer = yield* Deferred.await(sharedRequests);

          const threadId = ThreadId.make("thread:coordination-continuation");
          const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
            orchestrator.streamDomainEvents.pipe(
              Stream.filter(predicate),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create"),
            threadId,
            projectId: ProjectId.make("project:coordination-continuation"),
            title: "Board helpers",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const running = yield* watch(
            (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("implementation"),
            threadId,
            messageId: MessageId.make("message:implementation"),
            text: "Implement the board helpers.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain();
          yield* Fiber.join(running);
          const first = yield* Queue.take(started);
          const queued = yield* watch(
            (event) =>
              event.type === "run.created" &&
              event.payload.ordinal === 2 &&
              event.payload.status === "queued",
          );
          const detail = "Read Agent B's question and reply through Peer.";
          yield* offer({
            threadId,
            providerThreadId: first.providerThread.id,
            driver,
            detail,
            delivery: "message_text",
            notification: {
              source: { kind: "background_task" },
              outcome: "updated",
              summary: "Peer coordination update",
              detail,
            },
          });
          yield* Fiber.join(queued);
          const waiting = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            waiting.runs.map((run) => run.status),
            ["running", "queued"],
          );
          assert.isTrue((yield* Queue.size(started)) === 0);
          const finish = (turnInput: ProviderAdapterV2TurnInput, text: string) =>
            Effect.gen(function* () {
              const current = yield* orchestrator.getThreadProjection(threadId);
              const turn = current.providerTurns.find(
                (turn) => turn.runAttemptId === turnInput.attemptId,
              )!;
              const completedAt = yield* DateTime.now;
              const completion = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === turnInput.runId &&
                  event.payload.status === "waiting",
              );
              yield* Queue.offer(events, {
                type: "message.updated",
                driver,
                message: {
                  id: MessageId.make(`answer:${turnInput.runId}`),
                  threadId,
                  runId: turnInput.runId,
                  nodeId: null,
                  role: "assistant",
                  text,
                  attachments: [],
                  streaming: false,
                  createdAt: completedAt,
                  updatedAt: completedAt,
                  createdBy: "agent",
                  creationSource: "provider",
                },
              });
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...turn, status: "completed", completedAt },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThreadId,
                providerTurnId: turn.id,
                runOrdinal: turnInput.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              yield* Fiber.join(completion);
              yield* worker.drain();
            });
          const originalFinal = "Implemented and pushed. All 14 tests pass.";
          yield* finish(first, originalFinal);
          const nextRunning = yield* watch(
            (event) =>
              event.type === "provider-turn.updated" &&
              event.payload.status === "running" &&
              event.payload.runAttemptId !== first.attemptId,
          );
          yield* orchestrator.resumeQueuedRuns;
          yield* worker.drain();
          yield* Fiber.join(nextRunning);
          const second = yield* Queue.take(started);
          assert.notEqual(second.runId, first.runId);
          assert.notEqual(second.attemptId, first.attemptId);
          assert.equal(second.message.text, detail);
          assert.equal(second.message.createdBy, "agent");
          assert.equal(second.message.creationSource, "server");
          yield* finish(second, "Replied through Peer. Code stays unchanged.");
          const final = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            final.messages
              .filter((message) => message.role === "assistant")
              .map((message) => ({ text: message.text, runId: message.runId })),
            [
              { text: originalFinal, runId: first.runId },
              { text: "Replied through Peer. Code stays unchanged.", runId: second.runId },
            ],
          );
          assert.deepEqual(
            final.runs.map((run) => run.status),
            ["completed", "completed"],
          );
          assert.equal(final.providerTurns.length, 2);
          assert.notEqual(final.providerTurns[0]!.id, final.providerTurns[1]!.id);
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              { name: "coordination-continuation" },
              registry,
              { runEffectWorker: false, runContinuationWorker: true },
            ),
          ),
        );
      }),
    ),
);
