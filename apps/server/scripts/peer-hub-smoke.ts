// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off globalConsole:off globalRandom:off preferSchemaOverJson:off anyUnknownInErrorContext:off - host-side smoke harness: drives real server processes and reads their raw output.
// End-to-end check of Peer workspaces against a built server and a real Peer
// Hub: starts `peerhub serve` (in-memory database, codes echoed, in-memory
// gateway) and `apps/server/dist/bin.mjs` in throwaway homes, sets up a
// workspace the way an admin would, then drives the app's own WebSocket RPC
// client through email sign-in → join by domain → shared capacity → clone →
// capacity policy → the work (tasks, colleagues' threads, a herdr agent placed
// on a task, sharing a project) → create → leave → sign-out.
//
//   PEERHUB_BIN=../server/target/debug/peerhub HERDR_BIN=herdr node apps/server/scripts/peer-hub-smoke.ts
//
// HERDR_BIN is optional: with it, a real herdr server runs in the throwaway home.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import {
  CommandId,
  ProjectId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  ProviderInstanceId,
  WS_METHODS,
  WsRpcGroup,
  type PeerHubStatus,
} from "@t3tools/contracts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const peerhubBin = process.env.PEERHUB_BIN ?? "peerhub";
const hubPort = 41000 + Math.floor(Math.random() * 1000);
const hubUrl = `http://127.0.0.1:${hubPort}`;
const port = Number(process.env.PEER_PORT ?? 39000 + Math.floor(Math.random() * 1000));
const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "peer-smoke-"));
const workspaceRoot = NodePath.join(home, "workspace");
const bin = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");

function log(step: string, detail = "") {
  console.log(`[smoke] ${step}${detail === "" ? "" : `: ${detail}`}`);
}

function spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = NodeChildProcess.spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return { child, output };
}

async function waitFor(what: string, ready: () => Promise<boolean>, output: string[]) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await ready().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${what} did not start:\n${output.join("").slice(-2000)}`);
}

// ---- the hub, and a workspace set up the way an admin would ----

const hub = spawnLogged(peerhubBin, ["serve"], {
  ...process.env,
  PEERHUB_DB: "mem://smoke",
  PEERHUB_BIND: `127.0.0.1:${hubPort}`,
  PEERHUB_PUBLIC_URL: hubUrl,
  PEERHUB_MAIL: "echo",
  PEERHUB_GATEWAY_MODE: "memory",
  PEERHUB_SECRET_KEY: NodeCrypto.randomBytes(32).toString("hex"),
});

async function hubCall(path: string, init: { method?: string; session?: string; body?: unknown }) {
  const response = await fetch(`${hubUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(init.session === undefined ? {} : { authorization: `Bearer ${init.session}` }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function hubSignIn(email: string): Promise<string> {
  const started = await hubCall("/v1/auth/email/start", { method: "POST", body: { email } });
  const finished = await hubCall("/v1/auth/email/verify", {
    method: "POST",
    body: { email, code: started.code },
  });
  return finished.session as string;
}

/** A repository to clone: a local git repo with one commit. */
function makeRepository(): string {
  const path = NodePath.join(home, "origin", "app");
  NodeFS.mkdirSync(path, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(path, "README.md"), "# demo\n");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "smoke",
        GIT_AUTHOR_EMAIL: "smoke@acme.test",
        GIT_COMMITTER_NAME: "smoke",
        GIT_COMMITTER_EMAIL: "smoke@acme.test",
      },
    });
  git("init", "--quiet", "--initial-branch", "main");
  git("add", ".");
  git("commit", "--quiet", "-m", "init");
  return path;
}

let anaSession = "";

