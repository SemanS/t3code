// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - a fake herdr server on a Unix socket, speaking its newline-delimited JSON.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import { watchHerdrAgents } from "./herdr.ts";

interface SubscribeRequest {
  readonly id: string;
  readonly method: string;
  readonly params: { readonly subscriptions: ReadonlyArray<Record<string, string>> };
}

/** A herdr server that answers one subscription the way herdr 0.9.3 does. */
async function fakeHerdr(answer: (request: SubscribeRequest, socket: NodeNet.Socket) => void) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "herdr-"));
  const socketPath = NodePath.join(dir, "h.sock");
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) answer(JSON.parse(buffer.slice(0, newline)), socket);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    /** herdr's server going away. */
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          NodeFS.rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

const line = (message: object) => `${JSON.stringify(message)}\n`;

describe("watchHerdrAgents", () => {
  it("follows the agents' panes, passes their events on, and says when herdr goes away", async () => {
    let request: SubscribeRequest | undefined;
    const herdr = await fakeHerdr((received, socket) => {
      request = received;
      socket.write(line({ id: received.id, result: { type: "subscription_started" } }));
      socket.write(
        line({
          event: "pane.agent_status_changed",
          data: { pane_id: "w1:p2", agent: "claude", agent_status: "blocked" },
        }),
      );
    });
    const changed = Promise.withResolvers<void>();
    const ended = Promise.withResolvers<boolean>();
    watchHerdrAgents({
      socketPath: herdr.socketPath,
      paneIds: ["w1:p2"],
      onChange: () => changed.resolve(),
      onEnd: (subscribed) => ended.resolve(subscribed),
    });
    await changed.promise;
    assert.strictEqual(request?.method, "events.subscribe");
    assert.deepStrictEqual(request?.params.subscriptions, [
      { type: "pane.agent_detected" },
      { type: "pane.exited" },
      { type: "pane.closed" },
      { type: "pane.agent_status_changed", pane_id: "w1:p2" },
    ]);
    await herdr.stop();
    assert.isTrue(await ended.promise, "it had subscribed before herdr went away");
  });

  it("says when herdr refuses the subscription, as one from before events does", async () => {
    const herdr = await fakeHerdr((received, socket) =>
      socket.write(line({ id: received.id, error: { message: "unknown method" } })),
    );
    const ended = Promise.withResolvers<boolean>();
    watchHerdrAgents({
      socketPath: herdr.socketPath,
      paneIds: [],
      onChange: () => assert.fail("a refused subscription sends no events"),
      onEnd: (subscribed) => ended.resolve(subscribed),
    });
    assert.isFalse(await ended.promise);
    await herdr.stop();
  });
});
