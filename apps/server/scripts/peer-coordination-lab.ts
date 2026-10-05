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
//      finds to the keeper. The keeper is asked to compact as it grows, the hub keeps its
//      versions, a person can bring one back, and a compaction gives each agent back its context.
//   7. After Peer restarts, a session it meets again keeps what it shared.
//   8. When the keeper's session ends, the other agent keeps the shared context.
//   9. A line the keeper marks [project] becomes a knowledge candidate that a person dismisses.
//  10. With kontext installed, Keep writes a candidate into the project's knowledge (staged), and
//      the project's reviewed guidance on what to mark reaches a new agent.
//
// It prints what each agent was told and leaves both computers' coordination logs.
//
//   PEERHUB_BIN=../server/target/debug/peerhub node apps/server/scripts/peer-coordination-lab.ts
//   KEEP_LAB=1 keeps the throwaway homes and logs.
//
// REAL_AGENTS=1 HERDR_BIN=… runs real Claude Code sessions instead (Sonnet, one herdr server per
// computer, Peer's hooks and context permissions passed with --settings, the user's own settings
// and MCP servers left out). Both agents work on task KRK-1 (their branch names it), on
// overlapping changes to a project whose prices are integer cents, and it checks what Peer did:
//
//   A. one agent keeps KRK-1's shared context, the other reads it and sends it what it finds;
//   B. the keeper idles while the other works (the idle threshold shortened to 45 s): the other
//      takes the context over;
//   C. what the agents marked [project] becomes knowledge candidates (or kontext reads the task's
//      context for them), and one is kept: worded by kontext's llm adapter and staged in .ai;
//   D. the keeper's session ends: the other agent keeps the context.
//
// It spends the person's Claude subscription (Sonnet for the agents, kontext's adapter for the
// knowledge), and prints what the agents did, told each other and kept.
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

import {
  claudeHookGroups,
  codexHookGroups,
  codexHookHash,
  withContextAccess,
} from "../src/peerHub/coordination.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const peerhubBin = process.env.PEERHUB_BIN ?? "peerhub";
const hubPort = 42000 + Math.floor(Math.random() * 1000);
const hubUrl = `http://127.0.0.1:${hubPort}`;
const lab = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "peer-lab-"));
const REAL = process.env.REAL_AGENTS === "1";
/** With real agents, a keeper idle this long gives way (production waits ten minutes). */
const REAL_IDLE_SECS = 45;
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
  ...(REAL ? { PEERHUB_KEEPER_IDLE_SECS: String(REAL_IDLE_SECS) } : {}),
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

