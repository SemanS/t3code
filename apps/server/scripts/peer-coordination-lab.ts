// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalFetch:off globalFetchInEffect:off globalConsole:off globalConsoleInEffect:off globalRandom:off globalRandomInEffect:off preferSchemaOverJson:off anyUnknownInErrorContext:off - host-side lab harness: drives real server processes and the scripts agents run.
// Coordination lab: two Peer servers (Ana's and Bob's computers) against a local Peer Hub, one
// project both checked out, and two agents simulated by running exactly the scripts Claude Code
// runs: the hook, the wake-up wait and `peer`. It checks the protocol end to end:
//
//   1. Ana's agent changes src/pricing.ts; nobody else is there, so it hears nothing.
//   2. Bob's agent is about to change the same file: it is stopped once, told who changed it and
//      how to answer, writes Ana's agent a note, and may then edit.
//   3. Ana's agent, idle, wakes up with Bob's note, answers and resolves the overlap.
//   4. Bob's agent hears the answer at its next step; neither ever reads the other's conversation.
//   5. Under the `ask` policy, Bob himself is asked instead, once.
//   6. Working contexts (after arXiv:2609.37725): the first agent on a work keeps its shared
//      context; the other reads it, may not edit it, hears when it changes, and sends what it
//      finds to the keeper. A compaction gives each agent back the context it keeps.
//   7. After Peer restarts, a session it meets again keeps what it shared.
//   8. When the keeper's session ends, the other agent keeps the shared context.
//
// It prints what each agent was told and leaves both computers' coordination logs.
//
//   PEERHUB_BIN=../server/target/debug/peerhub node apps/server/scripts/peer-coordination-lab.ts
//   KEEP_LAB=1 keeps the throwaway homes and logs.
//
// REAL_AGENTS=1 HERDR_BIN=… runs real Claude Code sessions instead (Sonnet, one herdr server per
// computer, Peer's hooks passed with --settings, the user's own settings and MCP servers left
// out) on two overlapping tasks, and prints what they did and told each other.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Socket from "effect/unstable/socket/Socket";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import { ORCHESTRATION_PROTOCOL_VERSION, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";

import { claudeHookGroups } from "../src/peerHub/coordination.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const peerhubBin = process.env.PEERHUB_BIN ?? "peerhub";
const hubPort = 42000 + Math.floor(Math.random() * 1000);
const hubUrl = `http://127.0.0.1:${hubPort}`;
const lab = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "peer-lab-"));
const bin = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
const children: NodeChildProcess.ChildProcess[] = [];

function say(step: string, detail = "") {
  console.log(`[lab] ${step}${detail === "" ? "" : `: ${detail}`}`);
}
function told(agent: string, text: string | null | undefined) {
  console.log(
    `\n  ┌ ${agent} was told:\n  │ ${(text ?? "(nothing)").replaceAll("\n", "\n  │ ")}\n  └\n`,
  );
}
function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`expected: ${what}`);
  say("ok", what);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnLogged(command: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = NodeChildProcess.spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  return { child, output };
}

async function waitFor(what: string, ready: () => Promise<boolean>, output: string[]) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await ready().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error(`${what} did not start:\n${output.join("").slice(-2000)}`);
}

// ---- the hub, and the workspace an admin set up ----

const hub = spawnLogged(peerhubBin, ["serve"], {
  ...process.env,
  PEERHUB_DB: "mem://lab",
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

function git(cwd: string, ...args: string[]) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "lab",
      GIT_AUTHOR_EMAIL: "lab@acme.test",
      GIT_COMMITTER_NAME: "lab",
      GIT_COMMITTER_EMAIL: "lab@acme.test",
    },
  });
}

