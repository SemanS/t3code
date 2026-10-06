// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - herdr speaks newline-delimited JSON over a local Unix socket; replies are decoded with Schema, and its waits and retry windows run on the wall clock.
/**
 * herdr — the coding agents herdr (https://herdr.dev) runs on this computer,
 * read through its local socket API: `agent.list` names every agent with its
 * state (working, blocked, done, idle), `events.subscribe` says when that
 * changes, `agent.focus` brings one forward in herdr, `agent.start` starts one.
 * Peer shows them and reports them as work on the project whose checkout they
 * run in.
 *
 * @module peerHub/herdr
 */
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PeerWorkStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { isSafeGitRef } from "./gitSafety.ts";

export interface HerdrAgent {
  /** Stable while the terminal lives; pane ids move when panes do. */
  readonly terminalId: string;
  readonly paneId: string;
  /** A live name follows the current occupant; prefer it to a pane when prompting. */
  readonly name?: string | undefined;
  readonly agent: string | undefined;
  readonly title: string;
  readonly status: PeerWorkStatus;
  /**
   * herdr's number for the change of state that ended the agent's last piece of
   * work, while it sits idle after it. Startup, restored sessions and switched
   * conversations never set it, and herdr before 0.9.2 sends none, so its
   * absence says nothing by itself.
   */
  readonly completionSeq: number | undefined;
  readonly cwd: string | undefined;
  /**
   * The agent's own session, when an integration reported it to herdr (e.g.
   * `herdr integration install claude`): its id, or the file it keeps.
   */
  readonly session:
    | { readonly id: string | undefined; readonly path: string | undefined }
    | undefined;
}

const NullableString = Schema.optional(Schema.NullOr(Schema.String));

const AgentInfo = Schema.Struct({
  terminal_id: Schema.String,
  pane_id: Schema.String,
  agent: NullableString,
  agent_status: Schema.String,
  completion_seq: Schema.optional(Schema.NullOr(Schema.Number)),
  cwd: NullableString,
  foreground_cwd: NullableString,
  title: NullableString,
  display_agent: NullableString,
  name: NullableString,
  terminal_title_stripped: NullableString,
  agent_session: Schema.optional(
    Schema.NullOr(Schema.Struct({ kind: Schema.String, value: Schema.String })),
  ),
});

const AgentList = Schema.Struct({
  type: Schema.Literal("agent_list"),
  agents: Schema.Array(AgentInfo),
});
const decodeAgentList = Schema.decodeUnknownOption(AgentList);

const STATUSES: ReadonlySet<string> = new Set(["working", "blocked", "done", "idle", "unknown"]);

/**
 * Where herdr's server listens, resolved the way herdr resolves it:
 * HERDR_SOCKET_PATH, then a named HERDR_SESSION, then the default session
 * under $XDG_CONFIG_HOME (or ~/.config).
 */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HERDR_SOCKET_PATH?.trim();
  if (explicit) return explicit;
  const base = NodePath.join(
    env.XDG_CONFIG_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".config"),
    "herdr",
  );
  const session = env.HERDR_SESSION?.trim();
  return session
    ? NodePath.join(base, "sessions", session, "herdr.sock")
    : NodePath.join(base, "herdr.sock");
}

/** herdr answered and refused: its error code (`pane_not_found`, `agent_not_idle`, …) and message. */
class HerdrRefused extends Error {
  readonly code: string | undefined;
  constructor(code: string | undefined, message: string) {
    super(message);
    this.name = "HerdrRefused";
    this.code = code;
  }
}

class HerdrTransportError extends Error {
  readonly submitted: boolean;
  constructor(message: string, submitted: boolean) {
    super(message);
    this.submitted = submitted;
  }
}

/** The refusal in an error reply; replies from other herdr versions may leave out the code. */
function refusalOf(error: unknown): HerdrRefused {
  const body = typeof error === "object" && error !== null ? error : {};
  const { code, message } = body as { code?: unknown; message?: unknown };
  return new HerdrRefused(
    typeof code === "string" ? code : undefined,
    String(message ?? "herdr refused the request"),
  );
}

