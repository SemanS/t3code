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

/** A hub that answers every request with `respond`, and keeps what it was asked. */
const recordingHub = (
  respond: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{
          readonly url: string;
          readonly server: NodeHttp.Server;
          readonly requests: Array<{
            readonly method: string | undefined;
            readonly url: string | undefined;
            readonly authorization: string | undefined;
            readonly body: unknown;
          }>;
        }>((resolve) => {
          const requests: Array<{
            method: string | undefined;
            url: string | undefined;
            authorization: string | undefined;
            body: unknown;
          }> = [];
          const server = NodeHttp.createServer((request, response) => {
            let raw = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => (raw += chunk));
            request.on("end", () => {
              requests.push({
                method: request.method,
                url: request.url,
                authorization: request.headers.authorization,
                body: raw === "" ? undefined : JSON.parse(raw),
              });
              respond(request, response);
            });
          });
          server.listen(0, "127.0.0.1", () =>
            resolve({
              url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
              server,
              requests,
            }),
          );
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      ),
  );

const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

const record = {
  id: "abc123def456",
  project: "app",
  sessions: ["claude:ana", "claude:bob"],
  files: ["src/pay.ts"],
  state: "open",
  notes: [],
  filesAt: "2026-10-06T10:00:00Z",
  acks: { "claude:ana": "2026-10-06T10:00:01Z" },
  openedAt: "2026-10-06T10:00:00Z",
  updatedAt: "2026-10-06T10:00:01Z",
} satisfies HubApi.HubOverlap;

