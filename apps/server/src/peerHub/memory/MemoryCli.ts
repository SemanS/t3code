// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off - operation identities, never provider credentials.
import * as NodeCrypto from "node:crypto";
import {
  PeerMemoryCommand,
  PeerMemoryProjection,
  PeerMemoryRecordView,
  PeerMemorySearchResult,
  PeerMemoryWriteResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as MemoryService from "./MemoryService.ts";
import * as MemoryTransport from "./MemoryTransport.ts";
import * as Knowledge from "./knowledge.ts";

export class MemoryCli extends Context.Service<
  MemoryCli,
  {
    readonly run: (
      session: MemoryService.MemorySession,
      command: string,
      args: ReadonlyArray<string>,
    ) => Effect.Effect<string, MemoryTransport.MemoryError>;
  }
>()("t3/peerHub/memory/MemoryCli") {}

const jsonWrite = Schema.encodeSync(Schema.fromJsonString(PeerMemoryWriteResult));
const jsonSearch = Schema.encodeSync(Schema.fromJsonString(PeerMemorySearchResult));
const jsonRead = Schema.encodeSync(Schema.fromJsonString(PeerMemoryRecordView));
const jsonProjection = Schema.encodeSync(Schema.fromJsonString(PeerMemoryProjection));
const decodeCommand = Schema.decodeUnknownEffect(PeerMemoryCommand);
const decodeJsonCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(PeerMemoryCommand));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const invalid = (detail: string) => new MemoryTransport.MemoryError({ code: "invalid", detail });
const refs = (values: ReadonlyArray<string>) =>
  values
    .flatMap((value) => value.split(","))
    .map((value) => {
      const at = value.lastIndexOf("@");
      return { id: value.slice(0, at), version: Number(value.slice(at + 1)) };
    });
const parse = (args: ReadonlyArray<string>) => {
  const flags = new Map<string, string[]>();
  const plain: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) {
      plain.push(arg);
      continue;
    }
    if (arg === "--include-archived") {
      flags.set(arg, ["true"]);
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    flags.set(arg, [...(flags.get(arg) ?? []), value]);
  }
  return {
    plain,
    one: (flag: string) => flags.get(flag)?.[0],
    all: (flag: string) => flags.get(flag) ?? [],
  };
};

export const agentCommand = (
  session: MemoryService.MemorySession,
  command: PeerMemoryCommand,
): PeerMemoryCommand => ({
  ...command,
  sessionId: session.sessionId,
  environmentId: session.environmentId,
  runtimeGeneration: session.runtimeGeneration,
  workId: session.workId,
  ...(session.taskId === undefined ? {} : { taskId: session.taskId }),
});
export const assertAgentCommand = (command: PeerMemoryCommand) =>
  [
    "record.publish",
    "record.erase",
    "knowledge.import",
    "knowledge.keep",
    "knowledge.reject",
    "decision.decide",
  ].includes(command.type) ||
  (command.type === "assertion.attest" && command.grounding === "verified")
    ? Effect.fail(invalid("This memory review or publication operation requires a person in Peer."))
    : Effect.void;