/** One request, one reply, over a fresh connection. */
function call(
  socketPath: string,
  method: string,
  params: object,
  timeoutMs = 2000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = `peer-${NodeCrypto.randomUUID()}`;
    const socket = NodeNet.createConnection(socketPath);
    let buffer = "";
    let submitted = false;
    let settled = false;
    const finish = (error: Error | null, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error)
        reject(
          error instanceof HerdrRefused ? error : new HerdrTransportError(error.message, submitted),
        );
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("herdr did not answer")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      submitted = true;
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("herdr closed the connection before answering")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error !== undefined) finish(refusalOf(message.error));
        else finish(null, message.result);
        return;
      }
    });
  });
}

function pick(...values: ReadonlyArray<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/**
 * The agents herdr runs, or null when no herdr server listens here. Agents
 * from a newer herdr with states Peer does not know read as "unknown".
 */
export async function listHerdrAgents(
  socketPath: string = herdrSocketPath(),
): Promise<ReadonlyArray<HerdrAgent> | null> {
  if (!NodeFS.existsSync(socketPath)) return null;
  let result: unknown;
  try {
    result = await call(socketPath, "agent.list", {});
  } catch {
    return null;
  }
  const decoded = decodeAgentList(result);
  if (Option.isNone(decoded)) return null;
  return decoded.value.agents.map((info) => ({
    terminalId: info.terminal_id,
    paneId: info.pane_id,
    ...(pick(info.name) === undefined ? {} : { name: pick(info.name) }),
    agent: pick(info.agent),
    title:
      pick(info.title, info.terminal_title_stripped, info.name, info.display_agent, info.agent) ??
      "agent",
    status: (STATUSES.has(info.agent_status) ? info.agent_status : "unknown") as PeerWorkStatus,
    completionSeq: info.completion_seq ?? undefined,
    cwd: pick(info.foreground_cwd, info.cwd),
    session: sessionOf(info.agent_session),
  }));
}

function sessionOf(
  reported: { readonly kind: string; readonly value: string } | null | undefined,
): HerdrAgent["session"] {
  const value = reported?.value.trim();
  if (value === undefined || value === "") return undefined;
  if (reported?.kind === "path") {
    const file = NodePath.basename(value);
    return {
      id: file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : undefined,
      path: value,
    };
  }
  return { id: value, path: undefined };
}

/**
 * What to tell the team an agent is doing. herdr calls finished work "done"
 * only until someone has looked at it, and counts a server with no client
 * attached as looking at its active tab, so a finished agent can read "idle".
 * Its `completion_seq` says the idle state follows real work whoever looked;
 * that is "done" like a Peer thread that settled. Without it herdr's own state
 * stands: older herdr sends none, and so does an agent that finished nothing.
 */
export function herdrWorkStatus(
  agent: Pick<HerdrAgent, "status" | "completionSeq">,
): PeerWorkStatus {
  return agent.status === "idle" && agent.completionSeq !== undefined ? "done" : agent.status;
}

const PaneRead = Schema.Struct({
  type: Schema.Literal("pane_read"),
  read: Schema.Struct({ text: Schema.String }),
});
const decodePaneRead = Schema.decodeUnknownOption(PaneRead);

/** What reading the end of an agent's terminal gave. */
export type HerdrRead =
  | { readonly kind: "text"; readonly text: string }
  /** herdr scrolls a full-screen agent back only while it is idle, so it refused. */
  | { readonly kind: "notIdle" }
  | { readonly kind: "unavailable" };

/** The end of an agent's terminal as plain text, when herdr can read it. */
export async function readHerdrAgent(
  paneId: string,
  lines = 200,
  socketPath: string = herdrSocketPath(),
): Promise<HerdrRead> {
  let result: unknown;
  try {
    result = await call(socketPath, "agent.read", {
      target: paneId,
      source: "recent_unwrapped",
      lines,
      format: "text",
      strip_ansi: true,
    });
  } catch (error) {
    return error instanceof HerdrRefused && error.code === "agent_not_idle"
      ? { kind: "notIdle" }
      : { kind: "unavailable" };
  }
  const decoded = decodePaneRead(result);
  return Option.isSome(decoded)
    ? { kind: "text", text: decoded.value.read.text }
    : { kind: "unavailable" };
}

/** What a view says while herdr will not read the agent's history: it can be read once the agent pauses. */
export function herdrNotIdleHint(status: PeerWorkStatus): string {
  if (status === "blocked") return "blocked — output appears once it is answered";
  if (status === "unknown") return "status unknown — output appears when it pauses";
  return "working — output appears when it pauses";
}

/** Submits a prompt to an agent, as if typed into its terminal and sent. */
export async function promptHerdrAgent(
  paneId: string,
  text: string,
  socketPath: string = herdrSocketPath(),
): Promise<void> {
  await call(socketPath, "agent.prompt", { target: paneId, text }, 5000);
}

export type HerdrWakeResult = {
  readonly status: "queued" | "uncertain" | "unavailable";
  readonly reason?: string;
};

/**
 * Re-read identity before waking an idle agent. A lost reply is not retried:
 * herdr may already have typed the marker. Only the receiving hook establishes
 * delivery. herdr has no native-session compare-and-swap on agent.prompt.
 */
export async function wakeHerdrAgent(
  expected: HerdrAgent,
  text: string,
  socketPath: string = herdrSocketPath(),
): Promise<HerdrWakeResult> {
  const fresh = (await listHerdrAgents(socketPath))?.find(
    (agent) => agent.terminalId === expected.terminalId,
  );
  if (
    fresh === undefined ||
    fresh.agent !== expected.agent ||
    fresh.session?.id !== expected.session?.id ||
    fresh.session?.path !== expected.session?.path ||
    fresh.completionSeq !== expected.completionSeq ||
    (fresh.status !== "idle" && fresh.status !== "done") ||
    (expected.session?.id === undefined && expected.session?.path === undefined)
  )
    return { status: "unavailable", reason: "Agent identity or idle state changed." };
  try {
    await promptHerdrAgent(fresh.name ?? fresh.paneId, text, socketPath);
    return { status: "queued" };
  } catch (error) {
    return {
      status: error instanceof HerdrTransportError && error.submitted ? "uncertain" : "unavailable",
      reason: error instanceof Error ? error.message : "herdr did not take the marker",
    };
  }
}

/** Paths from Git's NUL-delimited status; rename/copy records carry an extra source path. */
export function herdrStatusPaths(status: string): ReadonlyArray<string> {
  const entries = status.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.length < 4 || entry[2] !== " ") continue;
    paths.add(entry.slice(3));
    if (entry.slice(0, 2).includes("R") || entry.slice(0, 2).includes("C")) {
      const source = entries[++index];
      if (source) paths.add(source);
    }
  }
  return [...paths].toSorted();
}

