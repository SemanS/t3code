// @effect-diagnostics nodeBuiltinImport:off
// End-to-end check of the Hotovo Hub integration against a built server:
// starts `apps/server/dist/bin.mjs` in a throwaway home, connects the same
// WebSocket RPC client the app uses, and walks sign-in → manifest → company
// capacity → open project → sign-out against a running hub service.
//
//   HUB_URL=http://127.0.0.1:4747 node scripts/hotovo-hub-smoke.ts <project-id>
//
// Sign-in uses this machine's `gh auth token`, so the GitHub account must be
// a member of the hub with access to <project-id>.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import {
  CommandId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type HotovoHubStatus,
} from "../packages/contracts/src/index.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const hubUrl = process.env.HUB_URL ?? "http://127.0.0.1:4747";
const projectId = process.argv[2] ?? "smoke";
const port = Number(process.env.PEER_PORT ?? 39000 + Math.floor(Math.random() * 1000));
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hotovo-peer-smoke-"));
const workspace = NodePath.join(home, "workspace");
const bin = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");

function log(step: string, detail = "") {
  console.log(`[smoke] ${step}${detail === "" ? "" : `: ${detail}`}`);
}

const env = { ...process.env, HOTOVO_WORKSPACE: workspace, T3CODE_TELEMETRY_ENABLED: "false" };
const server = NodeChildProcess.spawn(
  process.execPath,
  [bin, "serve", "--base-dir", home, "--port", String(port), "--host", "127.0.0.1", "--no-browser"],
  { env, stdio: ["ignore", "pipe", "pipe"] },
);
const serverLog: string[] = [];
server.stdout.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));
server.stderr.on("data", (chunk: Buffer) => serverLog.push(chunk.toString()));

// Ready means listening with its secrets written, so a CLI-issued session verifies.
async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverLog.join("").includes("Listening on")) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`the server did not start:\n${serverLog.join("").slice(-2000)}`);
}

function issueToken(): string {
  return NodeChildProcess.execFileSync(
    process.execPath,
    [
      bin,
      "auth",
      "session",
      "issue",
      "--base-dir",
      home,
      "--token-only",
      "--label",
      "hotovo-smoke",
    ],
    { env, encoding: "utf8" },
  ).trim();
}