async function setUpWorkspace() {
  const admin = await hubSignIn("ana@acme.test");
  anaSession = admin;
  await hubCall("/v1/workspaces", {
    method: "POST",
    session: admin,
    body: { slug: "acme", name: "Acme", allowedDomains: ["acme.test"] },
  });
  const repository = makeRepository();
  const project = (name: string, personal: string) => ({
    name,
    repositories: [{ id: "app", url: repository, branch: "main" }],
    tools: ["kontext"],
    capacity: {
      personal,
      shared: {
        pool: "company-api",
        budget: { amount: 300, period: "month" },
        allocations: { "bob@acme.test": 120 },
      },
    },
  });
  const applied = await hubCall("/v1/workspaces/acme/config", {
    method: "PUT",
    session: admin,
    body: {
      revision: "smoke",
      config: {
        currency: "EUR",
        gateway: { kind: "litellm", url: "https://ai.acme.test", usdPerUnit: 1.2 },
        people: { "bob@acme.test": { name: "Bob" } },
        projects: { demo: project("Demo", "any"), locked: project("Locked", "none") },
        tools: {
          kontext: {
            name: "kontext",
            mcp: { command: "kontext", args: ["mcp"] },
            requires: [{ command: "kontext", install: "see kontext docs" }],
          },
        },
        capacity: {
          "company-api": {
            name: "Company API",
            models: [
              { id: "claude-sonnet-5-5", provider: "anthropic", harness: ["claude"] },
              { id: "claude-haiku-4-5", provider: "anthropic", harness: ["claude"] },
            ],
          },
        },
      },
    },
  });
  log("workspace acme set up", `revision ${String(applied.revision)}`);
}

// ---- herdr, isolated in the throwaway home ----

const herdrBin = process.env.HERDR_BIN;
const herdrEnv = {
  ...process.env,
  XDG_CONFIG_HOME: NodePath.join(home, "herdr", "config"),
  XDG_STATE_HOME: NodePath.join(home, "herdr", "state"),
};
const herdrSocket = NodePath.join(home, "herdr", "config", "herdr", "herdr.sock");
const herdr = herdrBin === undefined ? null : spawnLogged(herdrBin, ["server"], herdrEnv);

function herdrCli(...args: string[]): Record<string, unknown> {
  const output = NodeChildProcess.execFileSync(herdrBin!, args, {
    env: herdrEnv,
    encoding: "utf8",
  });
  return JSON.parse(output.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
}

function herdrRequest(method: string, params: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(herdrSocket);
    socket.setEncoding("utf8");
    socket.on("connect", () =>
      socket.write(`${JSON.stringify({ id: "smoke", method, params })}\n`),
    );
    socket.on("data", (chunk: string) => {
      socket.destroy();
      resolve(JSON.parse(chunk.trim().split("\n")[0] ?? "{}"));
    });
    socket.on("error", reject);
  });
}

// ---- the app's server ----

const env = {
  ...process.env,
  PEER_HUB_URL: hubUrl,
  PEER_WORKSPACE: workspaceRoot,
  // Only the throwaway herdr, never one this machine runs.
  HERDR_SOCKET_PATH: herdrSocket,
  T3CODE_TELEMETRY_ENABLED: "false",
};
let server: ReturnType<typeof spawnLogged> | null = null;

function issueToken(): string {
  return NodeChildProcess.execFileSync(
    process.execPath,
    [bin, "auth", "session", "issue", "--base-dir", home, "--token-only", "--label", "peer-smoke"],
    { env, encoding: "utf8" },
  ).trim();
}

const summary = (s: PeerHubStatus) =>
  `signedIn=${s.signedIn} email=${s.email ?? "-"} pending=${s.pendingSignIn?.email ?? "-"} workspaces=${s.workspaces.map((w) => `${w.slug}(${w.role})`).join(",") || "-"} joinable=${s.joinable.map((j) => `${j.slug}:${j.reason}`).join(",") || "-"} error=${s.error ?? "-"}`;