/** Live enforcement sessions take precedence over observations within the hub's report limit. */
export function boundHerdrObservations<T>(
  primary: ReadonlyArray<T>,
  observations: ReadonlyArray<T>,
) {
  const available = Math.max(0, 50 - primary.length);
  return {
    sessions: [...primary, ...observations.slice(0, available)],
    skipped: Math.max(0, observations.length - available),
  };
}

/** Observes uncommitted paths in this worktree after work; it cannot attribute every change to its agent. */
export function readHerdrChangedPaths(cwd: string): Promise<ReadonlyArray<string> | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { timeout: 3000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, stdout) => resolve(error === null ? herdrStatusPaths(stdout) : null),
    );
  });
}

/** completion_seq catches a whole turn between polls; old servers need an observed working → idle edge. */
export class HerdrCompletionTracker {
  private readonly observed = new Map<
    string,
    { status: PeerWorkStatus; seq: number | undefined }
  >();

  completed(agent: HerdrAgent): boolean {
    const key = [
      agent.terminalId,
      agent.agent,
      agent.session?.id,
      agent.session?.path,
      agent.cwd,
    ].join("\0");
    const before = this.observed.get(key);
    this.observed.set(key, { status: agent.status, seq: agent.completionSeq });
    if (this.observed.size > 500) this.observed.delete(this.observed.keys().next().value!);
    if (agent.status !== "idle" && agent.status !== "done") return false;
    return agent.completionSeq !== undefined
      ? agent.completionSeq !== before?.seq
      : before?.status === "working";
  }
}