const program = Effect.gen(function* () {
  yield* Effect.promise(waitForServer);
  log("server up", `http://127.0.0.1:${port}, home ${home}`);
  const token = issueToken();
  log("session issued", `${token.length} chars`);
  const ticket = yield* Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(
        `websocket ticket: HTTP ${response.status} ${await response.text()} (token ${token.slice(0, 16)}…, ${token.length} chars)`,
      );
    }
    return ((await response.json()) as { ticket: string }).ticket;
  });
  log("websocket ticket issued");
  const url = `ws://127.0.0.1:${port}/ws?wsTicket=${encodeURIComponent(ticket)}&orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`;
  const protocol = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(url).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        RpcSerialization.layerJson,
      ),
    ),
  );
  // Build the socket in this program's scope; providing the layer to make() alone would close it at once.
  const protocolContext = yield* Layer.build(protocol);
  const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocolContext));
  log("rpc client ready");

  const status = () =>
    client[WS_METHODS.hotovoHubSubscribe]({}).pipe(
      Stream.take(1),
      Stream.runHead,
      Effect.map((s) => (s._tag === "Some" ? s.value : null)),
    );
  const summary = (s: HotovoHubStatus | null) =>
    s === null
      ? "no status"
      : `signedIn=${s.signedIn} member=${s.member?.id ?? "-"} projects=${s.projects.map((p) => p.project.id).join(",")} error=${s.error ?? "-"}`;

  log("before sign-in", summary(yield* status().pipe(Effect.timeout("30 seconds"))));

  const signedIn = yield* client[WS_METHODS.hotovoHubSignIn]({ hubUrl, method: "github-cli" });
  log("signed in", summary(signedIn));
  if (!signedIn.signedIn) throw new Error("sign-in did not stick");
  const project = signedIn.projects.find((p) => p.project.id === projectId);
  if (project === undefined) throw new Error(`the hub gives this member no project "${projectId}"`);
  log(
    "project",
    `${project.project.name}: personal=${project.project.capacity.personal} tools=${project.project.tools.map((t) => t.id).join(",")}`,
  );

  if (project.project.capacity.shared !== undefined) {
    const shared = yield* client[WS_METHODS.hotovoHubSetSharedCapacity]({
      projectId,
      enabled: true,
    });
    const state = shared.projects.find((p) => p.project.id === projectId)!.sharedCapacity;
    log("company capacity on", JSON.stringify(state));
    const settings = yield* client[WS_METHODS.serverGetSettings]({});
    const instance =
      settings.providerInstances[state.instanceIds[0] as keyof typeof settings.providerInstances];
    log(
      "provider instance",
      instance === undefined
        ? "MISSING"
        : `${instance.displayName} driver=${instance.driver} env=${(instance.environment ?? []).map((v) => `${v.name}${v.sensitive ? "(secret)" : ""}`).join(",")}`,
    );
    if (instance === undefined) throw new Error("the company capacity provider was not created");
  }

  yield* client[WS_METHODS.hotovoHubOpenProject]({ projectId });
  log("opening project", "cloning in the background");
  const opened = yield* client[WS_METHODS.hotovoHubSubscribe]({}).pipe(
    Stream.filter((s) => {
      const repos = s.projects.find((p) => p.project.id === projectId)?.repositories ?? [];
      return (
        repos.length > 0 &&
        repos.every(
          (r) => r.state === "error" || (r.state === "ready" && r.projectId !== undefined),
        )
      );
    }),
    Stream.take(1),
    Stream.runHead,
    Effect.timeout("5 minutes"),
  );
  const repos =
    opened._tag === "Some"
      ? opened.value.projects.find((p) => p.project.id === projectId)!.repositories
      : [];
  for (const repo of repos)
    log(
      "repository",
      `${repo.id} ${repo.state} → ${repo.path} project=${repo.projectId ?? "-"} ${repo.error ?? ""}`,
    );
  if (repos.some((r) => r.state !== "ready")) throw new Error("a repository did not check out");
  const knowledge = opened._tag === "Some" ? opened.value.companyKnowledge : null;
  log("company knowledge", knowledge === null ? "none" : `${knowledge.state} at ${knowledge.path}`);
  const tools =
    opened._tag === "Some"
      ? opened.value.projects.find((p) => p.project.id === projectId)!.tools
      : [];
  log(
    "tools",
    tools
      .map((t) =>
        t.missing.length === 0
          ? t.name
          : `${t.name} (missing ${t.missing.map((m) => m.command).join(",")})`,
      )
      .join(", "),
  );

  // A project that accepts company capacity only must refuse this machine's own Claude login
  // before any agent starts.
  const lockedId = process.env.SMOKE_LOCKED_PROJECT;
  if (lockedId !== undefined) {
    yield* client[WS_METHODS.hotovoHubOpenProject]({ projectId: lockedId });
    const locked = yield* client[WS_METHODS.hotovoHubSubscribe]({}).pipe(
      Stream.map((s) => s.projects.find((p) => p.project.id === lockedId)?.repositories[0]),
      Stream.filter((repo) => repo?.projectId !== undefined),
      Stream.take(1),
      Stream.runHead,
      Effect.timeout("5 minutes"),
    );
    const t3ProjectId = locked._tag === "Some" ? locked.value!.projectId! : undefined;
    if (t3ProjectId === undefined) throw new Error("the locked project did not open");
    const launch = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
      commandId: CommandId.make(`smoke-${Date.now()}`),
      projectId: t3ProjectId,
      title: "Policy check",
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-haiku-4-5",
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: "Reply with OK.", attachments: [] },
    }).pipe(Effect.result);
    const message =
      launch._tag === "Failure"
        ? String((launch.failure as { message?: string }).message ?? launch.failure)
        : "launched";
    log("personal login in a company-capacity-only project", message);
    if (launch._tag === "Success") {
      // The launch records the thread and fails its run before the provider starts; read why.
      const readProjection = client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({
        threadId: launch.success.threadId,
      });
      let projection = yield* readProjection;
      for (
        let attempt = 0;
        attempt < 60 &&
        projection.runs.some((r) => r.status === "preparing" || r.status === "starting");
        attempt += 1
      ) {
        yield* Effect.sleep("500 millis");
        projection = yield* readProjection;
      }
      const reason =
        JSON.stringify(projection.turnItems).match(
          /Workspace preparation failed during[^"]*/,
        )?.[0] ?? "";
      log(
        "run",
        `${projection.runs.map((r) => r.status).join(",")}; provider turns: ${projection.providerTurns.length}`,
      );
      log("reason shown", reason);
      if (projection.providerTurns.length > 0)
        throw new Error("an agent turn started despite the policy");
      if (!/company capacity only/.test(reason)) throw new Error("the refusal does not say why");
    } else if (!/company capacity only/.test(message)) {
      throw new Error(`unexpected launch failure: ${message}`);
    }
  }

  const usage = yield* client[WS_METHODS.hotovoHubProjectUsage]({ projectId }).pipe(Effect.result);
  log(
    "usage",
    usage._tag === "Success" ? JSON.stringify(usage.success.shared) : usage.failure.message,
  );

  if (project.project.capacity.shared !== undefined) {
    const off = yield* client[WS_METHODS.hotovoHubSetSharedCapacity]({ projectId, enabled: false });
    log(
      "company capacity off",
      JSON.stringify(off.projects.find((p) => p.project.id === projectId)!.sharedCapacity),
    );
  }
  const signedOut = yield* client[WS_METHODS.hotovoHubSignOut]({});
  log("signed out", summary(signedOut));
  if (signedOut.signedIn) throw new Error("sign-out did not stick");
}).pipe(Effect.scoped);

try {
  await Effect.runPromise(program);
  log("PASS");
  process.exitCode = 0;
} catch (error) {
  log("FAIL", error instanceof Error ? error.message : String(error));
  NodeFS.writeFileSync(
    NodePath.join(NodeOS.tmpdir(), "hotovo-peer-smoke-server.log"),
    serverLog.join(""),
  );
  log("server log", NodePath.join(NodeOS.tmpdir(), "hotovo-peer-smoke-server.log"));
  process.exitCode = 1;
} finally {
  // Stop the server this run spawned, and wait for it so its port is free again.
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
  if (process.env.KEEP_SMOKE_HOME !== "1") NodeFS.rmSync(home, { recursive: true, force: true });
}
