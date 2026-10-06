// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - a fake herdr server on a Unix socket, speaking its newline-delimited JSON.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  followHerdrAgents,
  herdrNotIdleHint,
  herdrWorkStatus,
  listHerdrAgents,
  readHerdrAgent,
  startHerdrAgent,
  watchHerdrAgents,
  type HerdrWatchEnd,
} from "./herdr.ts";

interface FakeRequest {
  readonly connection: number;
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface FakeConnection {
  readonly write: (message: object) => void;
  readonly end: () => void;
}

/** What herdr says to a request; `after` runs once the reply is written. */
type FakeReply =
  | { readonly result: object; readonly after?: () => void }
  | { readonly error: { readonly code?: string; readonly message: string } }
  | undefined;

const line = (message: object) => `${JSON.stringify(message)}\n`;

/** Fake herdr servers still listening when a test ends, even by failing. */
const listening: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of listening.splice(0)) await stop();
});

/** A herdr server that answers every request the way `answer` says, and keeps a record of them. */
async function fakeHerdr(answer: (request: FakeRequest, connection: FakeConnection) => FakeReply) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "herdr-"));
  const socketPath = NodePath.join(dir, "h.sock");
  const sockets: NodeNet.Socket[] = [];
  const connections: FakeConnection[] = [];
  const requests: FakeRequest[] = [];
  /** Each request, then its reply as `<method> ok` or `<method> <error code>`, as they happened. */
  const log: string[] = [];
  const server = NodeNet.createServer((socket) => {
    const index = sockets.push(socket) - 1;
    const connection: FakeConnection = {
      write: (message) => socket.write(line(message)),
      end: () => socket.end(),
    };
    connections.push(connection);
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const request: FakeRequest = {
          connection: index,
          id: message.id,
          method: message.method,
          params: message.params,
        };
        requests.push(request);
        log.push(request.method);
        const reply = answer(request, connection);
        if (reply === undefined) continue;
        if ("error" in reply) {
          connection.write({ id: request.id, error: reply.error });
          log.push(`${request.method} ${reply.error.code ?? "error"}`);
        } else {
          connection.write({ id: request.id, result: reply.result });
          log.push(`${request.method} ok`);
          reply.after?.();
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  /** herdr's server going away. */
  const stop = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => {
        NodeFS.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
    });
  listening.push(stop);
  return {
    socketPath,
    requests,
    log,
    connections,
    /** How many times herdr was asked for `method`. */
    count: (method: string) => requests.filter((request) => request.method === method).length,
    stop,
  };
}

const subscribed: FakeReply = { result: { type: "subscription_started" } };
/** herdr takes the subscription, then `after` happens: an event, or the subscription dropped. */
const subscribedThen = (after: () => void): FakeReply => ({
  result: { type: "subscription_started" },
  after,
});
const eventsLost = {
  error: { code: "events_lost", message: "event subscription fell behind retained history" },
};
const unknownMethod = { error: { code: "unknown_method", message: "unknown method" } };

const agentInfo = (paneId: string, extra: Record<string, unknown> = {}) => ({
  terminal_id: `t-${paneId}`,
  pane_id: paneId,
  agent: "claude",
  agent_status: "idle",
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused: false,
  revision: 1,
  ...extra,
});
const agentList = (agents: ReadonlyArray<object>) => ({ type: "agent_list", agents });

const subscriptionsOf = (request: FakeRequest) =>
  (request.params as { subscriptions: ReadonlyArray<{ type: string; pane_id?: string }> })
    .subscriptions;
/** The panes a subscription follows the state of. */
const panesOf = (request: FakeRequest) =>
  subscriptionsOf(request)
    .filter((subscription) => subscription.type === "pane.agent_status_changed")
    .map((subscription) => subscription.pane_id);

/** What a test hears of herdr's events: a way to wait for the next one. */
function hearing() {
  const waiting: Array<() => void> = [];
  return {
    onChange: () => waiting.shift()?.(),
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
  };
}

describe("watchHerdrAgents", () => {
  it("follows the agents' panes, passes their events on, and says when herdr goes away", async () => {
    const herdr = await fakeHerdr((_request, connection) =>
      subscribedThen(() =>
        connection.write({
          event: "pane.agent_status_changed",
          data: { pane_id: "w1:p2", agent: "claude", agent_status: "blocked" },
        }),
      ),
    );
    const changed = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<HerdrWatchEnd>();
    const watch = watchHerdrAgents({
      socketPath: herdr.socketPath,
      paneIds: ["w1:p2"],
      onChange: () => changed.resolve(),
      onEnd: (reason) => ended.resolve(reason),
    });
    assert.strictEqual(await watch.started, "started");
    await changed.promise;
    assert.strictEqual(herdr.requests[0]?.method, "events.subscribe");
    assert.deepStrictEqual(subscriptionsOf(herdr.requests[0]!), [
      { type: "pane.agent_detected" },
      { type: "pane.exited" },
      { type: "pane.closed" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ]);
    await herdr.stop();
    assert.strictEqual(await ended.promise, "gone", "it had subscribed before herdr went away");
  });

  it("says when herdr refuses the subscription, as one from before events does", async () => {
    const herdr = await fakeHerdr(() => ({ error: { message: "unknown method" } }));
    const watch = watchHerdrAgents({
      socketPath: herdr.socketPath,
      paneIds: [],
      onChange: () => assert.fail("a refused subscription sends no events"),
      onEnd: () => assert.fail("one that never began does not end"),
    });
    assert.strictEqual(await watch.started, "refused");
    await herdr.stop();
  });

  it("says when herdr refuses the request over a pane that is gone", async () => {
    const herdr = await fakeHerdr(() => ({
      error: { code: "pane_not_found", message: "pane w1:p9 not found" },
    }));
    const watch = watchHerdrAgents({
      socketPath: herdr.socketPath,
      paneIds: ["w1:p9"],
      onChange: () => undefined,
      onEnd: () => undefined,
    });
    assert.strictEqual(await watch.started, "pane-gone");
    await herdr.stop();
  });

  it("says when herdr drops it for falling behind, before or after it began", async () => {
    const before = await fakeHerdr(() => eventsLost);
    const early = watchHerdrAgents({
      socketPath: before.socketPath,
      paneIds: [],
      onChange: () => undefined,
      onEnd: () => assert.fail("one that never began does not end"),
    });
    assert.strictEqual(await early.started, "events-lost");
    await before.stop();

    const after = await fakeHerdr((request, connection) =>
      subscribedThen(() => {
        connection.write({ id: request.id, ...eventsLost });
        connection.end();
      }),
    );
    const ended = Promise.withResolvers<HerdrWatchEnd>();
    const late = watchHerdrAgents({
      socketPath: after.socketPath,
      paneIds: [],
      onChange: () => undefined,
      onEnd: (reason) => ended.resolve(reason),
    });
    assert.strictEqual(await late.started, "started");
    assert.strictEqual(await ended.promise, "events-lost");
    await after.stop();
  });
});

describe("followHerdrAgents", () => {
  it("subscribes before it lists, so a change in between is not missed", async () => {
    let status = "working";
    const heard = hearing();
    const herdr = await fakeHerdr((request, connection) => {
      if (request.method === "events.subscribe") {
        // The agent finishes right after herdr takes the subscription, before the list is asked for.
        return subscribedThen(() => {
          status = "done";
          connection.write({
            event: "pane.agent_status_changed",
            data: { pane_id: "w1:p1", agent_status: "done" },
          });
        });
      }
      if (request.method === "agent.list") {
        return { result: agentList([agentInfo("w1:p1", { agent_status: status })]) };
      }
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: heard.onChange });
    const event = heard.next();
    const agents = await follower.read();
    assert.deepStrictEqual(
      herdr.log.slice(0, 3),
      ["events.subscribe", "events.subscribe ok", "agent.list"],
      "no list is asked for before herdr has taken a subscription",
    );
    assert.strictEqual(agents?.[0]?.status, "done");
    await event;
    follower.close();
    await herdr.stop();
  });

  it("follows exactly the panes that run agents, subscribing again when they change", async () => {
    let panes = ["w1:p1"];
    const herdr = await fakeHerdr((request) => {
      if (request.method === "events.subscribe") return subscribed;
      if (request.method === "agent.list") {
        return { result: agentList(panes.map((pane) => agentInfo(pane))) };
      }
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: () => undefined });
    await follower.read();
    const steady = herdr.count("events.subscribe");
    await follower.read();
    assert.strictEqual(herdr.count("events.subscribe"), steady, "a list alone changes nothing");

    panes = ["w1:p1", "w1:p2"];
    const agents = await follower.read();
    assert.deepStrictEqual(
      agents?.map((agent) => agent.paneId),
      ["w1:p1", "w1:p2"],
    );
    const subscriptions = herdr.requests.filter((request) => request.method === "events.subscribe");
    assert.deepStrictEqual(panesOf(subscriptions.at(-1)!), ["w1:p1", "w1:p2"]);
    assert.deepStrictEqual(
      herdr.log.slice(-4),
      ["events.subscribe", "events.subscribe ok", "agent.list", "agent.list ok"],
      "the list that shows the new pane is read again after subscribing to it",
    );
    assert.isTrue(follower.live());
    follower.close();
    await herdr.stop();
  });

  it("lists again, subscribing first, when herdr drops it for falling behind", async () => {
    let status = "working";
    const heard = hearing();
    const herdr = await fakeHerdr((request) => {
      if (request.method === "events.subscribe") return subscribed;
      if (request.method === "agent.list") {
        return { result: agentList([agentInfo("w1:p1", { agent_status: status })]) };
      }
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: heard.onChange });
    await follower.read();
    assert.isTrue(follower.live());

    // herdr sends the error under the subscription's own id, and closes it.
    const subscription = herdr.requests.findLast(
      (request) => request.method === "events.subscribe",
    )!;
    const lost = heard.next();
    herdr.connections[subscription.connection]!.write({ id: subscription.id, ...eventsLost });
    herdr.connections[subscription.connection]!.end();
    await lost;
    assert.isFalse(follower.live(), "what it knew is stale: it reads again at once");

    status = "done";
    const before = herdr.log.length;
    const agents = await follower.read();
    assert.strictEqual(agents?.[0]?.status, "done");
    assert.deepStrictEqual(herdr.log.slice(before, before + 3), [
      "events.subscribe",
      "events.subscribe ok",
      "agent.list",
    ]);
    assert.isTrue(follower.live(), "events are not given up on");
    follower.close();
    await herdr.stop();
  });

  it("subscribes again at once when events are lost while it subscribes", async () => {
    let subscriptions = 0;
    const herdr = await fakeHerdr((request) => {
      if (request.method === "events.subscribe") {
        subscriptions += 1;
        return subscriptions === 1 ? eventsLost : subscribed;
      }
      if (request.method === "agent.list") return { result: agentList([agentInfo("w1:p1")]) };
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: () => undefined });
    const agents = await follower.read();
    assert.strictEqual(agents?.length, 1);
    assert.isTrue(follower.live());
    assert.strictEqual(herdr.log[1], "events.subscribe events_lost");
    assert.strictEqual(herdr.log[2], "events.subscribe");
    follower.close();
    await herdr.stop();
  });

  it("does not take a subscription herdr dropped right after acknowledging it for a live one", async () => {
    const heard = hearing();
    let subscriptions = 0;
    const herdr = await fakeHerdr((request, connection) => {
      if (request.method === "events.subscribe") {
        subscriptions += 1;
        // The third subscription is the one after the first read's two, and it is dropped at once.
        return subscriptions === 3
          ? subscribedThen(() => {
              connection.write({ id: request.id, ...eventsLost });
              connection.end();
            })
          : subscribed;
      }
      if (request.method === "agent.list") return { result: agentList([agentInfo("w1:p1")]) };
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: heard.onChange });
    await follower.read();
    const first = herdr.requests.findLast((request) => request.method === "events.subscribe")!;
    const lost = heard.next();
    herdr.connections[first.connection]!.write({ id: first.id, ...eventsLost });
    herdr.connections[first.connection]!.end();
    await lost;

    await follower.read();
    assert.strictEqual(herdr.count("events.subscribe"), 4, "the dropped one was replaced");
    assert.isTrue(follower.live());
    const last = herdr.requests.findLast((request) => request.method === "events.subscribe")!;
    const event = heard.next();
    herdr.connections[last.connection]!.write({ event: "pane.closed", data: { pane_id: "w1:p1" } });
    await event;
    follower.close();
    await herdr.stop();
  });

  it("drops a pane that vanished before the subscription and subscribes again, without polling", async () => {
    const panes = new Set(["w1:p1", "w1:p2"]);
    let lists = 0;
    const herdr = await fakeHerdr((request) => {
      if (request.method === "agent.list") {
        lists += 1;
        return {
          result: agentList([...panes].map((pane) => agentInfo(pane))),
          // The pane is gone by the time Peer subscribes to the panes it just listed.
          after: () => {
            if (lists === 1) panes.delete("w1:p2");
          },
        };
      }
      if (request.method === "events.subscribe") {
        const gone = panesOf(request).find((pane) => pane !== undefined && !panes.has(pane));
        return gone === undefined
          ? subscribed
          : { error: { code: "pane_not_found", message: `pane ${gone} not found` } };
      }
      return undefined;
    });
    const follower = followHerdrAgents({ socketPath: herdr.socketPath, onChange: () => undefined });
    const agents = await follower.read();
    assert.isTrue(
      herdr.log.includes("events.subscribe pane_not_found"),
      "herdr refused the request",
    );
    assert.deepStrictEqual(
      agents?.map((agent) => agent.paneId),
      ["w1:p1"],
    );
    const subscriptions = herdr.requests.filter((request) => request.method === "events.subscribe");
    assert.deepStrictEqual(panesOf(subscriptions.at(-1)!), ["w1:p1"]);
    assert.isTrue(follower.live(), "an unknown pane is no reason to poll");
    follower.close();
    await herdr.stop();
  });

  it("polls only when herdr takes no events, and asks again after a while", async () => {
    let now = 0;
    const herdr = await fakeHerdr((request) => {
      if (request.method === "events.subscribe") return unknownMethod;
      if (request.method === "agent.list") return { result: agentList([agentInfo("w1:p1")]) };
      return undefined;
    });
    const follower = followHerdrAgents({
      socketPath: herdr.socketPath,
      onChange: () => undefined,
      retryMs: 15_000,
      now: () => now,
    });
    assert.strictEqual((await follower.read())?.length, 1);
    assert.isFalse(follower.live());
    assert.strictEqual(herdr.count("events.subscribe"), 1);

    assert.strictEqual((await follower.read())?.length, 1);
    assert.strictEqual(herdr.count("events.subscribe"), 1, "it does not ask again at once");
    assert.strictEqual(herdr.count("agent.list"), 2);

    now = 15_000;
    await follower.read();
    assert.strictEqual(herdr.count("events.subscribe"), 2, "it asks again after the wait");
    follower.close();
    await herdr.stop();
  });

  it("says nothing is running when no herdr listens", async () => {
    const follower = followHerdrAgents({
      socketPath: NodePath.join(NodeOS.tmpdir(), "herdr-nowhere.sock"),
      onChange: () => undefined,
    });
    assert.isNull(await follower.read());
    assert.isFalse(follower.live());
  });
});

describe("listHerdrAgents", () => {
  it("carries completion_seq when herdr reports it, and nothing when it does not", async () => {
    const herdr = await fakeHerdr(() => ({
      result: agentList([
        agentInfo("w1:p1", { completion_seq: 7 }),
        agentInfo("w1:p2"),
        agentInfo("w1:p3", { completion_seq: null }),
      ]),
    }));
    const agents = await listHerdrAgents(herdr.socketPath);
    assert.deepStrictEqual(
      agents?.map((agent) => agent.completionSeq),
      [7, undefined, undefined],
    );
    await herdr.stop();
  });
});

describe("herdrWorkStatus", () => {
  it("calls an idle agent that finished work done, whoever looked", () => {
    assert.strictEqual(herdrWorkStatus({ status: "idle", completionSeq: 7 }), "done");
  });

  it("keeps herdr's own state when it reports no completion", () => {
    assert.strictEqual(herdrWorkStatus({ status: "done", completionSeq: undefined }), "done");
    assert.strictEqual(herdrWorkStatus({ status: "idle", completionSeq: undefined }), "idle");
  });

  it("leaves an agent that works or waits as it is", () => {
    assert.strictEqual(herdrWorkStatus({ status: "working", completionSeq: undefined }), "working");
    assert.strictEqual(herdrWorkStatus({ status: "blocked", completionSeq: undefined }), "blocked");
    assert.strictEqual(herdrWorkStatus({ status: "unknown", completionSeq: undefined }), "unknown");
  });
});

describe("readHerdrAgent", () => {
  it("shows that herdr will not read a working agent's history, then reads it once it is idle", async () => {
    let status = "working";
    const herdr = await fakeHerdr((request) => {
      if (request.method !== "agent.read") return undefined;
      return status === "working"
        ? {
            error: {
              code: "agent_not_idle",
              message: "cannot read 200 lines while w1:p1 is working",
            },
          }
        : {
            result: {
              type: "pane_read",
              read: { pane_id: "w1:p1", text: "all done\n", source: "recent_unwrapped" },
            },
          };
    });
    assert.deepStrictEqual(await readHerdrAgent("w1:p1", 200, herdr.socketPath), {
      kind: "notIdle",
    });
    assert.deepStrictEqual(herdr.requests[0]?.params, {
      target: "w1:p1",
      source: "recent_unwrapped",
      lines: 200,
      format: "text",
      strip_ansi: true,
    });

    status = "done";
    assert.deepStrictEqual(await readHerdrAgent("w1:p1", 200, herdr.socketPath), {
      kind: "text",
      text: "all done\n",
    });
    await herdr.stop();
  });

  it("does not take any other refusal for a working agent", async () => {
    const herdr = await fakeHerdr(() => ({
      error: { code: "agent_not_found", message: "agent target w1:p1 not found" },
    }));
    assert.deepStrictEqual(await readHerdrAgent("w1:p1", 200, herdr.socketPath), {
      kind: "unavailable",
    });
    await herdr.stop();
  });

  it("says in the view why there is no output yet", () => {
    assert.strictEqual(herdrNotIdleHint("working"), "working — output appears when it pauses");
    assert.strictEqual(herdrNotIdleHint("blocked"), "blocked — output appears once it is answered");
    assert.strictEqual(
      herdrNotIdleHint("unknown"),
      "status unknown — output appears when it pauses",
    );
  });
});

describe("startHerdrAgent", () => {
  const cwd = NodeFS.realpathSync(NodeOS.tmpdir());
  const fast = { pollMs: 0 };

  /** A herdr that starts agents: `starts` answers `agent.start` by attempt, `polls` is what `agent.get` says in turn. */
  function startingHerdr(
    knobs: {
      readonly workspaces?: ReadonlyArray<{ workspace_id: string; label: string }>;
      readonly split?: FakeReply;
      readonly starts?: (attempt: number) => FakeReply;
      readonly initializing?: boolean;
      readonly polls?: ReadonlyArray<Record<string, unknown>>;
      readonly prompt?: FakeReply;
    } = {},
  ) {
    let pane = { pane_id: "w2:p1", terminal_id: "t-w2:p1" };
    let name = "";
    let kind = "";
    let attempts = 0;
    let polled = 0;
    const polls = knobs.polls ?? [
      { agent_status: "unknown", launch_pending: true, interactive_ready: false },
      { agent_status: "idle", launch_pending: false, interactive_ready: true },
    ];
    // What herdr's shell says of itself: it owns the terminal (loading its startup files), or not.
    const foreground = knobs.initializing === false ? 200 : 100;
    return fakeHerdr((request) => {
      switch (request.method) {
        case "workspace.list":
          return {
            result: {
              type: "workspace_list",
              workspaces: knobs.workspaces ?? [{ workspace_id: "w1", label: "work" }],
            },
          };
        case "workspace.create":
          return {
            result: {
              type: "workspace_created",
              workspace: { workspace_id: "w2" },
              tab: { tab_id: "w2:t1" },
              root_pane: pane,
            },
          };
        case "pane.split":
          if (knobs.split !== undefined) return knobs.split;
          pane = { pane_id: "w1:p5", terminal_id: "t-w1:p5" };
          return { result: { type: "pane_info", pane } };
        case "agent.start": {
          attempts += 1;
          const params = request.params as { name: string; kind: string };
          name = params.name;
          kind = params.kind;
          return (
            knobs.starts?.(attempts) ?? {
              result: { type: "agent_started", agent: { pane_id: pane.pane_id }, argv: [kind] },
            }
          );
        }
        case "pane.process_info":
          return {
            result: {
              type: "pane_process_info",
              process_info: {
                pane_id: pane.pane_id,
                shell_pid: 100,
                foreground_process_group_id: foreground,
                foreground_processes: [{ pid: foreground, name: "zsh" }],
              },
            },
          };
        case "agent.get": {
          const poll = polls[Math.min(polled, polls.length - 1)]!;
          polled += 1;
          return {
            result: {
              type: "agent_info",
              agent: { terminal_id: pane.terminal_id, name, agent: kind, ...poll },
            },
          };
        }
        case "agent.prompt":
          return knobs.prompt ?? { result: { type: "agent_prompted", agent: {} } };
        case "pane.close":
        case "workspace.close":
          return { result: { type: "ok" } };
        default:
          return undefined;
      }
    });
  }

  it("starts an agent in a new workspace of Peer's own, waits until it is ready, and prompts it", async () => {
    const herdr = await startingHerdr();
    const started = await startHerdrAgent(
      { cwd, harness: "claude", prompt: "Fix KRK-812", env: { ANTHROPIC_BASE_URL: "https://gw" } },
      { socketPath: herdr.socketPath, ...fast },
    );
    assert.deepStrictEqual(started, { paneId: "w2:p1", terminalId: "t-w2:p1" });

    const methods = herdr.requests.map((request) => request.method);
    assert.deepStrictEqual(methods, [
      "workspace.list",
      "workspace.create",
      "agent.start",
      "agent.get",
      "agent.get",
      "agent.prompt",
    ]);
    const create = herdr.requests.find((request) => request.method === "workspace.create")!;
    assert.deepStrictEqual(create.params, {
      cwd,
      label: "Peer agents",
      focus: false,
      env: { ANTHROPIC_BASE_URL: "https://gw" },
    });
    const start = herdr.requests.find((request) => request.method === "agent.start")!;
    const params = start.params as {
      name: string;
      kind: string;
      pane_id: string;
      timeout_ms: number;
    };
    assert.match(params.name, /^peer-[0-9a-f]{8}$/);
    assert.strictEqual(params.kind, "claude");
    assert.strictEqual(params.pane_id, "w2:p1");
    assert.strictEqual(params.timeout_ms, 30_000);
    assert.deepStrictEqual(herdr.requests.at(-1)?.params, {
      target: "w2:p1",
      text: "Fix KRK-812",
    });
    await herdr.stop();
  });

  it("splits Peer's own workspace when it already has one", async () => {
    const herdr = await startingHerdr({
      workspaces: [
        { workspace_id: "w1", label: "Peer agents" },
        { workspace_id: "w3", label: "work" },
      ],
    });
    const started = await startHerdrAgent(
      { cwd, harness: "codex", env: { OPENAI_BASE_URL: "https://gw" } },
      { socketPath: herdr.socketPath, ...fast },
    );
    assert.deepStrictEqual(started, { paneId: "w1:p5", terminalId: "t-w1:p5" });
    assert.strictEqual(herdr.count("workspace.create"), 0);
    const split = herdr.requests.find((request) => request.method === "pane.split")!;
    assert.deepStrictEqual(split.params, {
      workspace_id: "w1",
      direction: "right",
      cwd,
      focus: false,
      env: { OPENAI_BASE_URL: "https://gw" },
    });
    assert.strictEqual(
      (
        herdr.requests.find((request) => request.method === "agent.start")!.params as {
          kind: string;
        }
      ).kind,
      "codex",
    );
    assert.strictEqual(herdr.count("agent.prompt"), 0, "there was nothing to ask it");
    await herdr.stop();
  });

  it("splits the newest of Peer's workspaces, and makes a new one when it cannot split it", async () => {
    const herdr = await startingHerdr({
      workspaces: [
        { workspace_id: "w1", label: "Peer agents" },
        { workspace_id: "w3", label: "Peer agents" },
      ],
      split: { error: { code: "pane_split_failed", message: "pane is too small to split" } },
    });
    const started = await startHerdrAgent(
      { cwd, harness: "claude" },
      { socketPath: herdr.socketPath, ...fast },
    );
    const split = herdr.requests.find((request) => request.method === "pane.split")!;
    assert.strictEqual((split.params as { workspace_id: string }).workspace_id, "w3");
    assert.strictEqual(herdr.count("workspace.create"), 1);
    assert.strictEqual(started.paneId, "w2:p1");
    await herdr.stop();
  });

  it("waits out a shell that is still loading its startup files", async () => {
    const herdr = await startingHerdr({
      starts: (attempt) =>
        attempt < 3
          ? { error: { code: "agent_pane_busy", message: "w2:p1 is not an available shell" } }
          : undefined,
    });
    const started = await startHerdrAgent(
      { cwd, harness: "claude" },
      { socketPath: herdr.socketPath, ...fast },
    );
    assert.strictEqual(started.paneId, "w2:p1");
    assert.strictEqual(herdr.count("agent.start"), 3);
    assert.strictEqual(herdr.count("pane.process_info"), 2);
    await herdr.stop();
  });

  it("does not wait on a pane that something else holds, and removes the pane it made", async () => {
    const herdr = await startingHerdr({
      initializing: false,
      starts: () => ({
        error: { code: "agent_pane_busy", message: "w2:p1 is not an available shell" },
      }),
    });
    const refused = await startHerdrAgent(
      { cwd, harness: "claude" },
      { socketPath: herdr.socketPath, ...fast },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.strictEqual((refused as { code?: string }).code, "agent_pane_busy");
    assert.strictEqual(herdr.count("agent.start"), 1);
    assert.strictEqual(herdr.count("workspace.close"), 1, "its new workspace is closed again");
    await herdr.stop();
  });

  it("leaves nothing behind when herdr refuses the start", async () => {
    const herdr = await startingHerdr({
      workspaces: [{ workspace_id: "w1", label: "Peer agents" }],
      starts: () => ({
        error: { code: "agent_name_taken", message: "agent name is already used" },
      }),
    });
    const refused = await startHerdrAgent(
      { cwd, harness: "claude", prompt: "Go" },
      { socketPath: herdr.socketPath, ...fast },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.strictEqual((refused as Error).message, "agent name is already used");
    assert.strictEqual(herdr.count("pane.close"), 1, "the pane it split is closed again");
    assert.strictEqual(herdr.count("workspace.close"), 0, "the workspace is not Peer's to close");
    assert.strictEqual(herdr.count("agent.prompt"), 0);
    await herdr.stop();
  });

  it("keeps an agent that waits on an answer, and says its prompt waits", async () => {
    const herdr = await startingHerdr({
      polls: [{ agent_status: "blocked", launch_pending: true, interactive_ready: false }],
    });
    const started = await startHerdrAgent(
      { cwd, harness: "claude", prompt: "Go" },
      { socketPath: herdr.socketPath, ...fast },
    );
    assert.strictEqual(started.paneId, "w2:p1");
    assert.match(started.promptError ?? "", /waits for an answer/);
    assert.strictEqual(herdr.count("agent.prompt"), 0);
    assert.strictEqual(herdr.count("workspace.close"), 0);
    await herdr.stop();
  });

  it("keeps the pane of an agent that never became interactive, and names it", async () => {
    const herdr = await startingHerdr({
      polls: [{ agent_status: "idle", launch_pending: false, interactive_ready: false }],
    });
    const failed = await startHerdrAgent(
      { cwd, harness: "claude" },
      { socketPath: herdr.socketPath, ...fast },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.strictEqual((failed as { code?: string }).code, "agent_start_failed");
    assert.match((failed as Error).message, /pane w2:p1/);
    assert.strictEqual(herdr.count("workspace.close"), 0, "the person can see what happened");
    await herdr.stop();
  });

  it("gives up when the agent is not ready in time", async () => {
    const herdr = await startingHerdr();
    const failed = await startHerdrAgent(
      { cwd, harness: "claude" },
      { socketPath: herdr.socketPath, ...fast, readyMs: 0 },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.strictEqual((failed as { code?: string }).code, "timeout");
    await herdr.stop();
  });

  it("tells when herdr took the agent but not its prompt", async () => {
    const herdr = await startingHerdr({
      prompt: { error: { code: "agent_blocked", message: "agent w2:p1 is blocked" } },
    });
    const started = await startHerdrAgent(
      { cwd, harness: "claude", prompt: "Go" },
      { socketPath: herdr.socketPath, ...fast },
    );
    assert.deepStrictEqual(started, {
      paneId: "w2:p1",
      terminalId: "t-w2:p1",
      promptError: "agent w2:p1 is blocked",
    });
    await herdr.stop();
  });

  it("refuses what it cannot start before it touches herdr", async () => {
    const herdr = await startingHerdr();
    const options = { socketPath: herdr.socketPath, ...fast };
    const refusal = (input: Parameters<typeof startHerdrAgent>[0]) =>
      startHerdrAgent(input, options).then(
        () => "started",
        (error: Error) => error.message,
      );
    assert.match(await refusal({ cwd: "relative/dir", harness: "claude" }), /full path/);
    assert.match(
      await refusal({ cwd: NodePath.join(cwd, "no-such-dir"), harness: "claude" }),
      /not a directory/,
    );
    assert.match(await refusal({ cwd, harness: "gemini" as "claude" }), /cannot start a gemini/);
    assert.strictEqual(herdr.requests.length, 0);
    await herdr.stop();
  });
});