/** A small project both agents will work on, as a bare origin. */
function makeOrigin(): string {
  const work = NodePath.join(lab, "seed");
  NodeFS.mkdirSync(NodePath.join(work, "src"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(work, "src/pricing.ts"),
    "export function price(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(work, "src/cart.ts"),
    'import { price } from "./pricing";\n\nexport const cartTotal = (items: number[]) => price(items);\n',
  );
  git(work, "init", "--quiet", "--initial-branch", "main");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "pricing");
  const origin = NodePath.join(lab, "origin.git");
  git(lab, "clone", "--quiet", "--bare", work, origin);
  return origin;
}

/** Ana's session with the hub, to read what it stores. */
let hubSession = "";

async function setUpWorkspace() {
  const started = await hubCall("/v1/auth/email/start", {
    method: "POST",
    body: { email: "ana@acme.test" },
  });
  const finished = await hubCall("/v1/auth/email/verify", {
    method: "POST",
    body: { email: "ana@acme.test", code: started.code },
  });
  const admin = finished.session as string;
  hubSession = admin;
  await hubCall("/v1/workspaces", {
    method: "POST",
    session: admin,
    body: { slug: "acme", name: "Acme", allowedDomains: ["acme.test"] },
  });
  await hubCall("/v1/workspaces/acme/config", {
    method: "PUT",
    session: admin,
    body: {
      revision: "lab",
      config: {
        people: { "ana@acme.test": { name: "Ana" }, "bob@acme.test": { name: "Bob" } },
        projects: {
          lab: { name: "Lab", repositories: [{ id: "app", url: makeOrigin(), branch: "main" }] },
        },
      },
    },
  });
}

// ---- two computers ----

const startComputer = (name: string, email: string, herdrSocket?: string) =>
  Effect.gen(function* () {
    const home = NodePath.join(lab, name.toLowerCase());
    const workspaceRoot = NodePath.join(home, "workspace");
    const port = 43000 + Math.floor(Math.random() * 1000);
    const env = {
      ...process.env,
      PEER_HUB_URL: hubUrl,
      PEER_WORKSPACE: workspaceRoot,
      // Never this machine's real herdr or Claude Code settings.
      HERDR_SOCKET_PATH: herdrSocket ?? NodePath.join(home, "no-herdr.sock"),
      CLAUDE_CONFIG_DIR: NodePath.join(home, "claude"),
      T3CODE_TELEMETRY_ENABLED: "false",
    };
    const server = spawnLogged(
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
    yield* Effect.promise(() =>
      waitFor(
        `${name}'s server`,
        async () => server.output.join("").includes("Listening on"),
        server.output,
      ),
    );
    yield* Effect.sleep("1500 millis");
    const token = NodeChildProcess.execFileSync(
      process.execPath,
      [bin, "auth", "session", "issue", "--base-dir", home, "--token-only", "--label", "lab"],
      { env, encoding: "utf8" },
    ).trim();
    const ticket = yield* Effect.promise(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
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
    const context = yield* Layer.build(protocol);
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));

    const pending = yield* client[WS_METHODS.peerHubStartSignIn]({ email });
    yield* client[WS_METHODS.peerHubFinishSignIn]({
      code: pending.pendingSignIn?.echoedCode ?? "",
    });
    const opened = yield* client[WS_METHODS.peerHubOpenProject]({
      workspace: "acme",
      projectId: "lab",
    });
    const checkout = opened.workspaces[0]?.projects.find((p) => p.project.id === "lab")
      ?.repositories[0];
    if (checkout?.state !== "ready") throw new Error(`${name} could not check the project out`);
    const coordinated = yield* client[WS_METHODS.peerHubSetCoordination]({
      enabled: true,
      policy: "coordinate",
    });
    say(`${name}'s computer`, `checkout ${checkout.path}, log ${coordinated.coordination.logPath}`);
    const scriptsDir = NodePath.join(home, "userdata", "coord");
    return {
      name,
      home,
      client,
      checkout: checkout.path,
      scripts: {
        hook: NodePath.join(scriptsDir, "hook"),
        wait: NodePath.join(scriptsDir, "wait"),
        peer: NodePath.join(scriptsDir, "bin", "peer"),
      },
      log: coordinated.coordination.logPath,
    };
  });