const program = Effect.gen(function* () {
  yield* Effect.promise(() =>
    waitFor("the hub", async () => (await fetch(`${hubUrl}/health`)).ok, hub.output),
  );
  log("hub up", hubUrl);
  yield* Effect.promise(setUpWorkspace);

  server = spawnLogged(
    process.execPath,
    [
      bin,
      "serve",
      "--base-dir",
      home,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--no-browser",
    ],
    env,
  );
  const started = server;
  // Ready means listening with its secrets written, so a CLI-issued session verifies.
  yield* Effect.promise(() =>
    waitFor(
      "the server",
      async () => started.output.join("").includes("Listening on"),
      started.output,
    ),
  );
  yield* Effect.sleep("1500 millis");
  log("server up", `http://127.0.0.1:${port}, home ${home}`);
  const token = issueToken();
  const ticket = yield* Effect.promise(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`websocket ticket: HTTP ${response.status}`);
    return ((await response.json()) as { ticket: string }).ticket;
  });
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

  const status = client[WS_METHODS.peerHubSubscribe]({}).pipe(
    Stream.take(1),
    Stream.runHead,
    Effect.map((s) => {
      if (s._tag === "None") throw new Error("no status");
      return s.value;
    }),
  );
  const waitForStatus = (what: string, done: (s: PeerHubStatus) => boolean) =>
    client[WS_METHODS.peerHubSubscribe]({}).pipe(
      Stream.filter(done),
      Stream.take(1),
      Stream.runHead,
      Effect.timeout("5 minutes"),
      Effect.map((s) => {
        if (s._tag === "None") throw new Error(`never saw: ${what}`);
        return s.value;
      }),
    );

  const fresh = yield* status.pipe(Effect.timeout("30 seconds"));
  log("first run", summary(fresh));
  if (fresh.signedIn || fresh.hubUrl !== hubUrl)
    throw new Error("expected a signed-out app on the configured hub");

  // Sign in with an email code, as the welcome screen does.
  const firstCodeAt = Date.now();
  const pending = yield* client[WS_METHODS.peerHubStartSignIn]({ email: "Bob@Acme.test" });
  log("code requested", summary(pending));
  const code = pending.pendingSignIn?.echoedCode;
  if (code === undefined) throw new Error("the hub did not echo a code (is PEERHUB_MAIL=echo?)");
  const wrong = yield* client[WS_METHODS.peerHubFinishSignIn]({ code: "000000" }).pipe(
    Effect.result,
  );
  log("wrong code", wrong._tag === "Failure" ? wrong.failure.message : "ACCEPTED");
  if (wrong._tag === "Success" && code !== "000000") throw new Error("a wrong code signed in");
  const signedIn = yield* client[WS_METHODS.peerHubFinishSignIn]({ code });
  log("signed in", summary(signedIn));
  if (!signedIn.signedIn || signedIn.email !== "bob@acme.test")
    throw new Error("sign-in did not stick");
  // An @acme.test address joins Acme on its own when it signs in, as in Slack.
  const acme = signedIn.workspaces.find((w) => w.slug === "acme");
  if (acme === undefined) throw new Error("an @acme.test address did not join acme on sign-in");
  log(
    "acme",
    `revision=${acme.revision ?? "-"} member=${acme.memberName} projects=${acme.projects.map((p) => `${p.project.id}[personal=${p.project.capacity.personal}]`).join(",")}`,
  );
  const demo = acme.projects.find((p) => p.project.id === "demo");
  if (demo === undefined) throw new Error("the demo project is missing");
  log(
    "tools",
    demo.tools
      .map((t) =>
        t.missing.length === 0
          ? t.name
          : `${t.name} (missing ${t.missing.map((m) => m.command).join(",")})`,
      )
      .join(", "),
  );

  // Shared capacity: a gateway key for this environment, as a provider instance.
  const shared = yield* client[WS_METHODS.peerHubSetSharedCapacity]({
    workspace: "acme",
    projectId: "demo",
    enabled: true,
  });
  const sharedState = shared.workspaces
    .find((w) => w.slug === "acme")!
    .projects.find((p) => p.project.id === "demo")!.sharedCapacity;
  log("shared capacity on", JSON.stringify(sharedState));
  const settings = yield* client[WS_METHODS.serverGetSettings]({});
  const instanceId = sharedState.instanceIds[0];
  const instance =
    instanceId === undefined
      ? undefined
      : settings.providerInstances[instanceId as keyof typeof settings.providerInstances];
  if (instance === undefined) throw new Error("the shared capacity provider was not created");
  log(
    "provider instance",
    `${instance.displayName} driver=${instance.driver} env=${(instance.environment ?? []).map((v) => `${v.name}${v.sensitive ? "(secret)" : ""}`).join(",")}`,
  );

  // Clone and open both projects.
  for (const projectId of ["demo", "locked"]) {
    yield* client[WS_METHODS.peerHubOpenProject]({ workspace: "acme", projectId });
  }
  const opened = yield* waitForStatus("both projects checked out and registered", (s) => {
    const projects = s.workspaces.find((w) => w.slug === "acme")?.projects ?? [];
    return ["demo", "locked"].every((id) => {
      const repos = projects.find((p) => p.project.id === id)?.repositories ?? [];
      return (
        repos.length > 0 &&
        repos.every(
          (r) => r.state === "error" || (r.state === "ready" && r.projectId !== undefined),
        )
      );
    });
  });
  const projectsAfter = opened.workspaces.find((w) => w.slug === "acme")!.projects;
  for (const project of projectsAfter) {
    for (const repo of project.repositories) {
      log(
        "repository",
        `${project.project.id}/${repo.id} ${repo.state} → ${repo.path} project=${repo.projectId ?? "-"} ${repo.error ?? ""}`,
      );
    }
  }
  if (projectsAfter.some((p) => p.repositories.some((r) => r.state !== "ready"))) {
    throw new Error("a repository did not check out");
  }

  // A project on shared capacity only refuses this machine's own Claude login before any agent starts.
  const lockedProjectId = projectsAfter.find((p) => p.project.id === "locked")!.repositories[0]!
    .projectId!;
  const launch = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread]({
    commandId: CommandId.make(`smoke-${Date.now()}`),
    projectId: lockedProjectId,
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
      JSON.stringify(projection.turnItems).match(/Workspace preparation failed during[^"]*/)?.[0] ??
      "";
    log(
      "personal login in a shared-only project",
      `runs=${projection.runs.map((r) => r.status).join(",")} provider turns=${projection.providerTurns.length}`,
    );
    log("reason shown", reason);
    if (projection.providerTurns.length > 0)
      throw new Error("an agent turn started despite the policy");
    if (!/shared capacity only/.test(reason)) throw new Error("the refusal does not say why");
  } else {
    const message = String((launch.failure as { message?: string }).message ?? launch.failure);
    log("personal login in a shared-only project", message);
    if (!/shared capacity only/.test(message))
      throw new Error(`unexpected launch failure: ${message}`);
  }

  const usage = yield* client[WS_METHODS.peerHubProjectUsage]({
    workspace: "acme",
    projectId: "demo",
  });
  log("usage", JSON.stringify(usage.shared));

  // ---- The work: Project → Area → Task → Threads; people are metadata ----
  const demoOf = (s: PeerHubStatus) =>
    s.workspaces.find((w) => w.slug === "acme")?.projects.find((p) => p.project.id === "demo");
  const withTask = yield* client[WS_METHODS.peerHubCreateTask]({
    workspace: "acme",
    projectId: "demo",
    title: "Split Payments",
    key: "demo-1",
    area: "Core",
  });
  const task = demoOf(withTask)?.work.tasks.find((t) => t.key === "DEMO-1");
  log("task", JSON.stringify(task));
  if (task === undefined || task.area !== "Core") throw new Error("the task did not land");

  // Ana works on it from her computer; her branch names the task.
  yield* Effect.promise(() =>
    hubCall("/v1/workspaces/acme/threads", {
      method: "PUT",
      session: anaSession,
      body: {
        environment: "ana-laptop",
        threads: [
          {
            id: "peer:a1",
            project: "demo",
            title: "Backend implementation",
            status: "working",
            branch: "demo-1-backend",
            harness: "claude",
          },
        ],
      },
    }),
  );

  if (herdr !== null) {
    // An agent herdr runs in Bob's demo checkout shows up in Peer, and Bob puts it on the task.
    const demoPath = demoOf(withTask)?.repositories[0]?.path ?? "";
    const created = herdrCli("workspace", "create", "--cwd", demoPath, "--label", "demo") as {
      result?: { root_pane?: { pane_id?: string } };
    };
    const paneId = created.result?.root_pane?.pane_id ?? "";
    yield* Effect.promise(() =>
      herdrRequest("pane.report_agent", {
        pane_id: paneId,
        source: "custom:peer-smoke",
        agent: "codex",
        state: "blocked",
      }),
    );
    const seen = yield* waitForStatus("the herdr agent", (s) =>
      s.agents.list.some((a) => a.paneId === paneId && a.projectId === "demo"),
    );
    const agent = seen.agents.list.find((a) => a.paneId === paneId)!;
    log("herdr agent", JSON.stringify(agent));
    const placed = yield* client[WS_METHODS.peerHubAssignThread]({
      workspace: "acme",
      projectId: "demo",
      thread: agent.id,
      taskId: task.id,
    });
    const work = demoOf(placed)!.work;
    log("demo work", JSON.stringify({ assignments: work.assignments, threads: work.threads }));
    if (work.assignments[agent.id] !== task.id) throw new Error("the agent is not on the task");
    const anas = work.threads.find((t) => t.id === "peer:a1");
    if (anas?.task !== task.id) throw new Error("Ana's branch did not put her thread on the task");
    // Ana's Peer sees Bob's herdr agent under the task.
    const anaView = (yield* Effect.promise(() =>
      hubCall("/v1/workspaces/acme/work", { session: anaSession }),
    )) as { projects: Record<string, { threads: Array<Record<string, unknown>> }> };
    const bobs = anaView.projects.demo?.threads.find((t) => t.id === agent.id);
    log("as Ana sees it", JSON.stringify(bobs));
    if (bobs?.task !== task.id || bobs.source !== "herdr" || bobs.status !== "blocked") {
      throw new Error("Ana does not see Bob's herdr agent on the task");
    }
    const lockedThreads = anaView.projects.locked?.threads ?? [];
    if (!lockedThreads.some((t) => t.email === "bob@acme.test" && t.source === "peer")) {
      throw new Error("Bob's Peer thread is not reported");
    }
  } else {
    log("herdr", "skipped (set HERDR_BIN to run a real herdr server)");
  }

  const closed = yield* client[WS_METHODS.peerHubUpdateTask]({
    workspace: "acme",
    projectId: "demo",
    taskId: task.id,
    status: "done",
  });
  if (demoOf(closed)?.work.tasks.find((t) => t.id === task.id)?.status !== "done") {
    throw new Error("the task did not close");
  }

  // Any member shares a project from this computer; the whole workspace gets it.
  const shareRoot = NodePath.join(home, "side-app");
  const bare = NodePath.join(home, "origin", "side-app.git");
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--bare", bare]);
  NodeFS.mkdirSync(shareRoot, { recursive: true });
  NodeChildProcess.execFileSync("git", ["init", "--quiet", "--initial-branch", "main"], {
    cwd: shareRoot,
  });
  NodeChildProcess.execFileSync("git", ["remote", "add", "origin", bare], { cwd: shareRoot });
  const sideProjectId = ProjectId.make(`smoke-side-${Date.now()}`);
  yield* client[WS_METHODS.projectsMutate]({
    type: "project.create",
    commandId: CommandId.make(`smoke-create-${Date.now()}`),
    projectId: sideProjectId,
    title: "Side App",
    workspaceRoot: shareRoot,
  });
  const afterShare = yield* client[WS_METHODS.peerHubShareProject]({
    workspace: "acme",
    projectId: sideProjectId,
  });
  const side = afterShare.workspaces
    .find((w) => w.slug === "acme")
    ?.projects.find((p) => p.project.id === "side-app");
  log(
    "shared",
    JSON.stringify({ addedBy: side?.project.addedBy, repositories: side?.repositories }),
  );
  if (
    side?.project.addedBy !== "bob@acme.test" ||
    side.repositories[0]?.projectId !== sideProjectId
  ) {
    throw new Error("the shared project is not the workspace's, bound to this checkout");
  }
  const unshared = yield* client[WS_METHODS.peerHubUnshareProject]({
    workspace: "acme",
    projectId: "side-app",
  });
  if (unshared.workspaces.some((w) => w.projects.some((p) => p.project.id === "side-app"))) {
    throw new Error("the project stayed shared");
  }

  // Workspaces can be looked up by their short name.
  const found = yield* client[WS_METHODS.peerHubFindWorkspace]({ slug: "acme" });
  const missing = yield* client[WS_METHODS.peerHubFindWorkspace]({ slug: "no-such-space" });
  log("look up acme", JSON.stringify(found));
  if (found?.role !== "member" || missing !== null) throw new Error("the lookup is wrong");

  // Create a workspace of one's own; its creator owns it.
  const created = yield* client[WS_METHODS.peerHubCreateWorkspace]({
    slug: "bob-labs",
    name: "Bob Labs",
    allowedDomains: [],
  });
  log("created", summary(created));
  if (created.workspaces.find((w) => w.slug === "bob-labs")?.role !== "owner") {
    throw new Error("the creator does not own the new workspace");
  }
  const lastOwner = yield* client[WS_METHODS.peerHubLeaveWorkspace]({ workspace: "bob-labs" }).pipe(
    Effect.result,
  );
  log("last owner leaves", lastOwner._tag === "Failure" ? lastOwner.failure.message : "LEFT");
  if (lastOwner._tag === "Success") throw new Error("the last owner left their workspace");

  // Leaving drops the workspace and its shared capacity here.
  const left = yield* client[WS_METHODS.peerHubLeaveWorkspace]({ workspace: "acme" });
  log("left acme", summary(left));
  const afterLeave = yield* client[WS_METHODS.serverGetSettings]({});
  if (left.workspaces.some((w) => w.slug === "acme")) throw new Error("acme is still listed");
  if (
    instanceId !== undefined &&
    afterLeave.providerInstances[instanceId as keyof typeof afterLeave.providerInstances] !==
      undefined
  ) {
    throw new Error("the shared capacity provider outlived leaving");
  }
  if (!left.joinable.some((j) => j.slug === "acme")) throw new Error("acme is not offered again");

  const signedOut = yield* client[WS_METHODS.peerHubSignOut]({});
  log("signed out", summary(signedOut));
  if (signedOut.signedIn || signedOut.workspaces.length > 0)
    throw new Error("sign-out did not stick");

  // Signing in again does not rejoin a workspace Bob left here; it is offered instead.
  yield* Effect.sleep(`${Math.max(0, 31_000 - (Date.now() - firstCodeAt))} millis`);
  const again = yield* client[WS_METHODS.peerHubStartSignIn]({ email: "bob@acme.test" });
  const back = yield* client[WS_METHODS.peerHubFinishSignIn]({
    code: again.pendingSignIn?.echoedCode ?? "",
  });
  log("signed in again", summary(back));
  if (
    back.workspaces.some((w) => w.slug === "acme") ||
    !back.joinable.some((j) => j.slug === "acme")
  ) {
    throw new Error("a workspace Bob left came back on sign-in");
  }
  yield* client[WS_METHODS.peerHubSignOut]({});
}).pipe(Effect.scoped);

async function stop(child: NodeChildProcess.ChildProcess) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

try {
  await Effect.runPromise(program);
  log("PASS");
  process.exitCode = 0;
} catch (error) {
  log("FAIL", error instanceof Error ? error.message : String(error));
  const logPath = NodePath.join(NodeOS.tmpdir(), "peer-smoke-server.log");
  NodeFS.writeFileSync(
    logPath,
    `${(server as ReturnType<typeof spawnLogged> | null)?.output.join("") ?? ""}\n---- hub ----\n${hub.output.join("")}`,
  );
  log("logs", logPath);
  process.exitCode = 1;
} finally {
  // Stop what this run spawned, and wait so the ports are free again.
  const spawned = server as ReturnType<typeof spawnLogged> | null;
  if (spawned !== null) await stop(spawned.child);
  await stop(hub.child);
  if (herdr !== null) {
    try {
      herdrCli("server", "stop");
    } catch {
      // Already gone.
    }
    await stop(herdr.child);
  }
  if (process.env.KEEP_SMOKE_HOME !== "1") NodeFS.rmSync(home, { recursive: true, force: true });
}