/** Brings the agent's pane forward in herdr's attached client. */
export async function focusHerdrAgent(
  paneId: string,
  socketPath: string = herdrSocketPath(),
): Promise<void> {
  await call(socketPath, "agent.focus", { target: paneId });
}

/** Shows a notification through herdr's attached client; nothing when herdr is not running. */
export async function notifyHerdr(
  title: string,
  body: string,
  socketPath: string = herdrSocketPath(),
): Promise<void> {
  if (!NodeFS.existsSync(socketPath)) return;
  await call(socketPath, "notification.show", { title, body, sound: "request" }).catch(
    () => undefined,
  );
}

/**
 * How a subscription ended, or never began: herdr's server went away; it
 * dropped a subscriber that fell behind (`events_lost`); it refused the whole
 * request because a pane in it no longer exists; or it refused it some other
 * way, as herdr before events did.
 */
export type HerdrWatchEnd = "gone" | "events-lost" | "pane-gone" | "refused";

export interface HerdrWatch {
  /** "started" once herdr has acknowledged the subscription, else how it ended instead. */
  readonly started: Promise<"started" | HerdrWatchEnd>;
  readonly close: () => void;
}

const ACK_TIMEOUT_MS = 5_000;

/**
 * Calls `onChange` whenever herdr reports an agent appearing or going away
 * anywhere, or one of `paneIds` changing state; the events only say that
 * something changed, `agent.list` says what. herdr keeps no history, so only
 * what happens after `started` resolves "started" is heard. After that,
 * `onEnd` says why the subscription ended on its own (not after `close`).
 */
export function watchHerdrAgents(input: {
  readonly paneIds: ReadonlyArray<string>;
  readonly onChange: () => void;
  readonly onEnd: (reason: HerdrWatchEnd) => void;
  readonly socketPath?: string;
  readonly ackTimeoutMs?: number;
}): HerdrWatch {
  const id = `peer-watch-${NodeCrypto.randomUUID()}`;
  const socket = NodeNet.createConnection(input.socketPath ?? herdrSocketPath());
  const started = Promise.withResolvers<"started" | HerdrWatchEnd>();
  let buffer = "";
  let acknowledged = false;
  let ended = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const end = (reason: HerdrWatchEnd) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    socket.destroy();
    started.resolve(reason);
    if (acknowledged) input.onEnd(reason);
  };
  // A herdr that never answers is as good as one that refuses.
  timer = setTimeout(() => end("refused"), input.ackTimeoutMs ?? ACK_TIMEOUT_MS);
  socket.setEncoding("utf8");
  socket.on("connect", () => {
    const subscriptions = [
      { type: "pane.agent_detected" },
      { type: "pane.exited" },
      { type: "pane.closed" },
      ...input.paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
    ];
    socket.write(
      `${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } })}\n`,
    );
  });
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: { id?: unknown; event?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.event === "string") input.onChange();
      else if (message.id === id && message.error !== undefined) {
        const { code } = refusalOf(message.error);
        if (code === "events_lost") end("events-lost");
        // One unknown pane rejects the whole request, and only before it is acknowledged.
        else if (!acknowledged && (code === "pane_not_found" || code === "not_found")) {
          end("pane-gone");
        } else end("refused");
      } else if (message.id === id && !acknowledged) {
        acknowledged = true;
        clearTimeout(timer);
        started.resolve("started");
      }
    }
  });
  socket.on("error", () => end("gone"));
  socket.on("close", () => end("gone"));
  return {
    started: started.promise,
    close: () => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      socket.destroy();
      started.resolve("gone");
    },
  };
}

export interface HerdrFollower {
  /**
   * The agents herdr runs, listed once herdr's events are flowing, or null
   * when no herdr server listens here. Reads queue up behind one another.
   */
  readonly read: () => Promise<ReadonlyArray<HerdrAgent> | null>;
  /** Whether herdr's events are flowing; when they are not, the caller reads on a timer. */
  readonly live: () => boolean;
  readonly close: () => void;
}

const SUBSCRIBE_ATTEMPTS = 4;
const READ_ROUNDS = 4;