type Computer = Effect.Success<ReturnType<typeof startComputer>>;

// ---- agents, as Claude Code runs their hooks ----

/** What a hook printed for Claude Code. */
type HookOut = {
  readonly hookSpecificOutput?: {
    readonly additionalContext?: string;
    readonly permissionDecision?: string;
    readonly permissionDecisionReason?: string;
    readonly updatedInput?: { readonly command?: string };
  };
} | null;

function agent(computer: Computer, sessionId: string, pane: string) {
  const env = { ...process.env, HERDR_PANE_ID: pane };
  const base = { session_id: sessionId, cwd: computer.checkout, transcript_path: "/dev/null" };
  const file = (path: string) => NodePath.join(computer.checkout, path);
  return {
    name: `${computer.name}'s agent`,
    cli: computer.scripts.peer,
    file,
    hook(event: string, extra: Record<string, unknown> = {}): HookOut {
      const out = NodeChildProcess.execFileSync("sh", [computer.scripts.hook], {
        env,
        input: JSON.stringify({ ...base, hook_event_name: event, ...extra }),
        encoding: "utf8",
      }).trim();
      return out === "" ? null : (JSON.parse(out) as HookOut);
    },
    edit(event: "PreToolUse" | "PostToolUse", path: string) {
      return this.hook(event, {
        tool_name: "Edit",
        tool_input: { file_path: file(path), old_string: "a", new_string: "b" },
      });
    },
    /** Runs `peer …` the way the agent's Bash tool would: its hook first, then what the hook made of it. */
    peer(...args: string[]) {
      const command = ["peer", ...args.map((a) => `"${a}"`)].join(" ");
      const gate = this.hook("PreToolUse", { tool_name: "Bash", tool_input: { command } });
      const rewritten = gate?.hookSpecificOutput?.updatedInput?.command;
      if (gate?.hookSpecificOutput?.permissionDecision !== "allow" || rewritten === undefined) {
        throw new Error(`Peer's own command was not let through: ${JSON.stringify(gate)}`);
      }
      return NodeChildProcess.execFileSync("sh", ["-c", rewritten], {
        env,
        cwd: computer.checkout,
        encoding: "utf8",
      }).trim();
    },
    /**
     * A session starting as Claude Code starts it: the SessionStart hook may write the
     * session's environment, which every later Bash command of the session sources.
     */
    start(): { readonly envFile: string; readonly told: string | undefined } {
      const envFile = NodePath.join(computer.home, `env-${sessionId}.sh`);
      NodeFS.writeFileSync(envFile, "");
      const out = NodeChildProcess.execFileSync("sh", [computer.scripts.hook], {
        env: { ...env, CLAUDE_ENV_FILE: envFile },
        input: JSON.stringify({ ...base, hook_event_name: "SessionStart", source: "startup" }),
        encoding: "utf8",
      }).trim();
      return { envFile, told: context(out === "" ? null : (JSON.parse(out) as HookOut)) };
    },
    /** A command as the agent's Bash tool runs it: in the session's environment. */
    shell(envFile: string, command: string): string {
      return NodeChildProcess.execFileSync("sh", ["-c", `. '${envFile}'; ${command}`], {
        env,
        cwd: computer.checkout,
        encoding: "utf8",
      }).trim();
    },
    /** The Stop hook's background wait: resolves with what woke the agent, or null. */
    idle(): Promise<string | null> {
      this.hook("Stop");
      return new Promise((resolve) => {
        const child = NodeChildProcess.spawn("sh", [computer.scripts.wait], {
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(child);
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("exit", (code) => resolve(code === 2 ? stderr.trim() : null));
        child.stdin.end(JSON.stringify({ ...base, hook_event_name: "Stop" }));
      });
    },
  };
}

const context = (out: HookOut) => out?.hookSpecificOutput?.additionalContext;
const decision = (out: HookOut) => out?.hookSpecificOutput?.permissionDecision;
const reason = (out: HookOut) => out?.hookSpecificOutput?.permissionDecisionReason;

const program = Effect.gen(function* () {
  yield* Effect.promise(() =>
    waitFor("the hub", async () => (await fetch(`${hubUrl}/health`)).ok, hub.output),
  );
  yield* Effect.promise(setUpWorkspace);
  const ana = yield* startComputer("Ana", "ana@acme.test");
  const bob = yield* startComputer("Bob", "bob@acme.test");
  const anas = agent(ana, "lab-ana", "w1:p1");
  const bobs = agent(bob, "lab-bob", "w1:p1");

  // 1. Ana's agent changes pricing alone: nothing to hear.
  const anaStart = context(anas.hook("SessionStart", { source: "startup" }));
  told(anas.name, anaStart);
  anas.hook("UserPromptSubmit", { prompt: "Add 20% VAT to price() in src/pricing.ts" });
  const first = anas.edit("PreToolUse", "src/pricing.ts");
  check(
    decision(first) === undefined && context(first) === undefined,
    "an agent alone on a file hears nothing",
  );
  anas.edit("PostToolUse", "src/pricing.ts");
  yield* Effect.promise(() => sleep(1200));

  // 2. Bob's agent is about to change the same file.
  const { envFile: bobsEnv, told: bobStart } = bobs.start();
  told(
    bobs.name,
    context(bobs.hook("UserPromptSubmit", { prompt: "Rename price() to totalPrice() everywhere" })),
  );
  const stopped = bobs.edit("PreToolUse", "src/pricing.ts");
  told(bobs.name, reason(stopped));
  check(
    decision(stopped) === "deny",
    "the second agent is stopped before touching the first one's file",
  );
  check(
    reason(stopped)?.includes("Ana's agent") && reason(stopped)?.includes("note"),
    "it hears who and how to answer",
  );
  const noted = bobs.peer(
    "note",
    "I rename price() to totalPrice() in src/pricing.ts and src/cart.ts; please add VAT on totalPrice().",
  );
  told(`${bobs.name} (peer note)`, noted);
  check(noted.startsWith("Noted on overlap"), "its note reaches the overlap");
  const allowed = bobs.edit("PreToolUse", "src/pricing.ts");
  check(decision(allowed) === undefined, "after its note, it may edit");
  // As agents like to run it: through a pipe, found on the session's PATH.
  const piped = bobs.shell(bobsEnv, "peer status 2>&1 | head -3");
  told(`${bobs.name} (peer status 2>&1 | head -3)`, piped);
  check(
    piped.includes("Peer · project lab · you: Bob's agent"),
    "peer works in any command, and knows which session calls",
  );
  const firstChange = bobs.edit("PostToolUse", "src/pricing.ts");
  check(
    context(firstChange)?.includes("your working context") === true,
    "at its first change it is reminded, once, that its working context is still empty",
  );
  bobs.edit("PreToolUse", "src/cart.ts");
  check(
    !(context(bobs.edit("PostToolUse", "src/cart.ts")) ?? "").includes("working context"),
    "and not again",
  );

  // 3. Ana's agent went idle; Bob's note wakes it up.
  const woke = yield* Effect.promise(() =>
    Promise.race([anas.idle(), sleep(15_000).then(() => "(timed out)")]),
  );
  told(`${anas.name} (woken up)`, woke);
  check(woke?.includes("totalPrice"), "the idle agent wakes up with the other agent's note");
  told(
    `${anas.name} (peer note)`,
    anas.peer("note", "Agreed: I will add VAT on totalPrice() after your rename."),
  );
  told(
    `${anas.name} (peer resolve)`,
    anas.peer("resolve", "Bob renames price() to totalPrice() first; Ana adds VAT on top."),
  );
  yield* Effect.promise(() => sleep(3500));

  // 4. Bob's agent hears the answer at its next step.
  const heard = bobs.edit("PostToolUse", "src/cart.ts");
  told(bobs.name, context(heard));
  check(context(heard)?.includes("Agreed"), "the other agent hears the answer at its next step");
  told(`${anas.name} (peer status)`, anas.peer("status"));

  // 5. Under `ask`, Bob decides himself, once.
  yield* bob.client[WS_METHODS.peerHubSetCoordination]({ policy: "ask" });
  anas.hook("UserPromptSubmit", { prompt: "Also format prices in src/format.ts" });
  anas.edit("PreToolUse", "src/format.ts");
  anas.edit("PostToolUse", "src/format.ts");
  yield* Effect.promise(() => sleep(3500));
  const asked = bobs.edit("PreToolUse", "src/format.ts");
  told(`Bob (asked by Claude Code's permission prompt)`, reason(asked));
  check(decision(asked) === "ask", "under the ask policy the person is asked");
  bobs.edit("PostToolUse", "src/format.ts");
  check(
    decision(bobs.edit("PreToolUse", "src/format.ts")) === undefined,
    "once approved, not asked again",
  );

  // 6. Working contexts (experimental, after arXiv:2609.37725): one writer per shared context.
  check(
    anaStart?.includes("You keep the shared context of lab (work outside tasks)") === true,
    "the first agent on a work keeps its shared context",
  );
  const sharedPath = /You keep the shared context of .+? in (\S+\.md)\./.exec(anaStart ?? "")?.[1];
  check(
    sharedPath !== undefined && NodeFS.existsSync(sharedPath),
    "Peer started it from a template",
  );
  const editShared = (who: ReturnType<typeof agent>, path: string) =>
    who.hook("PreToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: path, old_string: "a", new_string: "b" },
    });
  check(decision(editShared(anas, sharedPath)) === "allow", "its keeper edits it unasked");
  NodeFS.writeFileSync(
    sharedPath,
    [
      "# lab (work outside tasks)",
      "## State",
      "- Bob's agent renames price() to totalPrice(); Ana's adds VAT on top",
      "## Decisions",
      "- VAT is added in one place, applyVat()",
      "## Next",
      "- VAT once the rename lands",
    ].join("\n"),
  );
  anas.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: sharedPath, content: "(the context above)" },
  });
  const stored = yield* Effect.promise(() =>
    hubCall("/v1/workspaces/acme/contexts/lab/project", { session: hubSession }),
  );
  check(
    stored.version === 1 && String(stored.text).includes("applyVat()"),
    "the hub has its new version",
  );
  yield* Effect.promise(() => sleep(3500));
  const bobShared = NodePath.join(bob.home, "userdata/coord/contexts/acme/lab/shared/project.md");
  check(
    NodeFS.readFileSync(bobShared, "utf8").includes("applyVat()"),
    "the other computer has it too",
  );
  const refused = editShared(bobs, bobShared);
  told(`${bobs.name} (editing the shared context)`, reason(refused));
  check(
    decision(refused) === "deny" && reason(refused)?.includes("Ana's agent keeps") === true,
    "the other agent reads it and may not edit it",
  );
  const changed = context(bobs.edit("PostToolUse", "src/cart.ts"));
  told(`${bobs.name} (next step)`, changed);
  check(
    changed?.includes("changed (version 1, by Ana's agent") === true &&
      changed.includes("applyVat()") &&
      changed.includes("not instructions"),
    "it hears the change at its next step, as reference from its team",
  );
  const bobOwn = /Peer keeps your working context in (\S+\.md)\./.exec(bobStart ?? "")?.[1];
  check(
    bobOwn !== undefined && NodeFS.existsSync(bobOwn),
    "the other agent keeps a working context of its own",
  );
  NodeFS.writeFileSync(
    bobOwn,
    [
      "# Working context",
      "Goal: rename price() to totalPrice()",
      "## Now",
      "- renaming the callers in src/cart.ts",
      "## For the team",
      "- price() is now totalPrice() everywhere; nothing else called it",
    ].join("\n"),
  );
  bobs.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: bobOwn, content: "(the context above)" },
  });
  yield* Effect.promise(() => sleep(3500));
  const toKeeper = context(anas.edit("PostToolUse", "src/pricing.ts"));
  told(`${anas.name} (next step)`, toKeeper);
  check(
    toKeeper?.includes("you keep, your teammates' agents found") === true &&
      toKeeper.includes("totalPrice() everywhere"),
    "what the other agent found reaches the keeper, to fold in",
  );
  check(
    !(context(anas.edit("PostToolUse", "src/pricing.ts")) ?? "").includes(
      "totalPrice() everywhere",
    ),
    "and reaches it once",
  );
  const kept = NodeFS.readFileSync(sharedPath, "utf8");
  NodeFS.writeFileSync(sharedPath, `${kept}\n${"- an endless log line\n".repeat(2000)}`);
  const tooLong = context(
    anas.hook("PostToolUse", {
      tool_name: "Write",
      tool_input: { file_path: sharedPath, content: "(too long)" },
    }),
  );
  check(
    tooLong?.includes("over 32 KiB") === true,
    "a keeper whose context outgrows what the hub keeps is told to shorten it",
  );
  NodeFS.writeFileSync(sharedPath, kept);
  anas.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: sharedPath, content: "(shortened)" },
  });
  const keeperBack = context(anas.hook("SessionStart", { source: "compact" }));
  told(`${anas.name} (after a compaction)`, keeperBack);
  check(
    keeperBack?.includes("the shared context as it stands (version 1)") === true &&
      keeperBack.includes("applyVat()"),
    "after a compaction the keeper gets the shared context back",
  );
  const readerBack = context(bobs.hook("SessionStart", { source: "compact" }));
  told(`${bobs.name} (after a compaction)`, readerBack);
  check(
    readerBack?.includes("renaming the callers in src/cart.ts") === true &&
      readerBack.includes("kept by Ana's agent (version 1"),
    "and the other agent its own context, with the shared one to read",
  );

  // 7. Peer restarts (here: Bob's coordination stops and starts): a session it meets again keeps
  //    what it shares, so the team keeps its findings.
  yield* bob.client[WS_METHODS.peerHubSetCoordination]({ enabled: false });
  yield* bob.client[WS_METHODS.peerHubSetCoordination]({ enabled: true });
  bobs.edit("PreToolUse", "src/cart.ts");
  bobs.edit("PostToolUse", "src/cart.ts");
  yield* Effect.promise(() => sleep(3500));
  const view = yield* Effect.promise(() =>
    hubCall("/v1/workspaces/acme/coord", { session: hubSession }),
  );
  check(
    (view.findings as ReadonlyArray<{ text: string }>).some((f) =>
      f.text.includes("totalPrice() everywhere"),
    ),
    "after Peer restarts, what an agent shared stays with the team",
  );

  // 8. Ana's agent ends: Bob's keeps the shared context from where it stands.
  anas.hook("SessionEnd", { reason: "exit" });
  let keeper: unknown;
  for (let attempt = 0; attempt < 60 && keeper !== "claude:lab-bob"; attempt += 1) {
    yield* Effect.promise(() => sleep(500));
    const now = yield* Effect.promise(() =>
      hubCall("/v1/workspaces/acme/contexts/lab/project", { session: hubSession }),
    );
    keeper = (now.keeper as { session?: string } | undefined)?.session;
  }
  check(keeper === "claude:lab-bob", "the other agent keeps it once the keeper's session ended");
  const handed = context(bobs.edit("PostToolUse", "src/cart.ts"));
  told(`${bobs.name} (next step)`, handed);
  check(
    handed?.includes("you keep the shared context of lab (work outside tasks) now") === true &&
      handed.includes("applyVat()"),
    "it hears so at its next step, with the context as it stands",
  );
  check(decision(editShared(bobs, bobShared)) === "allow", "and may edit it now");

  for (const computer of [ana, bob]) {
    const lines = NodeFS.readFileSync(computer.log, "utf8").trim().split("\n");
    const events = lines.map((line) => (JSON.parse(line) as { event: string }).event);
    const tally = new Map<string, number>();
    for (const event of events) tally.set(event, (tally.get(event) ?? 0) + 1);
    const counts = [...tally.entries()];
    say(
      `${computer.name}'s log`,
      `${computer.log} — ${lines.length} events: ${counts.map(([e, n]) => `${e}×${n}`).join(", ")}`,
    );
  }
}).pipe(Effect.scoped);