/** Whether kontext is installed: the knowledge steps need it. */
const kontext = (() => {
  try {
    NodeChildProcess.execFileSync("kontext", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

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
  if (REAL) {
    // Prices are integer cents, and other files rely on it: something worth keeping.
    NodeFS.writeFileSync(
      NodePath.join(work, "src/format.ts"),
      "export const formatPrice = (cents: number): string => `€${(cents / 100).toFixed(2)}`;\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(work, "src/receipt.ts"),
      'import { formatPrice } from "./format";\nimport { price } from "./pricing";\n\nexport const receiptLine = (items: number[]) => formatPrice(price(items));\n',
    );
  }
  git(work, "init", "--quiet", "--initial-branch", "main");
  // The project keeps knowledge with kontext, when it is installed here.
  if (kontext) NodeChildProcess.execFileSync("kontext", ["init", "--no-hooks"], { cwd: work });
  if (REAL && kontext) {
    NodeFS.mkdirSync(NodePath.join(work, ".ai", "conventions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(work, ".ai", "conventions", "what-agents-mark-for-the-project.md"),
      [
        "---",
        "id: what-agents-mark-for-the-project",
        "kind: convention",
        'title: "What agents mark for the project"',
        "date: 2026-10-04",
        "tags: [peer-skill]",
        "---",
        "",
        "Mark [project] the rules prices follow here (units, rounding) and what other files rely on; leave renames, progress, plans and what your own change does unmarked.",
      ].join("\n"),
    );
  }
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
  if (REAL) {
    await hubCall("/v1/workspaces/acme/projects/lab/tasks", {
      method: "POST",
      session: admin,
      body: { title: "Pricing", key: "KRK-1" },
    });
  }
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
      ...(REAL
        ? {
            PEER_KEEPER_IDLE_MS: String(REAL_IDLE_SECS * 1000),
            // kontext's llm adapter runs on the person's own Claude Code, as it would in Peer.
            PEER_KONTEXT_CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? "",
          }
        : {
            // Kept knowledge is written without a model: nothing here spends a subscription.
            PEER_KNOWLEDGE_LLM: "off",
            // Peer adds its hooks to this computer's own Codex, never this machine's, and hands
            // nothing to Codex threads: the lab's Codex sessions are made up.
            CODEX_HOME: NodePath.join(home, "codex"),
            PEER_CODEX_QUEUE: "off",
          }),
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
    /** Codex's answer to a PermissionRequest. */
    readonly decision?: { readonly behavior?: string };
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

/**
 * An agent as Codex runs Peer's hooks: the hook told it is Codex's, Codex's
 * payloads, its shell as Bash and its edits as apply_patch with paths relative
 * to its directory, and its commands given their thread as CODEX_THREAD_ID.
 */
function codexAgent(computer: Computer, sessionId: string, pane: string) {
  const env = { ...process.env, HERDR_PANE_ID: pane };
  const base = {
    session_id: sessionId,
    cwd: computer.checkout,
    transcript_path: null,
    model: "gpt-5",
    permission_mode: "default",
    turn_id: "turn-1",
  };
  const patch = (paths: ReadonlyArray<string>) =>
    [
      "*** Begin Patch",
      ...paths.flatMap((path) => [`*** Update File: ${path}`, "@@", "-a", "+b"]),
      "*** End Patch",
    ].join("\n");
  return {
    name: `${computer.name}'s agent (Codex)`,
    hook(event: string, extra: Record<string, unknown> = {}): HookOut {
      const out = NodeChildProcess.execFileSync("sh", [computer.scripts.hook, "codex"], {
        env,
        input: JSON.stringify({ ...base, hook_event_name: event, ...extra }),
        encoding: "utf8",
      }).trim();
      return out === "" ? null : (JSON.parse(out) as HookOut);
    },
    patch(event: "PreToolUse" | "PostToolUse", paths: ReadonlyArray<string>) {
      return this.hook(event, {
        tool_name: "apply_patch",
        tool_use_id: "call-patch",
        tool_input: { command: patch(paths) },
        ...(event === "PostToolUse"
          ? { tool_response: "Success. Updated the following files" }
          : {}),
      });
    },
    /** `peer …` as Codex's Bash runs it: the hook rewrites it, Codex runs what it was given. */
    peer(...args: string[]): { readonly ran: string; readonly out: string } {
      const command = `peer ${args.map((a) => `"${a}"`).join(" ")} 2>&1 | head -20`;
      const gate = this.hook("PreToolUse", {
        tool_name: "Bash",
        tool_use_id: "call-peer",
        tool_input: { command },
      });
      const ran = gate?.hookSpecificOutput?.updatedInput?.command;
      if (gate?.hookSpecificOutput?.permissionDecision !== "allow" || ran === undefined) {
        throw new Error(`Peer's own command was not let through: ${JSON.stringify(gate)}`);
      }
      const out = NodeChildProcess.execFileSync("sh", ["-c", ran], {
        env: { ...env, CODEX_THREAD_ID: sessionId },
        cwd: computer.checkout,
        encoding: "utf8",
      }).trim();
      return { ran, out };
    },
    /** Codex asking its person for a tool call. */
    permission(toolName: string, toolInput: Record<string, unknown>) {
      return this.hook("PermissionRequest", { tool_name: toolName, tool_input: toolInput });
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
  const roster = context(
    anas.hook("UserPromptSubmit", { prompt: "Also format prices in src/format.ts" }),
  );
  told(`${anas.name} (next prompt)`, roster);
  check(
    roster?.includes("Peer · on the work whose context you keep: Bob's agent") === true &&
      roster.includes("joined"),
    "the agent keeping the work's context hears who joined the work",
  );
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
  // The keeper compacts as its context grows, and may: Peer keeps its versions.
  const kept = NodeFS.readFileSync(sharedPath, "utf8");
  const writeShared = (text: string) => {
    NodeFS.writeFileSync(sharedPath, text);
    return context(
      anas.hook("PostToolUse", {
        tool_name: "Write",
        tool_input: { file_path: sharedPath, content: "(the context above)" },
      }),
    );
  };
  const big = writeShared(`${kept}\n${"- an endless log line\n".repeat(1150)}`);
  told(`${anas.name} (its context grew)`, big);
  check(
    big?.includes("Compact it now") === true,
    "a keeper whose context passes about 6K tokens is asked to compact it",
  );
  check(
    writeShared(`${kept}\n${"- an endless log line\n".repeat(2000)}`)?.includes("over 32 KiB") ===
      true,
    "a keeper whose context outgrows what the hub keeps is told to shorten it",
  );
  writeShared(kept);
  writeShared(`${kept}\n- retry once on an empty answer`);
  const history = anas.peer("context", "history");
  told(`${anas.name} (peer context history)`, history);
  check(
    /^ {2}4 .*\n {2}3 .*\n {2}2 .*\n {2}1 /m.test(history),
    "the hub keeps every version the keeper wrote",
  );
  const older = bobs.peer("context", "2");
  check(older.includes("an endless log line"), "and any agent on the work reads an older one back");

  // Bob brings version 1 back from Peer: Ana's agent hears it and goes on from it.
  yield* bob.client[WS_METHODS.peerHubRestoreContext]({
    workspace: "acme",
    project: "lab",
    scope: "project",
    version: 1,
  });
  yield* Effect.promise(() => sleep(3500));
  const replaced = context(anas.edit("PostToolUse", "src/pricing.ts"));
  told(`${anas.name} (next step)`, replaced);
  check(
    replaced?.includes(
      "Bob brought version 1 of the shared context you keep back (now version 5)",
    ) === true,
    "a keeper hears when a person brings an older version back",
  );
  check(
    !NodeFS.readFileSync(sharedPath, "utf8").includes("retry once"),
    "and the file it keeps has that version",
  );
  const keeperBack = context(anas.hook("SessionStart", { source: "compact" }));
  told(`${anas.name} (after a compaction)`, keeperBack);
  check(
    keeperBack?.includes("the shared context as it stands (version 5)") === true &&
      keeperBack.includes("applyVat()"),
    "after a compaction the keeper gets the shared context back",
  );
  const readerBack = context(bobs.hook("SessionStart", { source: "compact" }));
  told(`${bobs.name} (after a compaction)`, readerBack);
  check(
    readerBack?.includes("renaming the callers in src/cart.ts") === true &&
      readerBack.includes("kept by Ana's agent (version 5"),
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
    handed?.includes(
      "you (Bob's agent) keep the shared context of lab (work outside tasks) now",
    ) === true && handed.includes("applyVat()"),
    "it hears so at its next step, with the context as it stands",
  );
  check(decision(editShared(bobs, bobShared)) === "allow", "and may edit it now");

  // 9. What an agent marks for the project becomes a knowledge candidate people decide on.
  NodeFS.writeFileSync(
    bobShared,
    `${NodeFS.readFileSync(bobShared, "utf8")}\n## Findings\n- [project] totalPrice() is the only way into pricing; price() is gone\n`,
  );
  bobs.hook("PostToolUse", {
    tool_name: "Write",
    tool_input: { file_path: bobShared, content: "(the context above)" },
  });
  yield* Effect.promise(() => sleep(3500));
  const candidates = yield* ana.client[WS_METHODS.peerHubKnowledgeCandidates]({
    workspace: "acme",
    project: "lab",
  });
  told("Ana's Peer (knowledge candidates)", JSON.stringify(candidates, null, 2));
  const candidate = candidates.find((c) => c.text.startsWith("totalPrice() is the only way"));
  check(
    candidate !== undefined && candidate.finders === 1 && candidate.sources[0]?.tagged === true,
    "a line the keeper marked for the project is a knowledge candidate, its mark taken off",
  );
  yield* ana.client[WS_METHODS.peerHubDecideCandidate]({
    workspace: "acme",
    project: "lab",
    id: candidate.id,
    status: "dismissed",
  });
  const decided = yield* bob.client[WS_METHODS.peerHubKnowledgeCandidates]({
    workspace: "acme",
    project: "lab",
  });
  check(
    decided.find((c) => c.id === candidate.id)?.status === "dismissed",
    "a person dismisses it, for everyone on the project",
  );

  // 10. Kept knowledge goes into the project's own kontext store, and the project's guidance
  //     reaches its agents.
  if (!kontext) {
    say("skipped", "kontext is not installed: the knowledge steps need it");
  } else {
    const store = yield* ana.client[WS_METHODS.peerHubKnowledgeStatus]({
      workspace: "acme",
      project: "lab",
    });
    check(
      store.store && store.checkout === ana.checkout,
      "the project keeps knowledge with kontext",
    );
    yield* ana.client[WS_METHODS.peerHubDecideCandidate]({
      workspace: "acme",
      project: "lab",
      id: candidate.id,
      status: "proposed",
    });
    const kept = yield* ana.client[WS_METHODS.peerHubKeepCandidate]({
      workspace: "acme",
      project: "lab",
      id: candidate.id,
    });
    told("Ana's Peer (kept)", JSON.stringify(kept, null, 2));
    const staged = git(ana.checkout, "diff", "--cached", "--name-only");
    check(
      staged.includes(kept.keptAs.path) &&
        NodeFS.readFileSync(NodePath.join(ana.checkout, kept.keptAs.path), "utf8").includes(
          "totalPrice() is the only way into pricing",
        ),
      "Keep writes it into the project's knowledge, staged for the next commit",
    );
    const after = yield* bob.client[WS_METHODS.peerHubKnowledgeCandidates]({
      workspace: "acme",
      project: "lab",
    });
    check(
      after.find((c) => c.id === candidate.id)?.keptAs?.path === kept.keptAs.path,
      "and everyone sees where it went",
    );
    NodeFS.mkdirSync(NodePath.join(bob.checkout, ".ai", "conventions"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(bob.checkout, ".ai", "conventions", "what-agents-mark-for-the-project.md"),
      [
        "---",
        "id: what-agents-mark-for-the-project",
        "kind: convention",
        'title: "What agents mark for the project"',
        "date: 2026-10-04",
        "tags: [peer-skill]",
        "---",
        "",
        "Mark how pricing behaves and what callers rely on; leave renames and progress unmarked.",
      ].join("\n"),
    );
    const guided = agent(bob, "lab-bob-guided", "w1:p3").start().told;
    told(`${bobs.name} (a new session, with the project's guidance)`, guided);
    check(
      guided?.includes("This project's own guidance on what to mark [project]") === true &&
        guided.includes("Mark how pricing behaves"),
      "a new agent gets the project's own reviewed guidance on what to mark",
    );
  }

  // 11. Codex agents take part as Claude Code's do. Peer adds its hooks to Codex beside its
  //     person's own, and a Codex session on Ana's computer meets Bob's Claude Code session.
  const codexHome = NodePath.join(ana.home, "codex");
  const codexHooksFile = NodePath.join(codexHome, "hooks.json");
  NodeFS.mkdirSync(codexHome, { recursive: true });
  const theirs = { type: "command", command: "/usr/bin/true" };
  NodeFS.writeFileSync(codexHooksFile, JSON.stringify({ hooks: { Stop: [{ hooks: [theirs] }] } }));
  const withCodex = yield* ana.client[WS_METHODS.peerHubSetCoordination]({ codexHooks: true });
  type CodexHooks = {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>;
  };
  const codexHooks = JSON.parse(NodeFS.readFileSync(codexHooksFile, "utf8")) as CodexHooks;
  check(
    codexHooks.hooks.Stop?.[0]?.hooks[0]?.command === "/usr/bin/true" &&
      String(codexHooks.hooks.Stop?.[1]?.hooks[0]?.command).endsWith("/hook codex") &&
      codexHooks.hooks.PreToolUse?.[0]?.matcher === "Bash|apply_patch",
    "Peer adds its hooks to Codex after its person's own, which keep their place",
  );
  check(
    NodeFS.readFileSync(NodePath.join(codexHome, "rules", "peer.rules"), "utf8").includes(
      JSON.stringify(ana.scripts.peer),
    ),
    "and lets only its own command past Codex's sandbox",
  );
  check(
    withCodex.coordination.codexHooks === true &&
      withCodex.coordination.codexHooksTrusted === false,
    "Peer says Codex runs them only once its person trusts them",
  );
  // Its person trusts them in Codex, which keeps the hash of each hook it trusts in config.toml.
  const trust = Object.entries(codexHooks.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group, g) =>
      group.hooks.flatMap((handler, h) =>
        String(handler.command).endsWith("/hook codex")
          ? [
              `[hooks.state."${codexHooksFile}:${event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}:${g}:${h}"]`,
              `trusted_hash = "${codexHookHash(event, group.matcher, handler) ?? ""}"`,
              "",
            ]
          : [],
      ),
    ),
  );
  NodeFS.writeFileSync(
    NodePath.join(codexHome, "config.toml"),
    ['model = "gpt-5"', "", ...trust].join("\n"),
  );
  const trustedNow = yield* ana.client[WS_METHODS.peerHubSetCoordination]({});
  check(
    trustedNow.coordination.codexHooksTrusted === true,
    "and that Codex runs them once its person trusted them",
  );

  const codexs = codexAgent(ana, "lab-ana-codex", "w1:p4");
  const codexStart = context(codexs.hook("SessionStart", { source: "startup" }));
  told(codexs.name, codexStart);
  check(
    codexStart?.includes("You are Ana's agent here.") === true &&
      codexStart.includes(ana.scripts.peer) &&
      codexStart.includes("working context"),
    "a Codex session starts with who it is, its working context and where Peer's command is",
  );
  codexs.hook("UserPromptSubmit", { prompt: "Show the VAT of each cart line in src/cart.ts" });
  const codexStopped = codexs.patch("PreToolUse", ["src/lines.ts", "src/cart.ts"]);
  told(`${codexs.name} (a patch on two files)`, reason(codexStopped));
  check(
    decision(codexStopped) === "deny" &&
      reason(codexStopped)?.includes("Bob's agent") === true &&
      reason(codexStopped)?.includes("note") === true,
    "a Codex patch stops at a file Bob's agent changed, whichever file of the patch it is",
  );
  const codexNote = codexs.peer(
    "note",
    "I add a VAT column to the cart lines in src/cart.ts; totalPrice() stays as it is.",
  );
  told(`${codexs.name} (peer note, run as ${codexNote.ran})`, codexNote.out);
  check(
    codexNote.ran.startsWith(ana.scripts.peer) &&
      !codexNote.ran.includes("head") &&
      codexNote.out.startsWith("Noted on overlap"),
    "Codex runs Peer's command as Peer's rule names it, and the note reaches the overlap",
  );
  check(
    decision(codexs.patch("PreToolUse", ["src/lines.ts", "src/cart.ts"])) === undefined,
    "after its note, it may patch",
  );
  codexs.patch("PostToolUse", ["src/lines.ts", "src/cart.ts"]);
  yield* Effect.promise(() => sleep(3500));
  const codexView = yield* Effect.promise(() =>
    hubCall("/v1/workspaces/acme/coord", { session: hubSession }),
  );
  const codexSession = (
    codexView.sessions as ReadonlyArray<{ id: string; files?: ReadonlyArray<string> }>
  ).find((session) => session.id === "codex:lab-ana-codex");
  check(
    codexSession?.files?.includes("src/cart.ts") === true &&
      codexSession.files.includes("src/lines.ts"),
    "the team sees every file its patch changed",
  );
  const ownContext = NodePath.join(
    ana.home,
    "userdata",
    "coord",
    "contexts",
    "acme",
    "lab",
    "lab-ana-codex.md",
  );
  const ownPatch = codexs.permission("apply_patch", {
    command: `*** Begin Patch\n*** Update File: ${ownContext}\n@@\n-a\n+b\n*** End Patch`,
  });
  check(
    ownPatch?.hookSpecificOutput?.decision?.behavior === "allow",
    "Peer lets Codex write the agent's own working context without asking its person",
  );
  const asks = codexs.permission("Bash", { command: "rm -rf build" });
  check(
    asks === null &&
      events(ana).some(
        (entry) => entry.event === "session.blocked" && entry.session === "codex:lab-ana-codex",
      ),
    "anything else waits for its person, and the agent counts as waiting, not working",
  );
  codexs.hook("Stop", { stop_hook_active: false, last_assistant_message: "Done." });
  bobs.peer("note", "Fine by me: keep the VAT column out of totalPrice().");
  let codexWake: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 30 && codexWake === undefined; attempt += 1) {
    yield* Effect.promise(() => sleep(500));
    codexWake = events(ana).find(
      (entry) => entry.event === "wake" && entry.session === "codex:lab-ana-codex",
    );
  }
  check(
    codexWake?.via === "codex queue" && String(codexWake.text).includes("VAT column"),
    "an idle Codex agent is woken with the note through Codex itself",
  );
  const codexHeard = context(codexs.hook("UserPromptSubmit", { prompt: "go on" }));
  told(`${codexs.name} (next step)`, codexHeard);
  check(
    codexHeard?.includes("keep the VAT column out of totalPrice()") === true,
    "and when Codex does not take it, the agent hears the note at its next step",
  );
  codexs.hook("SessionEnd", { reason: "other" });
  yield* ana.client[WS_METHODS.peerHubSetCoordination]({ codexHooks: false });
  check(
    JSON.stringify(
      (JSON.parse(NodeFS.readFileSync(codexHooksFile, "utf8")) as CodexHooks).hooks,
    ) === JSON.stringify({ Stop: [{ hooks: [theirs] }] }) &&
      !NodeFS.existsSync(NodePath.join(codexHome, "rules", "peer.rules")),
    "taking Peer's hooks out of Codex leaves its person's own",
  );

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
  // Peer's hooks, and the permission to read and edit the contexts Peer keeps, as Peer installs
  // them; and the shell commands agents read and edit with, so nobody waits for an approval.
  const given = withContextAccess(
    { hooks: claudeHookGroups(computer.scripts) },
    NodePath.join(computer.home, "userdata", "coord", "contexts"),
    true,
  ) as { permissions?: { allow?: string[] } };
  const shell = [
    "grep",
    "rg",
    "cat",
    "ls",
    "find",
    "head",
    "tail",
    "wc",
    "sed",
    "perl",
    "awk",
    "git diff",
    "git status",
    "git log",
  ];
  NodeFS.writeFileSync(
    settings,
    JSON.stringify(
      {
        ...given,
        permissions: {
          ...given.permissions,
          allow: [
            ...(given.permissions?.allow ?? []),
            ...shell.map((command) => `Bash(${command}:*)`),
          ],
        },
      },
      null,
      2,
    ),
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
    // move to "Yes" and confirm only once the cursor is there. herdr may call it idle before that
    // dialog shows, so it has started only once its prompt (with the permission mode) is on screen.
    for (let step = 0; step < 30; step += 1) {
      const status = herdrJson(h, "agent", "get", pane).result?.agent?.agent_status;
      const screen = herdrText(h, "pane", "read", pane, "--source", "visible");
      if (
        (status === "idle" || status === "done") &&
        screen.includes("accept edits on") &&
        !screen.includes("trust this folder")
      ) {
        herdrText(h, "agent", "rename", pane, name);
        say(`${name} started`, `${computer.name}'s Claude Code in herdr pane ${pane}`);
        return pane;
      }
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

/** A value as TOML writes it inline, for Codex's `-c key=value`. */
function tomlInline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlInline).join(", ")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)} = ${tomlInline(item)}`)
      .join(", ")}}`;
  }
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * How the lab runs this person's own Codex (their sign-in, their CODEX_HOME,
 * left as they are) as one of its computers' agents: with that computer's
 * Peer hooks, and without the person's own hooks, plugins and MCP servers.
 * Every setting is a `-c` for this run; nothing is written to their Codex.
 */
function codexLabArgs(computer: Computer): string[] {
  const codexHome = process.env.CODEX_HOME ?? NodePath.join(NodeOS.homedir(), ".codex");
  const read = (file: string) => {
    try {
      return NodeFS.readFileSync(NodePath.join(codexHome, file), "utf8");
    } catch {
      return "";
    }
  };
  // Their hooks.json hooks, each turned off by the key Codex keeps its trust under.
  const theirs: Record<string, { enabled: boolean }> = {};
  const hooksFile = NodePath.join(codexHome, "hooks.json");
  try {
    const declared = (JSON.parse(read("hooks.json") || "{}") as CodexHooksFile).hooks ?? {};
    for (const [event, groups] of Object.entries(declared)) {
      const label = event.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      for (const [g, group] of groups.entries()) {
        for (const h of (group.hooks ?? []).keys()) {
          theirs[`${hooksFile}:${label}:${g}:${h}`] = { enabled: false };
        }
      }
    }
  } catch {
    // No hooks of theirs to turn off.
  }
  const servers = [
    ...read("config.toml").matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm),
  ].map((match) => match[1] ?? match[2] ?? "");
  const checkout = computer.checkout;
  return [
    "-c",
    `hooks=${tomlInline({ state: theirs, ...codexHookGroups(computer.scripts) })}`,
    // The lab vets its own hooks; Codex would otherwise wait for its person to trust them.
    "--dangerously-bypass-hook-trust",
    "-c",
    "features.plugins=false",
    ...(servers.length === 0
      ? []
      : [
          "-c",
          `mcp_servers=${tomlInline(Object.fromEntries(servers.map((name) => [name, { enabled: false }])))}`,
        ]),
    "-c",
    `projects=${tomlInline({
      [checkout]: { trust_level: "trusted" },
      [NodeFS.realpathSync(checkout)]: { trust_level: "trusted" },
    })}`,
    "-c",
    "check_for_update_on_startup=false",
    "-c",
    "notify=[]",
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
    // Their model, at an effort that keeps a lab step short.
    "-c",
    'model_reasoning_effort="medium"',
  ];
}
type CodexHooksFile = {
  readonly hooks?: Record<string, ReadonlyArray<{ readonly hooks?: ReadonlyArray<unknown> }>>;
};

/** This person's own Codex as a computer's agent, in a herdr pane of that computer. */
async function startCodex(h: HerdrServer, computer: Computer, name: string) {
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
  // Its settings would be too long a line for the pane's shell to take: a launcher holds them.
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const launcher = NodePath.join(computer.home, "codex-lab.sh");
  NodeFS.writeFileSync(
    launcher,
    `#!/bin/sh\nexec codex ${codexLabArgs(computer).map(quote).join(" ")} "$@"\n`,
    { mode: 0o755 },
  );
  for (let launch = 0; launch < 3; launch += 1) {
    herdrText(h, "pane", "run", pane, launcher);
    for (let step = 0; step < 40; step += 1) {
      const agentState = herdrJson(h, "agent", "get", pane).result?.agent;
      const screen = herdrText(h, "pane", "read", pane, "--source", "visible");
      const asking = /trust the (files|contents)|Hooks need review|Update available|Sign in/i.test(
        screen,
      );
      if (
        agentState?.agent === "codex" &&
        (agentState.agent_status === "idle" || agentState.agent_status === "done") &&
        screen.includes("Ask Codex") &&
        !asking
      ) {
        herdrText(h, "agent", "rename", pane, name);
        say(`${name} started`, `${computer.name}'s Codex in herdr pane ${pane}`);
        return pane;
      }
      if (asking && step > 10) {
        console.log(screen);
        throw new Error(`${name}'s Codex waits on a question the lab does not answer`);
      }
      await sleep(1500);
    }
  }
  throw new Error(`${name}'s Codex did not start`);
}

const statusOf = (h: HerdrServer, pane: string) =>
  (herdrJson(h, "agent", "get", pane).result?.agent?.agent_status as string | undefined) ?? "?";

/** What real agents did that Peer cannot make them do: reported, never failed on. */
function observe(ok: unknown, what: string) {
  say(ok ? "seen" : "NOT seen", what);
}

/** The coordination events of a computer, in order. */
function events(computer: Computer): Array<{ event: string; t: string; [field: string]: unknown }> {
  if (!NodeFS.existsSync(computer.log)) return [];
  return NodeFS.readFileSync(computer.log, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { event: string; t: string; [field: string]: unknown });
}

/** The Claude Code sessions a computer's Peer met. */
const sessionsOf = (computer: Computer) =>
  new Set(
    events(computer)
      .filter((entry) => entry.event === "session.started")
      .map((entry) => String(entry.session)),
  );

const realProgram = Effect.gen(function* () {
  yield* Effect.promise(() =>
    waitFor("the hub", async () => (await fetch(`${hubUrl}/health`)).ok, hub.output),
  );
  yield* Effect.promise(setUpWorkspace);
  const anaHerdr = startHerdr("Ana");
  const bobHerdr = startHerdr("Bob");
  const ana = yield* startComputer("Ana", "ana@acme.test", anaHerdr.socket);
  const bob = yield* startComputer("Bob", "bob@acme.test", bobHerdr.socket);
  // Both work on KRK-1: their branch names it.
  for (const computer of [ana, bob]) {
    git(computer.checkout, "checkout", "--quiet", "-b", "krk-1-pricing");
  }
  yield* Effect.promise(() => sleep(3000));
  // Ana's and Bob's agents: Claude Code and Codex unless REAL_KINDS says otherwise ("claude,claude").
  const [anaKind, bobKind] = (process.env.REAL_KINDS ?? "claude,codex").split(",");
  const start = (kind: string | undefined, h: HerdrServer, computer: Computer, name: string) =>
    kind === "codex" ? startCodex(h, computer, name) : startClaude(h, computer, name);
  const anaPane = yield* Effect.promise(() => start(anaKind, anaHerdr, ana, "ana"));
  const bobPane = yield* Effect.promise(() => start(bobKind, bobHerdr, bob, "bob"));
  const agents = [
    { computer: ana, h: anaHerdr, pane: anaPane },
    { computer: bob, h: bobHerdr, pane: bobPane },
  ];
  // What the agents did, printed however the run ends.
  const report = () => {
    for (const { computer, h, pane } of agents) {
      console.log(`\n===== ${computer.name}'s agent, last screen =====`);
      console.log(
        herdrText(h, "pane", "read", pane, "--source", "recent-unwrapped", "--lines", "160"),
      );
      console.log(`===== ${computer.name}'s checkout: git diff =====`);
      console.log(git(computer.checkout, "diff"));
      console.log(`===== ${computer.name}'s coordination log =====`);
      for (const entry of events(computer)) {
        if (
          /^(shared|context|finding|files|session)\.|^(decision|note\.agent|resolve\.agent|news|wake|overlap\.opened|cli)$/.test(
            entry.event,
          )
        ) {
          console.log(JSON.stringify(entry).slice(0, 900));
        }
      }
    }
    herdrText(anaHerdr, "server", "stop");
    herdrText(bobHerdr, "server", "stop");
  };
  try {
    const contextPath = "/v1/workspaces/acme/contexts/lab/task:krk-1";
    const readContext = () =>
      hubCall(contextPath, { session: hubSession }).catch(() => null) as Promise<Record<
        string,
        any
      > | null>;
    // The lab's checkouts are throwaway: a permission an agent still asks for is granted, as a
    // person at the keyboard would, so no run stalls on a dialog nobody answers.
    const approve = () => {
      for (const { computer, h, pane } of agents) {
        if (statusOf(h, pane) !== "blocked") continue;
        const screen = herdrText(h, "pane", "read", pane, "--source", "visible");
        if (/Do you want to proceed\?|❯\s*1\. Yes/.test(screen)) {
          herdrText(h, "pane", "send-keys", pane, "enter");
          say("approved", `${computer.name}'s agent's permission prompt`);
        }
      }
    };
    const untilQuiet = async (limitMs: number) => {
      let quiet = 0;
      for (let elapsed = 0; elapsed < limitMs && quiet < 40_000; elapsed += 5000) {
        await sleep(5000);
        approve();
        const statuses = agents.map(({ h, pane }) => statusOf(h, pane));
        quiet = statuses.every((s) => s === "idle" || s === "done") ? quiet + 5000 : 0;
        say("agents", `Ana's ${statuses[0]}, Bob's ${statuses[1]}`);
      }
    };

    // A. Two agents on one task, changing the same files.
    const anaTask =
      "In src/pricing.ts give price() a VAT rate: price(items, vatRate = 0.2) returns the total with VAT added. Check how the result is used and formatted elsewhere so it stays right. Keep the change small; do not run tests or builds.";
    const bobTask =
      "Rename price() to totalPrice() in src/pricing.ts and update every caller. Keep the change small; do not run tests or builds.";
    herdrJson(anaHerdr, "agent", "prompt", anaPane, anaTask);
    say("Ana's agent prompted", anaTask);
    for (let waited = 0; waited < 120_000; waited += 2000) {
      yield* Effect.promise(() => sleep(2000));
      approve();
      if (events(ana).some((e) => e.event === "hook" && e.hookEvent === "PostToolUse")) break;
    }
    herdrJson(bobHerdr, "agent", "prompt", bobPane, bobTask);
    say("Bob's agent prompted", bobTask);
    yield* Effect.promise(() => untilQuiet(10 * 60_000));

    const afterA = yield* Effect.promise(readContext);
    told(
      "KRK-1's shared context after A",
      afterA === null ? null : JSON.stringify(afterA, null, 2),
    );
    check(
      afterA !== null && afterA.keeper !== undefined,
      "one agent session keeps KRK-1's context",
    );
    observe(Number(afterA.version) >= 1, "the agent keeping it wrote it");
    const keeperAt = agents.find(({ computer }) => sessionsOf(computer).has(afterA.keeper.session));
    const otherAt = agents.find((agent) => agent !== keeperAt);
    check(keeperAt !== undefined && otherAt !== undefined, "the keeper is one of the two agents");
    observe(
      events(otherAt.computer).some((e) => /^shared\.(read|told|lost)$/.test(e.event)),
      `${otherAt.computer.name}'s agent reads it (it was given it, or kept it before)`,
    );
    observe(
      [...events(ana), ...events(bob)].some((e) => e.event === "shared.handed"),
      "the keeper changed hands during A, while one agent idled",
    );
    const shellEdits = agents.flatMap(({ computer }) =>
      events(computer)
        .filter((e) => e.event === "files.shell")
        .flatMap((e) => (e.files as ReadonlyArray<string>).map((file) => ({ computer, file }))),
    );
    observe(shellEdits.length > 0, "an agent edited through the shell and Peer saw which files");
    check(
      shellEdits.every(({ computer, file }) =>
        NodeFS.existsSync(NodePath.join(computer.checkout, file)),
      ),
      "the files Peer saw changed through the shell are paths in the repository",
    );
    observe(
      events(otherAt.computer).some((e) => e.event === "shared.denied"),
      `${otherAt.computer.name}'s agent tried to edit it and was told it only reads it`,
    );
    observe(
      [...events(ana), ...events(bob)].some((e) => e.event === "finding.delivered"),
      "a finding reached another agent",
    );

    // B. The keeper idles, the other agent works: it takes the context over. The other agent is
    // prompted once the hub has seen the keeper idle past the threshold: its turn may be short.
    for (let waited = 0; waited < 3 * 60_000; waited += 3000) {
      const coord = yield* Effect.promise(() =>
        hubCall("/v1/workspaces/acme/coord", { session: hubSession }),
      );
      const keeperNow = (
        coord.sessions as ReadonlyArray<{
          id: string;
          status: string;
          activeAt?: string;
          seenAt: string;
        }>
      ).find((s) => s.id === afterA.keeper.session);
      const idleMs =
        keeperNow === undefined || keeperNow.status === "working"
          ? 0
          : Date.now() - Date.parse(keeperNow.activeAt ?? keeperNow.seenAt);
      if (idleMs > (REAL_IDLE_SECS + 5) * 1000) break;
      yield* Effect.promise(() => sleep(3000));
      approve();
    }
    const follow =
      "Add a one-line comment above the pricing function saying what it returns and in which unit. Keep it small; do not run tests or builds.";
    herdrJson(otherAt.h, "agent", "prompt", otherAt.pane, follow);
    say(`${otherAt.computer.name}'s agent prompted`, follow);
    let keeperB: string | undefined;
    for (let waited = 0; waited < 4 * 60_000; waited += 3000) {
      yield* Effect.promise(() => sleep(3000));
      approve();
      keeperB = (yield* Effect.promise(readContext))?.keeper?.session;
      if (keeperB !== afterA.keeper.session) break;
    }
    check(
      keeperB !== undefined && sessionsOf(otherAt.computer).has(keeperB),
      `a keeper idle over ${REAL_IDLE_SECS} s gives way to the agent that works`,
    );
    observe(
      events(otherAt.computer).some((e) => e.event === "shared.handed"),
      `${otherAt.computer.name}'s agent is told it keeps the context now`,
    );
    yield* Effect.promise(() => untilQuiet(4 * 60_000));

    // C. What the agents marked for the project, kept in the project's knowledge.
    const view = yield* Effect.promise(() =>
      hubCall("/v1/workspaces/acme/coord", { session: hubSession }),
    );
    const findings = view.findings as ReadonlyArray<{
      text: string;
      scope?: string;
      email: string;
    }>;
    told(
      "findings on the hub",
      findings.map((f) => `${f.scope ?? "task"} · ${f.email}: ${f.text}`).join("\n"),
    );
    observe(
      findings.some((f) => f.scope === "project"),
      "a real agent marked a line [project]",
    );
    if (!kontext) {
      say("skipped", "kontext is not installed: the knowledge steps need it");
    } else {
      let candidates = yield* ana.client[WS_METHODS.peerHubKnowledgeCandidates]({
        workspace: "acme",
        project: "lab",
      });
      if (candidates.length === 0) {
        const harvested = yield* ana.client[WS_METHODS.peerHubHarvestContext]({
          workspace: "acme",
          project: "lab",
          scope: "task:krk-1",
        });
        say("harvest", `kontext read KRK-1's context: ${harvested.proposed} proposals`);
        candidates = yield* ana.client[WS_METHODS.peerHubKnowledgeCandidates]({
          workspace: "acme",
          project: "lab",
        });
      }
      told("knowledge candidates", JSON.stringify(candidates, null, 2));
      check(
        candidates.length > 0,
        "there is something to keep, marked by an agent or read from the context",
      );
      const first = candidates[0];
      if (first !== undefined) {
        const kept = yield* ana.client[WS_METHODS.peerHubKeepCandidate]({
          workspace: "acme",
          project: "lab",
          id: first.id,
        });
        const entry = NodeFS.readFileSync(NodePath.join(ana.checkout, kept.keptAs.path), "utf8");
        told(`kept as ${kept.keptAs.path}`, entry);
        check(
          git(ana.checkout, "diff", "--cached", "--name-only").includes(kept.keptAs.path),
          "Keep wrote it into the project's knowledge, staged",
        );
        if (kept.asWritten !== null) say("as written", kept.asWritten);
        check(
          kept.asWritten?.startsWith("kontext's model did not run") !== true,
          "kontext's llm adapter ran on the person's own Claude Code",
        );
        observe(kept.asWritten === null, "kontext's llm adapter worded it");
      }
    }

    // D. The keeper's session ends: the other agent keeps the context.
    const keeperD = agents.find(
      ({ computer }) => keeperB !== undefined && sessionsOf(computer).has(keeperB),
    );
    const remaining = agents.find((agent) => agent !== keeperD);
    if (keeperD !== undefined && remaining !== undefined) {
      herdrJson(keeperD.h, "agent", "prompt", keeperD.pane, "/exit");
      say(`${keeperD.computer.name}'s agent exits`);
      let keeperAfter: string | undefined;
      for (let waited = 0; waited < 90_000; waited += 3000) {
        yield* Effect.promise(() => sleep(3000));
        keeperAfter = (yield* Effect.promise(readContext))?.keeper?.session;
        if (keeperAfter !== keeperB) break;
      }
      check(
        keeperAfter !== undefined && sessionsOf(remaining.computer).has(keeperAfter),
        "when the keeper's session ends, the other agent keeps the context",
      );
    }

    const final = yield* Effect.promise(readContext);
    told("KRK-1's shared context at the end", final === null ? null : String(final.text));
  } finally {
    report();
  }
}).pipe(Effect.scoped);

try {
  await Effect.runPromise(process.env.REAL_AGENTS === "1" ? realProgram : program);
  say("PASS");
  process.exitCode = 0;
} catch (error) {
  say("FAIL", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  // The computers first: as their Peers stop, their brokers hand back the contexts their agents
  // kept, which needs the hub still up. Then the hub.
  const running = (child: NodeChildProcess.ChildProcess) =>
    child.exitCode === null && child.signalCode === null;
  const peers = children.filter((child) => child !== hub.child && running(child));
  const stopped = peers.map(
    (child) => new Promise<void>((resolve) => child.once("exit", () => resolve())),
  );
  for (const child of peers) child.kill("SIGTERM");
  await Promise.race([Promise.all(stopped), sleep(5000)]);
  if (running(hub.child)) hub.child.kill("SIGTERM");
  await sleep(500);
  if (process.env.KEEP_LAB === "1") say("kept", lab);
  else NodeFS.rmSync(lab, { recursive: true, force: true });
}