/**
 * Keeps herdr's events flowing and reads its agents the way herdr advises:
 * subscribe first, list after. herdr keeps no history, so a change between a
 * list and the subscription behind it would not be heard of until the next
 * read. `onChange` says to read again: an event, or events lost.
 *
 * - A subscription follows the panes that run agents, so it is made again when
 *   a list shows others. A pane that vanished meanwhile makes herdr refuse the
 *   whole request; the panes are listed again and the rest subscribed.
 * - A subscriber that fell behind (`events_lost`) is dropped by herdr; the next
 *   read subscribes again before it lists.
 * - Only a herdr that refuses events altogether is left to polling, and asked
 *   again after `retryMs`.
 */
export function followHerdrAgents(input: {
  readonly onChange: () => void;
  readonly socketPath?: string;
  readonly retryMs?: number;
  /** The clock `retryMs` runs on; a test moves it instead of waiting. */
  readonly now?: () => number;
}): HerdrFollower {
  const retryMs = input.retryMs ?? 15_000;
  const now = input.now ?? Date.now;
  let watch: { readonly handle: HerdrWatch; readonly panes: string } | null = null;
  let known: ReadonlyArray<string> = [];
  let eventsAfter = 0;
  let closed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const paneIdsOf = (agents: ReadonlyArray<HerdrAgent>) =>
    agents.map((agent) => agent.paneId).toSorted();
  const keyOf = (panes: ReadonlyArray<string>) => panes.join(" ");
  const stop = () => {
    watch?.handle.close();
    watch = null;
  };

  const subscribe = async (path: string, wanted: ReadonlyArray<string>): Promise<void> => {
    if (now() < eventsAfter) return;
    if (watch !== null && watch.panes === keyOf(wanted)) return;
    stop();
    let panes = wanted;
    for (let attempt = 0; attempt < SUBSCRIBE_ATTEMPTS; attempt++) {
      if (closed) return;
      // herdr may drop a subscriber right after acknowledging it, while it is still starting up.
      let droppedAtOnce = false;
      const handle: HerdrWatch = watchHerdrAgents({
        paneIds: panes,
        onChange: input.onChange,
        onEnd: (reason) => {
          droppedAtOnce = true;
          if (watch?.handle === handle) watch = null;
          // An error mid-stream would only repeat; leave events alone for a while.
          if (reason === "refused") eventsAfter = now() + retryMs;
          input.onChange();
        },
        socketPath: path,
      });
      const outcome = await handle.started;
      if (closed) {
        handle.close();
        return;
      }
      if (outcome === "started" && !droppedAtOnce) {
        watch = { handle, panes: keyOf(panes) };
        return;
      }
      if (now() < eventsAfter) return;
      if (outcome === "gone" || outcome === "refused") break;
      if (outcome === "pane-gone") {
        // A pane left between the list and the subscription: who is there now?
        const present = await listHerdrAgents(path);
        if (present === null) return;
        panes = paneIdsOf(present);
      }
      // Events lost while subscribing, or the panes just refreshed: subscribe again at once.
    }
    // No subscription to be had: poll for a while, then ask again.
    eventsAfter = now() + retryMs;
  };

  const readOnce = async (): Promise<ReadonlyArray<HerdrAgent> | null> => {
    const path = input.socketPath ?? herdrSocketPath();
    if (closed) return listHerdrAgents(path);
    if (!NodeFS.existsSync(path)) {
      stop();
      known = [];
      return null;
    }
    let agents: ReadonlyArray<HerdrAgent> | null = null;
    for (let round = 0; round < READ_ROUNDS; round++) {
      await subscribe(path, known);
      agents = await listHerdrAgents(path);
      if (agents === null) {
        stop();
        known = [];
        return null;
      }
      known = paneIdsOf(agents);
      // Done when the subscription follows exactly these panes, or herdr has no events to follow.
      if (closed || now() < eventsAfter || (watch !== null && watch.panes === keyOf(known))) break;
    }
    return agents;
  };

  return {
    read: () => {
      const run = queue.then(readOnce, readOnce);
      queue = run.catch(() => undefined);
      return run;
    },
    live: () => watch !== null,
    close: () => {
      closed = true;
      stop();
    },
  };
}