// ---- real agents: Claude Code in herdr on each computer ----

const herdrBin = process.env.HERDR_BIN ?? "herdr";

function startHerdr(name: string) {
  const base = NodePath.join(lab, `${name.toLowerCase()[0]}h`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: NodePath.join(base, "c"),
    XDG_STATE_HOME: NodePath.join(base, "s"),
  };
  for (const key of ["HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_ENV", "HERDR_PANE_ID"])
    delete env[key];
  const server = spawnLogged(herdrBin, ["server"], env);
  return { env, server, socket: NodePath.join(base, "c", "herdr", "herdr.sock") };
}
type HerdrServer = ReturnType<typeof startHerdr>;

function herdrJson(h: HerdrServer, ...args: string[]): Record<string, any> {
  try {
    const out = NodeChildProcess.execFileSync(herdrBin, args, { env: h.env, encoding: "utf8" });
    return JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as Record<string, any>;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    return { error: stderr.trim() };
  }
}
function herdrText(h: HerdrServer, ...args: string[]): string {
  try {
    return NodeChildProcess.execFileSync(herdrBin, args, { env: h.env, encoding: "utf8" });
  } catch {
    return "";
  }
}

async function startClaude(h: HerdrServer, computer: Computer, name: string) {
  const settings = NodePath.join(computer.home, "claude-settings.json");
  NodeFS.writeFileSync(
    settings,
    JSON.stringify({ hooks: claudeHookGroups(computer.scripts) }, null, 2),
  );
  const created = herdrJson(
    h,
    "workspace",
    "create",
    "--cwd",
    computer.checkout,
    "--label",
    name,
    "--no-focus",
  );
  const pane = created.result?.root_pane?.pane_id as string;
  const claudeArgs = [
    "--setting-sources",
    "project",
    "--settings",
    settings,
    "--strict-mcp-config",
    "--permission-mode",
    "acceptEdits",
    "--model",
    "sonnet",
  ];
  for (let launch = 0; launch < 3; launch += 1) {
    herdrJson(
      h,
      "agent",
      "start",
      name,
      "--kind",
      "claude",
      "--pane",
      pane,
      "--timeout",
      "90000",
      "--",
      ...claudeArgs,
    );
    // First run in a new folder, Claude Code asks whether to trust it with "No, exit" preselected:
    // move to "Yes" and confirm only once the cursor is there.
    for (let step = 0; step < 30; step += 1) {
      const status = herdrJson(h, "agent", "get", pane).result?.agent?.agent_status;
      if (status === "idle" || status === "done") {
        herdrText(h, "agent", "rename", pane, name);
        say(`${name} started`, `${computer.name}'s Claude Code in herdr pane ${pane}`);
        return pane;
      }
      const screen = herdrText(h, "pane", "read", pane, "--source", "visible");
      if (screen.includes("Yes, I trust this folder")) {
        herdrText(
          h,
          "pane",
          "send-keys",
          pane,
          /❯\s*Yes, I trust this folder/.test(screen) ? "enter" : "down",
        );
      } else if (!screen.includes("Claude Code") && step > 3) {
        break; // it exited: start it again
      }
      await sleep(1500);
    }
  }
  throw new Error(`${name}'s Claude Code did not start`);
}

