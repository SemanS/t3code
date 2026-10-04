// @effect-diagnostics nodeBuiltinImport:off - a stand-in hub on a local HTTP port.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";

import * as HubApi from "./hubApi.ts";

/** A hub that answers `path` (by default the acme workspace's events) with `respond`. */
const standInHub = (
  respond: (response: NodeHttp.ServerResponse) => void,
  path = "/v1/workspaces/acme/events",
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ readonly url: string; readonly server: NodeHttp.Server }>((resolve) => {
          const server = NodeHttp.createServer((request, response) => {
            if (request.url === path) respond(response);
            else response.writeHead(404).end();
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({
              url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
              server,
            }),
          );
        }),
    ),
    ({ server }) => Effect.promise(() => new Promise<void>((done) => server.close(() => done()))),
  );

describe("hub events", () => {
  it.effect("passes on the pings Peer understands, with the environment that caused them", () =>
    Effect.gen(function* () {
      const hub = yield* standInHub((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            'event: work\ndata: {"origin":"bob-laptop"}\n\n',
            ":\n\n",
            "event: gossip\ndata: {}\n\n",
            'event: coord\ndata: {"origin":null}\n\n',
            "event: resync\ndata: {}\n\n",
            'event: observe\ndata: {"origin":null,"environment":"ana-laptop","thread":"peer:1"}\n\n',
          ].join(""),
        );
      });
      const api = yield* HubApi.make;
      const pings = yield* Stream.runCollect(api.events(hub.url, "phs_test", "acme"));
      assert.deepStrictEqual(Array.from(pings), [
        { change: "work", origin: "bob-laptop" },
        { change: "coord", origin: null },
        { change: "resync", origin: null },
        { change: "observe", origin: null, environment: "ana-laptop", thread: "peer:1" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("tells a hub without pings from one that refused the session", () =>
    Effect.gen(function* () {
      const without = yield* standInHub((response) => response.writeHead(404).end());
      const api = yield* HubApi.make;
      const missing = yield* Stream.runDrain(api.events(without.url, "phs_test", "acme")).pipe(
        Effect.result,
      );
      assert.isTrue(Result.isFailure(missing) && HubApi.isWithoutEvents(missing.failure));

      const ended = yield* standInHub((response) => response.writeHead(401).end());
      const refused = yield* Stream.runDrain(api.events(ended.url, "phs_test", "acme")).pipe(
        Effect.result,
      );
      assert.isTrue(Result.isFailure(refused) && HubApi.isSessionEnded(refused.failure));
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );
});

describe("observing", () => {
  it.effect("relays a shared thread's views and drops what is not one", () =>
    Effect.gen(function* () {
      const view = { agentId: "peer:1", title: "Split payments", status: "working", gone: false };
      const hub = yield* standInHub((response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            `event: view\ndata: ${JSON.stringify(view)}\n\n`,
            'event: view\ndata: {"title":1}\n\n',
            ":\n\n",
          ].join(""),
        );
      }, "/v1/workspaces/acme/observe/ana-laptop/peer%3A1");
      const api = yield* HubApi.make;
      const views = yield* Stream.runCollect(
        api.observe(hub.url, "phs_test", "acme", "ana-laptop", "peer:1"),
      );
      assert.deepStrictEqual(Array.from(views), [view]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );
});