describe("deciding an edit at the hub", () => {
  const request = {
    environment: "ana-laptop",
    session: "claude:bob",
    paths: ["src/pay.ts"],
    policy: "coordinate",
    op: "op-1",
  } as const;

  it.effect("asks for a verdict on each path, and reads the overlaps it carries", () =>
    Effect.gen(function* () {
      const answer = {
        policy: "coordinate",
        policySource: "client",
        verdicts: [
          {
            path: "src/pay.ts",
            verdict: "deny",
            with: ["claude:ana"],
            overlaps: ["abc123def456"],
          },
        ],
        overlaps: [record],
        at: "2026-10-06T10:00:02Z",
      } satisfies HubApi.HubIntentAnswer;
      const hub = yield* recordingHub((_request, response) => json(response, 200, answer));
      const api = yield* HubApi.make;
      const decided = yield* api.intent(hub.url, "phs_test", "acme", "app", request);
      assert.deepStrictEqual(decided, answer);
      assert.deepStrictEqual(hub.requests, [
        {
          method: "POST",
          url: "/v1/workspaces/acme/coord/app/intent",
          authorization: "Bearer phs_test",
          body: request,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("takes a 404 or 405, with or without JSON, for a hub that has no such thing", () =>
    Effect.gen(function* () {
      const api = yield* HubApi.make;
      for (const answer of [
        (response: NodeHttp.ServerResponse) =>
          json(response, 404, { error: { code: "not_found", message: "no such route" } }),
        (response: NodeHttp.ServerResponse) => response.writeHead(404).end(),
        (response: NodeHttp.ServerResponse) => response.writeHead(405).end(),
      ]) {
        const hub = yield* recordingHub((_request, response) => answer(response));
        const decided = yield* api.intent(hub.url, "phs_test", "acme", "app", request);
        assert.isTrue(HubApi.isUnsupported(decided));
        const acknowledged = yield* api.ack(hub.url, "phs_test", "acme", "app", "abc123def456", {
          session: "claude:bob",
        });
        assert.isTrue(HubApi.isUnsupported(acknowledged));
      }
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("fails, rather than guess, when the hub refuses or answers something else", () =>
    Effect.gen(function* () {
      const api = yield* HubApi.make;
      const refusing = yield* recordingHub((_request, response) =>
        json(response, 403, {
          error: { code: "not_your_session", message: "that session is not yours" },
        }),
      );
      const refused = yield* api
        .intent(refusing.url, "phs_test", "acme", "app", request)
        .pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(refused) && refused.failure.detail === "that session is not yours",
      );

      const broken = yield* recordingHub((_request, response) =>
        json(response, 200, { verdicts: "yes" }),
      );
      const unexpected = yield* api
        .intent(broken.url, "phs_test", "acme", "app", request)
        .pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(unexpected) && unexpected.failure.detail.includes("unexpected shape"),
      );

      // A verdict this Peer does not know is no verdict: the caller falls back, it does not guess.
      const newer = yield* recordingHub((_request, response) =>
        json(response, 200, {
          policy: "coordinate",
          policySource: "project",
          verdicts: [{ path: "src/pay.ts", verdict: "defer", with: [], overlaps: [] }],
          overlaps: [],
          at: "2026-10-06T10:00:02Z",
        }),
      );
      const unknown = yield* api
        .intent(newer.url, "phs_test", "acme", "app", request)
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(unknown));
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.live("gives up on a hub that does not answer within the time it was given", () =>
    Effect.gen(function* () {
      const silent = yield* recordingHub(() => undefined);
      const api = yield* HubApi.make;
      const gone = yield* api
        .intent(silent.url, "phs_test", "acme", "app", request, { timeoutMs: 100 })
        .pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(gone) && gone.failure.detail.includes("Could not reach the hub"),
      );
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect(
    "acknowledges an overlap for a session, and sends an op with a note or a resolution",
    () =>
      Effect.gen(function* () {
        const hub = yield* recordingHub((_request, response) => json(response, 200, record));
        const api = yield* HubApi.make;
        const acknowledged = yield* api.ack(hub.url, "phs_test", "acme", "app", "abc123def456", {
          session: "claude:bob",
          op: "op-2",
        });
        assert.isFalse(HubApi.isUnsupported(acknowledged));
        yield* api.noteOverlap(hub.url, "phs_test", "acme", "app", "abc123def456", {
          session: "claude:bob",
          text: "I only change pay()",
          op: "op-3",
        });
        yield* api.resolveOverlap(hub.url, "phs_test", "acme", "app", "abc123def456", {
          session: "claude:bob",
          resolution: "Ana first",
        });
        assert.deepStrictEqual(
          hub.requests.map(({ url, body }) => [url, body]),
          [
            [
              "/v1/workspaces/acme/coord/app/abc123def456/ack",
              { session: "claude:bob", op: "op-2" },
            ],
            [
              "/v1/workspaces/acme/coord/app/abc123def456/notes",
              { session: "claude:bob", text: "I only change pay()", op: "op-3" },
            ],
            [
              "/v1/workspaces/acme/coord/app/abc123def456/resolve",
              { session: "claude:bob", resolution: "Ana first" },
            ],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("reads a view with project policies and acknowledgements, and one without", () =>
    Effect.gen(function* () {
      const api = yield* HubApi.make;
      const newer = yield* recordingHub((_request, response) =>
        json(response, 200, {
          sessions: [],
          overlaps: [record],
          // A policy from a hub newer than this Peer must not cost it the view.
          policies: { app: "exclusive", site: "lockstep" },
          at: "2026-10-06T10:00:02Z",
        }),
      );
      const view = yield* api.coordination(newer.url, "phs_test", "acme");
      assert.deepStrictEqual(view.policies, { app: "exclusive", site: "lockstep" });
      assert.deepStrictEqual(view.overlaps[0]?.acks, { "claude:ana": "2026-10-06T10:00:01Z" });
      assert.strictEqual(view.overlaps[0]?.filesAt, "2026-10-06T10:00:00Z");

      const { filesAt: _at, acks: _acks, ...older } = record;
      const before = yield* recordingHub((_request, response) =>
        json(response, 200, { sessions: [], overlaps: [older], at: "2026-10-06T10:00:02Z" }),
      );
      const plain = yield* api.coordination(before.url, "phs_test", "acme");
      assert.isUndefined(plain.policies);
      assert.isUndefined(plain.overlaps[0]?.acks);
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );
});

describe("hub events", () => {
  it.effect("reads version receipts and the filtered committed coordination history", () =>
    Effect.gen(function* () {
      const receipt = {
        project: "app",
        scope: "task:build",
        session: "claude:ana",
        environment: "laptop",
        version: 3,
        at: "2026-10-06T10:00:00Z",
      };
      const event = {
        id: "one",
        kind: "context-read",
        project: "app",
        at: receipt.at,
        paths: [],
        participants: [receipt.session],
        version: 3,
      };
      const hub = yield* recordingHub((request, response) => {
        if (request.url?.includes("/read")) json(response, 200, receipt);
        else if (request.url?.includes("/stale"))
          json(response, 200, {
            fresh: false,
            stale: [
              {
                project: "app",
                scope: "task:build",
                readVersion: 3,
                currentVersion: 4,
                at: receipt.at,
                updatedAt: receipt.at,
              },
            ],
          });
        else json(response, 200, [event]);
      });
      const api = yield* HubApi.make;
      assert.deepStrictEqual(
        yield* api.contextRead(hub.url, "phs_test", "acme", "app", receipt.scope, {
          session: receipt.session,
          environment: receipt.environment,
          version: 3,
          op: "read-one",
        }),
        receipt,
      );
      assert.isFalse((yield* api.staleReads(hub.url, "phs_test", "acme", "app", receipt)).fresh);
      assert.deepStrictEqual(
        yield* api.coordEvents(hub.url, "phs_test", "acme", "app", {
          task: "build",
          path: "src/a b.ts",
          limit: 20,
        }),
        [event],
      );
      assert.strictEqual(
        hub.requests[0]?.url,
        "/v1/workspaces/acme/contexts/app/task%3Abuild/read",
      );
      assert.deepStrictEqual(hub.requests[0]?.body, {
        session: receipt.session,
        environment: receipt.environment,
        version: 3,
        op: "read-one",
      });
      assert.strictEqual(
        hub.requests[1]?.url,
        "/v1/workspaces/acme/coord/app/stale?session=claude%3Aana&environment=laptop",
      );
      assert.strictEqual(
        hub.requests[2]?.url,
        "/v1/workspaces/acme/coord/app/events?task=build&path=src%2Fa%20b.ts&limit=20",
      );
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
  );

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