const make = Effect.gen(function* () {
  const memory = yield* MemoryService.MemoryService;
  const run = Effect.fn("MemoryCli.run")(function* (
    session: MemoryService.MemorySession,
    top: string,
    args: ReadonlyArray<string>,
  ) {
    const parsed = yield* Effect.try({
      try: () => parse(args),
      catch: () => invalid("Every memory flag needs a value."),
    });
    const { one, all, plain } = parsed;
    const action = top === "remember" ? "remember" : (plain.shift() ?? "status");
    const text = plain.join(" ");
    const scope = { workspace: session.workspace, project: one("--project") ?? session.project };
    if (
      scope.project !== session.project &&
      (scope.project !== "company" ||
        !["status", "sync", "search", "index", "read", "project", "ack", "consumed"].includes(
          action,
        ))
    )
      return yield* invalid(
        "A runtime can read explicit company scope; memory mutations belong to its own project.",
      );
    if (action === "status" || action === "sync") {
      const state = yield* memory.synchronize(scope);
      return `Peer Memory ${state.mode}: ${state.available ? "available" : "unavailable"}; ${state.pendingLocal} pending local, ${state.blockedLocal} blocked; change cursor ${state.cursor}. All provider adapters use companion context.`;
    }
    if (action === "search" || action === "index") {
      return jsonSearch(
        yield* memory.search({
          ...scope,
          search: {
            contextIds: all("--context"),
            ...(action === "index" ? {} : { query: text }),
            paths: all("--file"),
            symbols: all("--symbol"),
            ...(one("--task") === undefined ? {} : { taskId: one("--task") }),
            ...(one("--work") === undefined ? {} : { workId: one("--work") }),
            ...(session.repositoryId === undefined || scope.project === "company"
              ? {}
              : { repositoryId: session.repositoryId }),
            ...(one("--commit") === undefined ? {} : { commit: one("--commit") }),
            ...(one("--environment") === undefined ? {} : { environment: one("--environment") }),
            ...(one("--valid-at") === undefined ? {} : { validAt: one("--valid-at") }),
            ...(one("--known-at") === undefined ? {} : { knownAt: one("--known-at") }),
            ...(one("--limit") === undefined ? {} : { limit: Number(one("--limit")) }),
            ...(one("--cursor") === undefined ? {} : { cursor: Number(one("--cursor")) }),
            includeArchived: one("--include-archived") === "true",
          },
        }),
      );
    }
    if (action === "read")
      return jsonRead(
        yield* memory.read({
          ...scope,
          id: plain[0] ?? "",
          ...(one("--version") === undefined ? {} : { version: Number(one("--version")) }),
          ...(one("--known-at") === undefined ? {} : { knownAt: one("--known-at") }),
        }),
      );
    if (action === "project") {
      const result = yield* memory.projectForSession(
        session,
        {
          include: refs(all("--include")),
          purpose: one("--purpose") ?? session.workId,
          ...(one("--budget") === undefined ? {} : { budget: Number(one("--budget")) }),
          ...(session.repositoryId === undefined || scope.project === "company"
            ? {}
            : { repositoryId: session.repositoryId }),
          ...(one("--commit") === undefined ? {} : { commit: one("--commit") }),
          ...(one("--environment") === undefined ? {} : { environment: one("--environment") }),
          ...(one("--valid-at") === undefined ? {} : { validAt: one("--valid-at") }),
          ...(one("--known-at") === undefined ? {} : { knownAt: one("--known-at") }),
        },
        scope,
      );
      return `${jsonProjection(result.projection)}\nImmutable projection: ${result.projectionPath}\nManifest: ${result.manifestPath}\nYour private current file: ${result.currentPath}`;
    }
    if (action === "checkpoint")
      return (yield* memory.checkpoint(session, text || "manual checkpoint")).path;
    if (action === "restore-checkpoint")
      return (yield* memory.restoreCheckpoint(session, plain[0] ?? "")).path;
    if (action === "notice") return yield* memory.sessionNotice(session);
    if (action === "ack" || action === "consumed") {
      const evidence =
        one("--output-hash") === undefined
          ? undefined
          : {
              kind: "artifact" as const,
              command: one("--command") ?? "runtime result",
              outputHash: one("--output-hash"),
              result: one("--result") ?? "completed",
              weak: false,
            };
      const result = yield* memory.receipt(
        session,
        {
          state: action === "ack" ? "acknowledged" : "consumed",
          projectionId: one("--projection"),
          records: refs(all("--include")),
          ...(evidence === undefined ? {} : { outputRef: evidence }),
        },
        scope,
      );
      return `${result.state}: ${result.records.map((ref) => `${ref.id}@${ref.version}`).join(", ")}`;
    }
    const envelope = {
      schemaVersion: 1,
      operationId: one("--operation") ?? NodeCrypto.randomUUID(),
      ...(one("--valid-from") === undefined ? {} : { validFrom: one("--valid-from") }),
      ...(one("--valid-to") === undefined ? {} : { validTo: one("--valid-to") }),
      ...(one("--observed-at") === undefined ? {} : { observedAt: one("--observed-at") }),
      consumed: refs(all("--consumed")),
    };
    const evidence = yield* Effect.forEach(all("--evidence"), (location) =>
      Knowledge.gitEvidence(session, location),
    );
    const applicability = action === "remember" ? yield* Knowledge.gitApplicability(session) : {};
    const mutation = { id: plain[0] ?? "", expectedVersion: Number(one("--version")) };
    let raw: unknown;
    if (action === "remember")
      raw = {
        ...envelope,
        type: "assertion.record",
        claim: one("--claim") ?? text,
        contextIds: all("--context"),
        evidence,
        derivedFrom: refs(all("--derived-from")),
        independence:
          all("--consumed").length > 0 || all("--derived-from").length > 0
            ? "dependent"
            : "unknown",
        applicability: {
          ...applicability,
          ...(session.repositoryId === undefined ? {} : { repositoryId: session.repositoryId }),
          ...(one("--commit") === undefined ? {} : { revision: one("--commit") }),
          ...(one("--environment") === undefined ? {} : { environment: one("--environment") }),
        },
      };
    else if (action === "command")
      raw = yield* decodeJsonCommand(one("--json") ?? text).pipe(
        Effect.mapError(() => invalid("Provide a versioned memory command as JSON.")),
      );
    else if (
      [
        "dispute",
        "correct",
        "retract",
        "supersede",
        "attest",
        "restore",
        "answer",
        "decision",
        "question",
      ].includes(action)
    ) {
      if (action === "decision")
        raw = {
          ...envelope,
          type: "decision.record",
          choice: text,
          reasons: one("--reason") ?? "",
          alternatives: all("--alternative"),
          contextIds: all("--context"),
        };
      else if (action === "question")
        raw = {
          ...envelope,
          type: "question.record",
          question: text,
          contextIds: all("--context"),
          ...(one("--owner") === undefined ? {} : { owner: one("--owner") }),
        };
      else if (action === "answer")
        raw = {
          ...envelope,
          ...mutation,
          type: "question.answer",
          answer: one("--answer") ?? plain.slice(1).join(" "),
          references: refs(all("--include")),
        };
      else if (action === "restore")
        raw = {
          ...envelope,
          ...mutation,
          type: "record.restore",
          version: Number(one("--restore-version")),
          reason: one("--reason") ?? "",
        };
      else if (action === "attest")
        raw = {
          ...envelope,
          ...mutation,
          type: "assertion.attest",
          method: one("--method") ?? "",
          scope: one("--scope") ?? "",
          grounding: "corroborated",
          evidence,
        };
      else if (action === "supersede")
        raw = {
          ...envelope,
          ...mutation,
          type: "assertion.supersede",
          successor: refs(all("--successor"))[0],
          reason: one("--reason") ?? "",
        };
      else
        raw = {
          ...envelope,
          ...mutation,
          type: action === "retract" ? "record.retract" : `assertion.${action}`,
          reason: one("--reason") ?? "",
          ...(action === "correct"
            ? { claim: one("--claim") ?? "", evidence }
            : action === "dispute"
              ? { evidence }
              : {}),
        };
    } else if (action === "context") {
      const sub = plain.shift();
      const contextMutation = { id: plain[0] ?? "", expectedVersion: Number(one("--version")) };
      if (sub === "create")
        raw = {
          ...envelope,
          type: "context.create",
          title: plain.join(" "),
          description: one("--description") ?? "",
          aliases: all("--alias"),
        };
      else if (sub === "update")
        raw = {
          ...envelope,
          ...contextMutation,
          type: "context.update",
          title: one("--title") ?? "",
          description: one("--description") ?? "",
          aliases: all("--alias"),
        };
      else if (sub === "link")
        raw = {
          ...envelope,
          type: "context.link",
          relation: one("--relation") ?? "relates_to",
          from: { kind: one("--from-kind") ?? "record", id: plain[0] ?? "" },
          to: { kind: one("--to-kind") ?? "record", id: plain[1] ?? "" },
          reason: one("--reason") ?? "",
        };
      else if (sub === "move")
        raw = { ...envelope, ...contextMutation, type: "context.move", parentIds: all("--parent") };
      else if (sub === "merge")
        raw = {
          ...envelope,
          ...contextMutation,
          type: "context.merge",
          sourceIds: refs(all("--source")),
          reason: one("--reason") ?? "",
        };
      else if (sub === "split")
        raw = {
          ...envelope,
          ...contextMutation,
          type: "context.split",
          contexts: yield* decodeJson(one("--contexts-json") ?? "[]").pipe(
            Effect.mapError(() => invalid("Split needs contexts JSON.")),
          ),
          reason: one("--reason") ?? "",
        };
      else if (sub === "archive")
        raw = {
          ...envelope,
          ...contextMutation,
          type: "context.archive",
          reason: one("--reason") ?? "",
        };
      else if (sub === "unlink" || sub === "resolve")
        raw = {
          ...envelope,
          ...contextMutation,
          type: sub === "unlink" ? "relation.end" : "relation.resolve",
          reason: one("--reason") ?? "",
        };
      else
        return "peer memory context create|update|link|move|merge|split|archive|unlink|resolve. Mutations need --version; structural operations need --reason.";
    } else
      return "peer remember --claim <finding> [--evidence path:line] · peer memory search|read|project|dispute|correct|retract|supersede|attest|decision|question|answer|restore|context|checkpoint|restore-checkpoint|notice|ack|consumed|command|sync. A stored write is shared; pending_local remains on this computer.";
    const command = yield* decodeCommand(raw).pipe(
      Effect.mapError(() =>
        invalid(
          "The memory command is incomplete. Mutations require --version; corrections and structural changes need --reason.",
        ),
      ),
    );
    yield* assertAgentCommand(command);
    return jsonWrite(yield* memory.execute({ ...scope, command: agentCommand(session, command) }));
  });
  return MemoryCli.of({ run });
});
export const layer = Layer.effect(MemoryCli, make);
