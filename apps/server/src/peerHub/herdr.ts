// @effect-diagnostics nodeBuiltinImport:off globalTimers:off preferSchemaOverJson:off - herdr speaks newline-delimited JSON over a local Unix socket; replies are decoded with Schema.
/**
 * herdr — the coding agents herdr (https://herdr.dev) runs on this computer,
 * read through its local socket API: `agent.list` names every agent with its
 * state (working, blocked, done, idle), `events.subscribe` says when that
 * changes, `agent.focus` brings one forward in herdr. Peer shows them and
 * reports them as work on the project whose checkout they run in.
 *
 * @module peerHub/herdr
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PeerWorkStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface HerdrAgent {
  /** Stable while the terminal lives; pane ids move when panes do. */
  readonly terminalId: string;
  readonly paneId: string;
  readonly agent: string | undefined;
  readonly title: string;
  readonly status: PeerWorkStatus;
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
    const finish = (error: Error | null, result?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error("herdr did not answer")), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("error", (error) => finish(error));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== id) continue;
        if (message.error !== undefined) {
          finish(new Error(String(message.error.message ?? "herdr refused the request")));
        } else {
          finish(null, message.result);
        }
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
    agent: pick(info.agent),
    title:
      pick(info.title, info.terminal_title_stripped, info.name, info.display_agent, info.agent) ??
      "agent",
    status: (STATUSES.has(info.agent_status) ? info.agent_status : "unknown") as PeerWorkStatus,
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

const PaneRead = Schema.Struct({
  type: Schema.Literal("pane_read"),
  read: Schema.Struct({ text: Schema.String }),
});
const decodePaneRead = Schema.decodeUnknownOption(PaneRead);

/** The end of an agent's terminal as plain text, or null when herdr cannot read it. */
export async function readHerdrAgent(
  paneId: string,
  lines = 200,
  socketPath: string = herdrSocketPath(),
): Promise<string | null> {
  let result: unknown;
  try {
    result = await call(socketPath, "agent.read", {
      target: paneId,
      source: "recent_unwrapped",
      lines,
      format: "text",
      strip_ansi: true,
    });
  } catch {
    return null;
  }
  const decoded = decodePaneRead(result);
  return Option.isSome(decoded) ? decoded.value.read.text : null;
}

/** Submits a prompt to an agent, as if typed into its terminal and sent. */
export async function promptHerdrAgent(
  paneId: string,
  text: string,
  socketPath: string = herdrSocketPath(),
): Promise<void> {
  await call(socketPath, "agent.prompt", { target: paneId, text }, 5000);
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

export interface HerdrWatch {
  readonly close: () => void;
}

/**
 * Calls `onChange` whenever herdr reports an agent appearing or going away
 * anywhere, or one of `paneIds` changing state; the events only say that
 * something changed, `agent.list` says what. Ends with `onEnd(subscribed)` when
 * herdr's server goes away (subscribed) or refuses the subscription, as herdr
 * before events did (not subscribed); not after `close`.
 */
export function watchHerdrAgents(input: {
  readonly paneIds: ReadonlyArray<string>;
  readonly onChange: () => void;
  readonly onEnd: (subscribed: boolean) => void;
  readonly socketPath?: string;
}): HerdrWatch {
  const id = `peer-watch-${NodeCrypto.randomUUID()}`;
  const socket = NodeNet.createConnection(input.socketPath ?? herdrSocketPath());
  let buffer = "";
  let subscribed = false;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    socket.destroy();
    input.onEnd(subscribed);
  };
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
      else if (message.id === id && message.error !== undefined) end();
      else if (message.id === id) subscribed = true;
    }
  });
  socket.on("error", end);
  socket.on("close", end);
  return {
    close: () => {
      ended = true;
      socket.destroy();
    },
  };
}