const statusOf = (h: HerdrServer, pane: string) =>
  (herdrJson(h, "agent", "get", pane).result?.agent?.agent_status as string | undefined) ?? "?";

const realProgram = Effect.gen(function* () {
  yield* Effect.promise(() =>
    waitFor("the hub", async () => (await fetch(`${hubUrl}/health`)).ok, hub.output),
  );
  yield* Effect.promise(setUpWorkspace);
  const anaHerdr = startHerdr("Ana");
  const bobHerdr = startHerdr("Bob");
  const ana = yield* startComputer("Ana", "ana@acme.test", anaHerdr.socket);
  const bob = yield* startComputer("Bob", "bob@acme.test", bobHerdr.socket);
  yield* Effect.promise(() => sleep(2000));
  const anaPane = yield* Effect.promise(() => startClaude(anaHerdr, ana, "ana"));
  const bobPane = yield* Effect.promise(() => startClaude(bobHerdr, bob, "bob"));

  const anaTask =
    "In src/pricing.ts give price() a VAT rate: price(items, vatRate = 0.2) returns the sum with VAT added. Keep the change small; do not run tests or builds.";
  const bobTask =
    "Rename the function price() to totalPrice() in src/pricing.ts and update its caller in src/cart.ts. Keep the change small; do not run tests or builds.";
  herdrJson(anaHerdr, "agent", "prompt", anaPane, anaTask);
  say("Ana's agent prompted", anaTask);
  // Bob's agent starts once Ana's has changed the file.
  for (let waited = 0; waited < 90_000; waited += 2000) {
    yield* Effect.promise(() => sleep(2000));
    const log = NodeFS.existsSync(ana.log) ? NodeFS.readFileSync(ana.log, "utf8") : "";
    if (log.includes('"hookEvent":"PostToolUse"')) break;
  }
  herdrJson(bobHerdr, "agent", "prompt", bobPane, bobTask);
  say("Bob's agent prompted", bobTask);

  // Let them work, wake each other and settle: until both are quiet for a while.
  let quiet = 0;
  for (let elapsed = 0; elapsed < 8 * 60_000 && quiet < 45_000; elapsed += 5000) {
    yield* Effect.promise(() => sleep(5000));
    const statuses = [statusOf(anaHerdr, anaPane), statusOf(bobHerdr, bobPane)];
    quiet = statuses.every((s) => s === "idle" || s === "done") ? quiet + 5000 : 0;
    say("agents", `Ana's ${statuses[0]}, Bob's ${statuses[1]}`);
  }

  for (const [computer, h, pane] of [
    [ana, anaHerdr, anaPane],
    [bob, bobHerdr, bobPane],
  ] as const) {
    console.log(`\n===== ${computer.name}'s agent, last screen =====`);
    console.log(
      herdrText(h, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "160"),
    );
    console.log(`===== ${computer.name}'s checkout: git diff =====`);
    console.log(git(computer.checkout, "diff"));
    console.log(`===== ${computer.name}'s coordination log: decisions, notes, wake-ups =====`);
    for (const line of NodeFS.readFileSync(computer.log, "utf8").trim().split("\n")) {
      const entry = JSON.parse(line) as { event: string; t: string; [field: string]: unknown };
      if (
        [
          "decision",
          "note.agent",
          "resolve.agent",
          "news",
          "wake",
          "overlap.opened",
          "cli",
          "claim",
        ].includes(entry.event)
      ) {
        console.log(JSON.stringify(entry).slice(0, 900));
      }
    }
  }
  herdrText(anaHerdr, "server", "stop");
  herdrText(bobHerdr, "server", "stop");
}).pipe(Effect.scoped);

try {
  await Effect.runPromise(process.env.REAL_AGENTS === "1" ? realProgram : program);
  say("PASS");
  process.exitCode = 0;
} catch (error) {
  say("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  await sleep(500);
  if (process.env.KEEP_LAB === "1") say("kept", lab);
  else NodeFS.rmSync(lab, { recursive: true, force: true });
}