export type HerdrHarness = "claude" | "codex";
const HARNESSES: ReadonlySet<string> = new Set<HerdrHarness>(["claude", "codex"]);

/** The herdr workspace Peer starts agents in, so they stay out of the person's own. */
const PEER_WORKSPACE = "Peer agents";

export interface StartHerdrAgentInput {
  readonly cwd: string;
  readonly harness: HerdrHarness;
  /** The first thing the agent is asked, once it is ready for it. */
  readonly prompt?: string | undefined;
  /** Set in the pane's shell, so the agent has it too. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** A dedicated task checkout; no shell interpolation or edits to the person's current tree. */
export async function prepareHerdrTaskWorktree(input: {
  readonly checkout: string;
  readonly baseBranch: string;
  readonly worktrees: string;
  readonly task: string;
}): Promise<{ readonly cwd: string; readonly branch: string }> {
  if (!NodePath.isAbsolute(input.checkout) || !NodePath.isAbsolute(input.worktrees)) {
    throw new Error("The checkout and worktree directories must be full paths");
  }
  if (!isSafeGitRef(input.baseBranch))
    throw new Error("The repository branch is not a safe Git ref");
  const task =
    input.task
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "task";
  const name = `${task}-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const branch = `feature/${name}`;
  const cwd = NodePath.join(input.worktrees, name);
  await NodeFSP.mkdir(input.worktrees, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    NodeChildProcess.execFile(
      "git",
      ["-C", input.checkout, "worktree", "add", "-b", branch, "--", cwd, input.baseBranch],
      { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: "utf8", windowsHide: true },
      (error, _stdout, stderr) =>
        error === null ? resolve() : reject(new Error(stderr.trim() || error.message)),
    );
  });
  return { cwd, branch };
}

export interface StartedHerdrAgent {
  readonly paneId: string;
  readonly terminalId: string;
  /** Set when the agent runs but did not take its prompt (it may wait on an answer first). */
  readonly promptError?: string;
}

export interface StartHerdrAgentOptions {
  readonly socketPath?: string;
  /** Between asking herdr whether the shell or the agent is ready yet. */
  readonly pollMs?: number;
  /** How long a new pane's shell may take to reach its prompt. */
  readonly shellMs?: number;
  /** How long the agent may take to be ready for input. */
  readonly readyMs?: number;
}

const PaneIds = Schema.Struct({ pane_id: Schema.String, terminal_id: Schema.String });
const decodeWorkspaceList = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("workspace_list"),
    workspaces: Schema.Array(Schema.Struct({ workspace_id: Schema.String, label: Schema.String })),
  }),
);
const decodeSplit = Schema.decodeUnknownOption(
  Schema.Struct({ type: Schema.Literal("pane_info"), pane: PaneIds }),
);
const decodeWorkspaceCreated = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("workspace_created"),
    workspace: Schema.Struct({ workspace_id: Schema.String }),
    root_pane: PaneIds,
  }),
);
const decodeAgentGet = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("agent_info"),
    agent: Schema.Struct({
      terminal_id: Schema.String,
      agent_status: Schema.String,
      agent: NullableString,
      name: NullableString,
      interactive_ready: Schema.optional(Schema.Boolean),
      launch_pending: Schema.optional(Schema.Boolean),
    }),
  }),
);
const decodeProcessInfo = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("pane_process_info"),
    process_info: Schema.Struct({
      shell_pid: Schema.optional(Schema.NullOr(Schema.Number)),
      foreground_process_group_id: Schema.optional(Schema.NullOr(Schema.Number)),
      foreground_processes: Schema.optional(
        Schema.Array(
          Schema.Struct({
            pid: Schema.Number,
            name: Schema.String,
            argv: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
          }),
        ),
      ),
    }),
  }),
);

const SHELL_NAMES: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "mksh",
  "csh",
  "tcsh",
  "elvish",
  "xonsh",
  "nu",
  "pwsh",
  "powershell",
  "cmd",
]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A new pane for an agent: a split of Peer's own herdr workspace if it has one, else a new workspace. */
async function openPane(path: string, input: StartHerdrAgentInput) {
  const env =
    input.env !== undefined && Object.keys(input.env).length > 0 ? { env: input.env } : {};
  const listed = decodeWorkspaceList(await call(path, "workspace.list", {}));
  // The newest one: when an older one's panes are too small to split, a new one is made below.
  const home = Option.isSome(listed)
    ? listed.value.workspaces.findLast((workspace) => workspace.label === PEER_WORKSPACE)
    : undefined;
  if (home !== undefined) {
    try {
      const split = decodeSplit(
        await call(
          path,
          "pane.split",
          {
            workspace_id: home.workspace_id,
            direction: "right",
            cwd: input.cwd,
            focus: false,
            ...env,
          },
          5000,
        ),
      );
      if (Option.isSome(split)) {
        const { pane_id, terminal_id } = split.value.pane;
        return {
          paneId: pane_id,
          terminalId: terminal_id,
          // Only the pane Peer made: the workspace and the agents in it are the person's now.
          undo: () => call(path, "pane.close", { pane_id }).then(() => undefined),
        };
      }
    } catch (error) {
      // Closed since the list, or too crowded to split: make a new one.
      if (!(error instanceof HerdrRefused)) throw error;
    }
  }
  const created = decodeWorkspaceCreated(
    await call(
      path,
      "workspace.create",
      { cwd: input.cwd, label: PEER_WORKSPACE, focus: false, ...env },
      5000,
    ),
  );
  if (Option.isNone(created)) throw new Error("herdr answered in a way Peer does not know");
  const { workspace, root_pane } = created.value;
  return {
    paneId: root_pane.pane_id,
    terminalId: root_pane.terminal_id,
    undo: () =>
      call(path, "workspace.close", { workspace_id: workspace.workspace_id }).then(() => undefined),
  };
}

const isShell = (name: string | null | undefined) =>
  name !== undefined &&
  name !== null &&
  SHELL_NAMES.has(
    NodePath.basename(name)
      .replace(/^-/, "")
      .replace(/\.exe$/i, "")
      .toLowerCase(),
  );

/**
 * Whether the pane's shell still owns its terminal, as herdr's own CLI asks
 * before retrying a start: it is loading its startup files, not busy with
 * something else.
 */
async function shellInitializing(path: string, paneId: string): Promise<boolean> {
  let result: unknown;
  try {
    result = await call(path, "pane.process_info", { pane_id: paneId });
  } catch {
    return false;
  }
  const decoded = decodeProcessInfo(result);
  if (Option.isNone(decoded)) return false;
  const info = decoded.value.process_info;
  const shell = info.shell_pid;
  if (shell === undefined || shell === null || info.foreground_process_group_id !== shell) {
    return false;
  }
  return (info.foreground_processes ?? []).some(
    (process) => process.pid === shell && (isShell(process.name) || isShell(process.argv?.[0])),
  );
}

async function getAgent(path: string, target: string) {
  try {
    const decoded = decodeAgentGet(await call(path, "agent.get", { target }));
    return Option.isSome(decoded) ? decoded.value.agent : null;
  } catch {
    return null;
  }
}

/**
 * `agent.start` only types the command into the shell and answers. Like
 * herdr's CLI, wait until the agent is detected and ready for input, which
 * is what lets it take a prompt. "blocked" is an agent that waits on an
 * answer (a trust prompt) before it is ready: it runs, the person answers.
 */
async function waitUntilReady(
  path: string,
  agent: { readonly name: string; readonly paneId: string; readonly terminalId: string },
  harness: HerdrHarness,
  options: { readonly pollMs: number; readonly readyMs: number },
): Promise<"ready" | "blocked"> {
  const deadline = Date.now() + options.readyMs;
  while (Date.now() < deadline) {
    const info = (await getAgent(path, agent.name)) ?? (await getAgent(path, agent.paneId));
    if (info !== null) {
      if (info.terminal_id !== agent.terminalId || (info.name ?? agent.name) !== agent.name) {
        throw new HerdrRefused("agent_name_not_found", "the pane no longer holds the agent");
      }
      if (info.agent !== undefined && info.agent !== null && info.agent !== harness) {
        throw new HerdrRefused("agent_kind_mismatch", `expected ${harness}, found ${info.agent}`);
      }
      const ready = info.interactive_ready === true;
      if (info.agent_status === "blocked") return "blocked";
      // Codex can stay "unknown" after it is ready.
      if (ready && (info.agent_status === "idle" || info.agent_status === "done")) return "ready";
      if (ready && info.agent_status === "unknown" && harness === "codex") return "ready";
      if (
        !ready &&
        info.launch_pending !== true &&
        (info.agent_status === "idle" || info.agent_status === "done")
      ) {
        throw new HerdrRefused(
          "agent_start_failed",
          "the agent exited before it became interactive",
        );
      }
    }
    await sleep(options.pollMs);
  }
  throw new HerdrRefused("timeout", "the agent was not ready in time");
}

/**
 * Starts a Claude Code or Codex agent in herdr, in `cwd`: in a new pane of
 * Peer's own herdr workspace, which it makes when it has none. Waits for the
 * pane's shell to reach its prompt, then for the agent to be ready, then
 * gives it `prompt`. herdr refusing the start leaves nothing behind; once the
 * command was typed into the pane it stays, for the person to see what happened.
 */
export async function startHerdrAgent(
  input: StartHerdrAgentInput,
  options: StartHerdrAgentOptions = {},
): Promise<StartedHerdrAgent> {
  const path = options.socketPath ?? herdrSocketPath();
  const pollMs = options.pollMs ?? 100;
  const shellMs = options.shellMs ?? 10_000;
  const readyMs = options.readyMs ?? 30_000;
  if (!HARNESSES.has(input.harness)) throw new Error(`Peer cannot start a ${input.harness} agent`);
  if (!NodePath.isAbsolute(input.cwd)) throw new Error("The agent's directory must be a full path");
  if (NodeFS.statSync(input.cwd, { throwIfNoEntry: false })?.isDirectory() !== true) {
    throw new Error(`${input.cwd} is not a directory`);
  }
  if (!NodeFS.existsSync(path)) throw new Error("herdr is not running on this computer");

  const pane = await openPane(path, input);
  const name = `peer-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const shellDeadline = Date.now() + shellMs;
  // herdr takes between 3 and 300 seconds for an agent to start.
  const startupMs = Math.min(Math.max(readyMs, 3_001), 300_000);
  for (;;) {
    try {
      await call(
        path,
        "agent.start",
        { name, kind: input.harness, pane_id: pane.paneId, timeout_ms: startupMs },
        5000,
      );
      break;
    } catch (error) {
      // A fresh pane's shell is busy loading its startup files for a moment.
      const waiting =
        error instanceof HerdrRefused &&
        error.code === "agent_pane_busy" &&
        Date.now() < shellDeadline &&
        (await shellInitializing(path, pane.paneId));
      if (!waiting) {
        // A lost reply may have followed a successful launch. Keep that pane:
        // undoing an uncertain start could terminate an agent already at work.
        if (error instanceof HerdrTransportError && error.submitted) {
          throw new Error(
            `The launch could not be confirmed. Inspect pane ${pane.paneId} in herdr before retrying.`,
            { cause: error },
          );
        }
        await pane.undo().catch(() => undefined);
        throw error;
      }
      await sleep(pollMs);
    }
  }

  let ready: "ready" | "blocked";
  try {
    ready = await waitUntilReady(
      path,
      { name, paneId: pane.paneId, terminalId: pane.terminalId },
      input.harness,
      { pollMs, readyMs },
    );
  } catch (error) {
    if (error instanceof HerdrRefused) {
      throw new HerdrRefused(error.code, `${error.message} (see pane ${pane.paneId} in herdr)`);
    }
    throw error;
  }

  const started = { paneId: pane.paneId, terminalId: pane.terminalId };
  if (input.prompt === undefined || input.prompt.trim() === "") return started;
  if (ready === "blocked") {
    return {
      ...started,
      promptError: "the agent waits for an answer in herdr before it can take the prompt",
    };
  }
  try {
    await promptHerdrAgent(pane.paneId, input.prompt, path);
    return started;
  } catch (error) {
    return {
      ...started,
      promptError: error instanceof Error ? error.message : "herdr did not take the prompt",
    };
  }
}
