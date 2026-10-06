// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off - broker fixtures in a temporary checkout, and a stand-in hub on a local port.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { CoordinationBroker, type BrokerDeps } from "./coordinationBroker.ts";
import { runModel } from "./findModel.ts";
import type {
  HubCoordSession,
  HubCoordView,
  HubIntentAnswer,
  HubIntentRequest,
  HubOverlap,
} from "./hubApi.ts";

vi.mock("./findModel.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./findModel.ts")>()),
  runModel: vi.fn(),
}));
vi.mock("./hubPolicy.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hubPolicy.ts")>()),
  projectAcceptsPersonal: () => true,
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

async function brokerFixture(overrides?: (deps: BrokerDeps) => Partial<BrokerDeps>) {
  vi.stubEnv("PEER_RELATED_MODEL", "on");
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-find-test-"));
  await NodeFSP.mkdir(NodePath.join(root, ".ai", "decisions"), { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(root, ".ai", "decisions", "prices.md"),
    "---\nid: prices\ntitle: Keep prices in cents\n---\nPrices are integers.\n",
  );
  const view = { sessions: [], overlaps: [], at: new Date().toISOString() };
  const unavailable = async (): Promise<never> => {
    throw new Error("not used by find");
  };
  const deps: BrokerDeps = {
    socketPath: NodePath.join(root, "peer.sock"),
    scriptsDir: NodePath.join(root, "scripts"),
    logPath: NodePath.join(root, "broker.jsonl"),
    contextsDir: NodePath.join(root, "contexts"),
    environment: "test",
    placeOf: async () => ({ workspace: "acme", project: "app", root }),
    branchOf: async () => "feature/prices",
    herdrTitle: () => undefined,
    herdrPane: () => undefined,
    queueCodex: async () => false,
    nameOf: () => "Ana",
    email: () => "ana@acme.test",
    policy: () => "notify",
    report: async () => view,
    view: async () => view,
    note: unavailable,
    resolve: unavailable,
    workspaces: () => ["acme"],
    notify: () => undefined,
    changed: () => undefined,
    taskOf: () => undefined,
    threadOf: async () => undefined,
    tasks: () => [],
    taskName: (_workspace, _project, task) => task,
    readContext: async () => null,
    keepContext: unavailable,
    writeContext: unavailable,
    projectGuidance: async () => null,
    taskDone: () => false,
    gitStatus: async () => "",
    contextVersions: async () => [],
    readContextVersion: async () => null,
  };
  const broker = new CoordinationBroker({ ...deps, ...overrides?.(deps) });
  const register = async (id: string) => {
    await broker["sessionFor"]("claude", { session_id: id, cwd: root }, undefined);
  };
  const find = (id: string) =>
    broker["runCli"]("find", ["format prices"], { "x-peer-session": `claude:${id}` });
  const dispose = async () => {
    await broker.stop();
    await NodeFSP.rm(root, { recursive: true, force: true });
  };
  return { register, find, dispose, broker, root };
}

describe("peer find reservations", () => {
  it("counts Mod delivery only after exact evidence and rejects receipts from a ended generation", async () => {
    const fixture = await brokerFixture();
    const post = (path: string, body: Record<string, unknown>, mod = true) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            socketPath: NodePath.join(fixture.root, "peer.sock"),
            path,
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(mod ? { "x-peer-adapter": "mod" } : {}),
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("error", reject);
            response.on("end", () => resolve({ status: response.statusCode!, text }));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    try {
      await fixture.register("one");
      await fixture.broker.start();
      const original = fixture.broker["answerHook"];
      fixture.broker["answerHook"] = async () => ({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Exact versioned source",
        },
      });
      const prepared = await post("/hook", {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "UserPromptSubmit",
      });
      const delivery = (JSON.parse(prepared.text) as { peerDelivery: { id: string } }).peerDelivery;
      const session = fixture.broker["sessions"].get("claude:one")!;
      expect(session.injected.size).toBe(0);
      expect(
        (await post("/delivery", { session_id: "one", id: delivery.id, evidence: "sent" })).status,
      ).toBe(400);
      expect(
        (await post("/delivery", { session_id: "one", id: "wrong", evidence: "model-input" }))
          .status,
      ).toBe(400);
      expect(
        (
          await post(
            "/delivery",
            { session_id: "one", id: delivery.id, evidence: "model-input" },
            false,
          )
        ).status,
      ).toBe(400);
      expect(
        (await post("/delivery", { session_id: "one", id: delivery.id, evidence: "model-input" }))
          .status,
      ).toBe(204);
      expect(
        (await post("/delivery", { session_id: "one", id: delivery.id, evidence: "model-input" }))
          .status,
      ).toBe(204);
      expect(session.injected.get("UserPromptSubmit")).toBe("Exact versioned source".length);
      fixture.broker["answerHook"] = original;
      await post("/hook", { session_id: "one", cwd: fixture.root, hook_event_name: "SessionEnd" });
      await fixture.register("one");
      await post("/hook", {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "Notification",
      });
      expect(
        (await post("/delivery", { session_id: "one", id: delivery.id, evidence: "model-input" }))
          .status,
      ).toBe(400);
      await fixture.broker["logQueue"];
      const logs = (await NodeFSP.readFile(NodePath.join(fixture.root, "broker.jsonl"), "utf8"))
        .split("\n")
        .filter((line) => line.includes('"event":"delivery.verified"'));
      expect(logs).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("rotates a resumed session without SessionEnd while compact and the settings copy preserve its generation", async () => {
    const fixture = await brokerFixture();
    const post = (path: string, body: Record<string, unknown>, mod = true) =>
      new Promise<{ status: number; text: string }>((resolve, reject) => {
        const request = NodeHttp.request(
          {
            socketPath: NodePath.join(fixture.root, "peer.sock"),
            path,
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(mod ? { "x-peer-adapter": "mod" } : {}),
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("error", reject);
            response.on("end", () => resolve({ status: response.statusCode!, text }));
          },
        );
        request.on("error", reject);
        request.end(JSON.stringify(body));
      });
    const start = Promise.withResolvers<string>();
    const starting = Promise.withResolvers<void>();
    try {
      await fixture.register("one");
      await fixture.broker.start();
      const session = fixture.broker["sessions"].get("claude:one")!;
      session.task = "prices";
      session.claims = ["area:pricing"];
      session.read.set("task:other", { version: 4, text: "An interface", toldAt: Date.now() });
      const original = fixture.broker["answerHook"];
      fixture.broker["answerHook"] = async () => ({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Old runtime context",
        },
      });
      const prepared = await post("/hook", {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "UserPromptSubmit",
      });
      const oldDelivery = (JSON.parse(prepared.text) as { peerDelivery: { id: string } })
        .peerDelivery.id;
      fixture.broker["answerHook"] = original;
      fixture.broker["startContextFor"] = async () => {
        starting.resolve();
        return start.promise;
      };
      session.modHandled.set("obsolete", Date.now());
      const previous = session.runtimeGeneration;
      const body = {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "SessionStart",
        source: "resume",
      };
      const resumed = post("/hook", body);
      await starting.promise;
      expect(session.runtimeGeneration).not.toBe(previous);
      const generation = session.runtimeGeneration;
      expect(session.modHandled.has("obsolete")).toBe(false);
      expect(session.read.get("task:other")?.version).toBe(4);
      expect(session.task).toBe("prices");
      expect(session.claims).toEqual(["area:pricing"]);
      expect(fixture.broker.coordinationLevel("claude:one")).toBe("A");
      expect(
        (await post("/delivery", { session_id: "one", id: oldDelivery, evidence: "model-input" }))
          .status,
      ).toBe(400);
      expect((await post("/hook", body, false)).status).toBe(204);
      expect(session.runtimeGeneration).toBe(generation);
      start.resolve("Resumed runtime context");
      const resumedDelivery = (JSON.parse((await resumed).text) as { peerDelivery: { id: string } })
        .peerDelivery.id;
      fixture.broker["startContextFor"] = async () => "Compacted context";
      await post("/hook", { ...body, source: "compact" });
      expect(session.runtimeGeneration).toBe(generation);
      expect(fixture.broker.coordinationLevel("claude:one")).toBe("A");
      expect(
        (
          await post("/delivery", {
            session_id: "one",
            id: resumedDelivery,
            evidence: "model-input",
          })
        ).status,
      ).toBe(204);
      await post("/hook", { ...body, source: "startup" }, false);
      expect(session.runtimeGeneration).not.toBe(generation);
      expect(session.deliveries.size).toBe(0);
      expect(fixture.broker.coordinationLevel("claude:one")).toBe("B");
    } finally {
      start.resolve("Resumed runtime context");
      await fixture.dispose();
    }
  });

  it("does not prepare an old in-flight Mod reply after its runtime was resumed", async () => {
    const fixture = await brokerFixture();
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Record<string, unknown> | null>();
    try {
      await fixture.register("one");
      const original = fixture.broker["answerHook"];
      fixture.broker["startContextFor"] = async () => "New runtime context";
      fixture.broker["answerHook"] = async (event, session, body, adapter) => {
        if (event === "UserPromptSubmit") {
          entered.resolve();
          return reply.promise;
        }
        return original.call(fixture.broker, event, session, body, adapter);
      };
      const body = { session_id: "one", cwd: fixture.root, hook_event_name: "UserPromptSubmit" };
      const pending = fixture.broker["hook"](body, { "x-peer-adapter": "mod" });
      await entered.promise;
      await fixture.broker["hook"](
        { ...body, hook_event_name: "SessionStart", source: "resume" },
        { "x-peer-adapter": "mod" },
      );
      reply.resolve({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Old reply" },
      });
      expect(await pending).toBeNull();
      const session = fixture.broker["sessions"].get("claude:one")!;
      expect([...session.deliveries.values()].map((delivery) => delivery.text)).toEqual([
        "New runtime context",
      ]);
    } finally {
      reply.resolve(null);
      await fixture.dispose();
    }
  });

  it.each([
    { tool_name: "Edit", tool_input: { file_path: "src/pricing.ts" } },
    { tool_name: "Bash", tool_input: { command: "git push" } },
  ])("blocks an in-flight $tool_name action from a replaced runtime", async (tool) => {
    const fixture = await brokerFixture();
    const entered = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<Record<string, unknown> | null>();
    try {
      await fixture.register("one");
      const original = fixture.broker["answerHook"];
      fixture.broker["startContextFor"] = async () => "New runtime context";
      fixture.broker["answerHook"] = async (event, session, body, adapter) => {
        if (event === "PreToolUse") {
          entered.resolve();
          return reply.promise;
        }
        return original.call(fixture.broker, event, session, body, adapter);
      };
      const body = { session_id: "one", cwd: fixture.root, hook_event_name: "PreToolUse", ...tool };
      const pending = fixture.broker["hook"](body, { "x-peer-adapter": "mod" });
      await entered.promise;
      await fixture.broker["hook"](
        { session_id: "one", cwd: fixture.root, hook_event_name: "SessionStart", source: "resume" },
        { "x-peer-adapter": "mod" },
      );
      reply.resolve({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      });
      expect(await pending).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    } finally {
      reply.resolve(null);
      await fixture.dispose();
    }
  });

  it("applies each policy at the broker deadline and always blocks unverified publication", async () => {
    const fixture = await brokerFixture(() => ({ policy: () => "notify" }));
    try {
      await fixture.register("one");
      fixture.broker["answerHook"] = () => new Promise(() => {});
      vi.useFakeTimers();
      const body = {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "PreToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "price.ts" },
      };
      for (const policy of ["notify", "ask", "coordinate", "exclusive"] as const) {
        fixture.broker["views"].set("acme", {
          sessions: [],
          overlaps: [],
          at: new Date().toISOString(),
          policies: { app: policy },
        });
        const pending = fixture.broker["hookInTime"](body, {});
        await vi.advanceTimersByTimeAsync(4000);
        const result = await pending;
        if (policy === "notify") expect(result).toBeNull();
        else
          expect(result?.hookSpecificOutput).toMatchObject({
            permissionDecision: policy === "ask" ? "ask" : "deny",
          });
      }
      const publish = fixture.broker["hookInTime"](
        { ...body, tool_name: "Bash", tool_input: { command: "git push origin HEAD" } },
        {},
      );
      await vi.advanceTimersByTimeAsync(4000);
      expect((await publish)?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
      const read = fixture.broker["hookInTime"](
        { ...body, tool_name: "Bash", tool_input: { command: "git status" } },
        {},
      );
      await vi.advanceTimersByTimeAsync(4000);
      expect(await read).toBeNull();
    } finally {
      vi.useRealTimers();
      await fixture.dispose();
    }
  });

  it("explicit context retrieves team findings even before a shared overview exists", async () => {
    const fixture = await brokerFixture();
    try {
      await fixture.register("one");
      fixture.broker["views"].set("acme", {
        sessions: [],
        overlaps: [],
        at: new Date().toISOString(),
        findings: [
          {
            id: "finding-one",
            project: "app",
            text: "Failed UTC hypothesis at commit abc with test tz",
            email: "vir@acme.test",
            session: "claude:other",
            environment: "other",
            at: new Date().toISOString(),
          },
        ],
      });
      fixture.broker["syncNow"] = async () => {};
      const result = await fixture.broker["runCli"]("context", [], {
        "x-peer-session": "claude:one",
      });
      expect(result).toContain("<team-findings>");
      expect(result).toContain("Failed UTC hypothesis");
      expect(result).toContain("finding-one");
    } finally {
      await fixture.dispose();
    }
  });

  it("suppresses only the matching settings hook after a Mod handled the event", async () => {
    const fixture = await brokerFixture();
    try {
      await fixture.register("one");
      const body = {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "Notification",
        message: "permission needed",
      };
      expect(fixture.broker.coordinationLevel("claude:one")).toBe("B");
      const mod = await fixture.broker["hook"](body, { "x-peer-adapter": "mod" });
      expect(mod?.peerStatus).toBeDefined();
      expect(fixture.broker.coordinationLevel("claude:one")).toBe("A");
      expect(await fixture.broker["hook"](body, {})).toBeNull();
      await fixture.broker["hook"]({ ...body, message: "another approval" }, {});
      await fixture.broker["logQueue"];
      const log = await NodeFSP.readFile(NodePath.join(fixture.root, "broker.jsonl"), "utf8");
      expect(log.split("\n").filter((line) => line.includes('"event":"hook"'))).toHaveLength(2);
    } finally {
      await fixture.dispose();
    }
  });

  it("blocks handoff on stale reads and when freshness cannot be verified", async () => {
    const stale = { current: true };
    const fixture = await brokerFixture(() => ({
      staleReads: async () => {
        if (!stale.current) throw new Error("offline");
        return {
          fresh: false,
          stale: [
            {
              project: "app",
              scope: "task:prices",
              readVersion: 1,
              currentVersion: 2,
              at: "2026-10-06",
              updatedAt: "2026-10-06",
            },
          ],
        };
      },
    }));
    try {
      await fixture.register("one");
      const body = {
        session_id: "one",
        cwd: fixture.root,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "git push origin HEAD" },
      };
      const blocked = await fixture.broker["hook"](body, {});
      expect(blocked?.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
      expect(JSON.stringify(blocked)).toContain("prices");
      stale.current = false;
      expect((await fixture.broker["hook"](body, {}))?.hookSpecificOutput).toMatchObject({
        permissionDecision: "deny",
      });
      expect(
        await fixture.broker["hook"](
          { ...body, tool_input: { command: 'echo "git push origin HEAD"' } },
          {},
        ),
      ).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses a concurrent second request from the same agent after synchronization", async () => {
    const fixture = await brokerFixture();
    vi.mocked(runModel).mockResolvedValue('{"related":[]}');
    try {
      await fixture.register("one");
      const answers = await Promise.all([fixture.find("one"), fixture.find("one")]);
      expect(runModel).toHaveBeenCalledTimes(1);
      expect(answers.filter((answer) => answer.includes("wait"))).toHaveLength(1);
    } finally {
      await fixture.dispose();
    }
  });

  it("runs at most two models when three agents request a find together", async () => {
    const fixture = await brokerFixture();
    const model = Promise.withResolvers<string>();
    const thirdModel = Promise.withResolvers<string>();
    vi.mocked(runModel).mockImplementation(() => {
      if (vi.mocked(runModel).mock.calls.length === 3) thirdModel.resolve("third model started");
      return model.promise;
    });
    let requests: Promise<string>[] = [];
    try {
      await fixture.register("one");
      await fixture.register("two");
      await fixture.register("three");
      requests = [fixture.find("one"), fixture.find("two"), fixture.find("three")];
      const refused = await Promise.race([requests[2]!, thirdModel.promise]);
      expect(refused).toContain("other agents");
      expect(runModel).toHaveBeenCalledTimes(2);
    } finally {
      model.resolve('{"related":[]}');
      await Promise.allSettled(requests);
      await fixture.dispose();
    }
  });
});

describe("Peer memory runtime integration", () => {
  it("keeps a keeper's current file private across handoff and shares only its separate overview", async () => {
    const uploaded: string[] = [];
    const ended: string[] = [];
    const checkpoints: string[] = [];
    const searches: Array<ReadonlyArray<string>> = [];
    const fixture = await brokerFixture((deps) => ({
      memory: {
        prepare: async (session) => {
          const currentPath = NodePath.join(
            NodePath.dirname(deps.contextsDir),
            "memory-private",
            session.runtimeGeneration,
            "current.md",
          );
          await NodeFSP.mkdir(NodePath.dirname(currentPath), { recursive: true, mode: 0o700 });
          await NodeFSP.writeFile(currentPath, "Private initial notes", {
            flag: "wx",
            mode: 0o600,
          }).catch((cause: unknown) => {
            if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST"))
              throw cause;
          });
          return { mode: "memory", currentPath, notice: `Private current: ${currentPath}` };
        },
        notice: async () => "",
        cli: async (_session, _command, args) => {
          searches.push(args);
          return "stored";
        },
        checkpoint: async (session) => {
          checkpoints.push(session.runtimeGeneration);
        },
        end: async (session) => {
          ended.push(session.runtimeGeneration);
        },
        legacySnapshot: async () => undefined,
      },
      keepContext: async (_workspace, project, scope, session) => ({
        project,
        scope,
        version: 1,
        text: "Shared overview only",
        updatedAt: new Date().toISOString(),
        keeper: {
          session,
          email: "ana@acme.test",
          environment: "test",
          since: new Date().toISOString(),
        },
      }),
      writeContext: async (_workspace, project, scope, _session, baseVersion, text) => {
        uploaded.push(text);
        return {
          project,
          scope,
          version: baseVersion + 1,
          text,
          updatedAt: new Date().toISOString(),
        };
      },
    }));
    try {
      const concurrent = await Promise.all([
        fixture.broker["sessionFor"](
          "claude",
          { session_id: "memory-one", cwd: fixture.root },
          undefined,
        ),
        fixture.broker["sessionFor"](
          "claude",
          { session_id: "memory-one", cwd: fixture.root },
          undefined,
        ),
      ]);
      const session = concurrent[0];
      expect(session).not.toBeNull();
      expect(concurrent[1]).toBe(session);
      if (session === null || session === undefined) return;
      const generation = session.runtimeGeneration;
      await fixture.broker["startedContext"](session, "startup");
      expect(session.keeps).toBe(true);
      expect(session.contextPath).toBe(session.ownContextPath);
      const mirror = fixture.broker["mirrorOf"](session)!;
      expect(session.contextPath).not.toBe(mirror.path);
      await NodeFSP.writeFile(
        session.ownContextPath,
        "Private analysis\n## For the team\nDo not auto-share private notes",
      );
      await fixture.broker["readTeamLines"](session);
      await fixture.broker["saveShared"](session);
      expect(uploaded).toEqual([]);
      expect(fixture.broker["reportFor"]("acme")[0]?.findings).toEqual([]);
      await NodeFSP.writeFile(mirror.path, "A deliberately edited shared overview");
      await fixture.broker["saveShared"](session);
      expect(uploaded).toEqual(["A deliberately edited shared overview"]);
      await fixture.broker["release"](session);
      await fixture.broker["takeUp"](session);
      expect(session.contextPath).toBe(session.ownContextPath);
      expect(await NodeFSP.readFile(session.ownContextPath, "utf8")).toContain("Private analysis");
      expect(
        (
          await fixture.broker["sessionFor"](
            "claude",
            { session_id: "memory-one", cwd: fixture.root },
            undefined,
          )
        )?.runtimeGeneration,
      ).toBe(generation);
      expect(fixture.broker["reportFor"]("acme")[0]?.runtimeGeneration).toBe(generation);
      await fixture.find("memory-one");
      expect(searches).toEqual([["search", "format prices"]]);
      expect(runModel).not.toHaveBeenCalled();
      await fixture.broker["answerHook"]("PreCompact", session, {});
      expect(checkpoints).toEqual([generation]);
      await fixture.broker["answerHook"]("SessionEnd", session, {});
      expect(ended).toEqual([generation]);
    } finally {
      await fixture.dispose();
    }
  });

  it("defaults to legacy when no memory service is configured", async () => {
    const fixture = await brokerFixture();
    try {
      const session = await fixture.broker["sessionFor"](
        "claude",
        { session_id: "legacy-one", cwd: fixture.root },
        undefined,
      );
      expect(session?.memoryMode).toBe("legacy");
      expect(session?.ownContextPath).toContain("/contexts/");
    } finally {
      await fixture.dispose();
    }
  });
});

describe("the hub decides an edit", () => {
  const at = "2026-10-06T10:00:00Z";
  const vir: HubCoordSession = {
    id: "claude:vir",
    project: "app",
    email: "vir@acme.test",
    environment: "vir-laptop",
    label: "Frontend implementation",
    agent: "claude",
    status: "working",
    files: [],
    claims: [],
    seenAt: at,
  };
  const overlapWith = (session: string, extra: Partial<HubOverlap> = {}): HubOverlap => ({
    id: "abc123def456",
    project: "app",
    sessions: [session, "claude:vir"],
    files: ["src/pay.ts"],
    state: "open",
    notes: [],
    openedAt: at,
    updatedAt: at,
    ...extra,
  });
  /** What the hub answers for one path: the verdict and the overlap it opened with Vir's agent. */
  const answerOf = (
    session: string,
    verdict: HubIntentAnswer["verdicts"][number]["verdict"],
    extra: Partial<HubIntentAnswer> = {},
  ): HubIntentAnswer => ({
    policy: "coordinate",
    policySource: "project",
    verdicts: [
      {
        path: "src/pay.ts",
        verdict,
        with: ["claude:vir"],
        overlaps: ["abc123def456"],
        ...(verdict === "held" ? { holder: "claude:vir" } : {}),
      },
    ],
    overlaps: [overlapWith(session)],
    at,
    ...extra,
  });
  const viewOf = (extra: Partial<HubCoordView> = {}): HubCoordView => ({
    sessions: [vir],
    overlaps: [],
    at,
    ...extra,
  });
  const people = (_workspace: string, email: string) => (email.startsWith("vir") ? "Vir" : "Ana");

  const editBody = (root: string, id: string, agent: "claude" | "codex", file = "src/pay.ts") => ({
    hook_event_name: "PreToolUse",
    session_id: id,
    cwd: root,
    ...(agent === "codex"
      ? {
          tool_name: "apply_patch",
          tool_input: {
            command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`,
          },
        }
      : {
          tool_name: "Edit",
          tool_input: { file_path: NodePath.join(root, file), old_string: "a", new_string: "b" },
        }),
  });
  type Fixture = Awaited<ReturnType<typeof brokerFixture>>;
  const edit = (
    fixture: Fixture,
    id: string,
    agent: "claude" | "codex" = "claude",
    file?: string,
  ) =>
    fixture.broker["hook"](
      editBody(fixture.root, id, agent, file),
      agent === "codex" ? { "x-peer-agent": "codex" } : {},
    );
  const after = (fixture: Fixture, id: string, file = "src/pay.ts") =>
    fixture.broker["hook"](
      { ...editBody(fixture.root, id, "claude", file), hook_event_name: "PostToolUse" },
      {},
    );
  const hookOutput = (out: Record<string, unknown> | null) =>
    (out?.hookSpecificOutput ?? {}) as {
      readonly permissionDecision?: string;
      readonly permissionDecisionReason?: string;
      readonly additionalContext?: string;
    };
  const events = async (fixture: Fixture) => {
    await fixture.broker["logQueue"];
    const text = await NodeFSP.readFile(NodePath.join(fixture.root, "broker.jsonl"), "utf8");
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; [field: string]: unknown });
  };
  /** Lets the promises already in flight finish (a macrotask passes). */
  const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("stops the second agent as the hub says, and takes what the hub recorded into the view at once", async () => {
    const asked: Array<{ readonly request: HubIntentRequest; readonly timeoutMs: number }> = [];
    const fixture = await brokerFixture(() => ({
      nameOf: people,
      report: async () => viewOf(),
      intent: async (_workspace, _project, request, timeoutMs) => {
        asked.push({ request, timeoutMs });
        return answerOf(request.session, "deny");
      },
    }));
    try {
      const out = hookOutput(await edit(fixture, "one"));
      expect(out.permissionDecision).toBe("deny");
      expect(out.permissionDecisionReason).toContain("Vir's agent");
      expect(out.permissionDecisionReason).toContain("[overlap abc123]");
      expect(out.permissionDecisionReason).toContain('peer note "<your plan for src/pay.ts>"');
      // The hub's own word counts, not this computer's default: it asked with the Settings policy.
      expect(asked).toHaveLength(1);
      expect(asked[0]?.request).toMatchObject({
        environment: "test",
        session: "claude:one",
        paths: ["src/pay.ts"],
        policy: "notify",
      });
      expect(asked[0]?.request.op).toEqual(expect.any(String));
      expect(asked[0]?.timeoutMs).toBeLessThanOrEqual(2000);
      expect(fixture.broker.snapshot().overlaps.map((overlap) => overlap.id)).toContain(
        "abc123def456",
      );
      const log = await events(fixture);
      expect(log.find((entry) => entry.event === "intent")).toMatchObject({
        policy: "coordinate",
        policySource: "project",
        verdicts: [{ path: "src/pay.ts", verdict: "deny", with: ["claude:vir"] }],
      });
      expect(log.find((entry) => entry.event === "decision")).toMatchObject({
        policy: "coordinate",
        decision: "deny",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("asks the hub for every edit, and lets an edit through that it cleared", async () => {
    let asked = 0;
    const fixture = await brokerFixture(() => ({
      report: async () => viewOf(),
      intent: async (_workspace, _project, request) => {
        asked += 1;
        return answerOf(request.session, "clear", {
          verdicts: [{ path: "src/pay.ts", verdict: "clear", with: [], overlaps: [] }],
          overlaps: [],
        });
      },
    }));
    try {
      expect(await edit(fixture, "one")).toBeNull();
      expect(await edit(fixture, "one")).toBeNull();
      expect(asked).toBe(2);
    } finally {
      await fixture.dispose();
    }
  });

  it("asks one hub call per fifty paths of a patch", async () => {
    const sizes: number[] = [];
    const fixture = await brokerFixture(() => ({
      report: async () => viewOf(),
      intent: async (_workspace, _project, request) => {
        sizes.push(request.paths.length);
        return answerOf(request.session, "clear", { verdicts: [], overlaps: [] });
      },
    }));
    try {
      const files = Array.from({ length: 120 }, (_, at) => `src/gen/file-${at}.ts`);
      const patch = files.flatMap((file) => [`*** Update File: ${file}`, "@@", "-a", "+b"]);
      await fixture.broker["hook"](
        {
          hook_event_name: "PreToolUse",
          session_id: "patch",
          cwd: fixture.root,
          tool_name: "apply_patch",
          tool_input: { command: ["*** Begin Patch", ...patch, "*** End Patch"].join("\n") },
        },
        { "x-peer-agent": "codex" },
      );
      expect(sizes.toSorted((a, b) => a - b)).toEqual([20, 50, 50]);
    } finally {
      await fixture.dispose();
    }
  });

  it("maps the verdicts to what Claude Code and Codex are told", async () => {
    const verdict = { current: "ask" as HubIntentAnswer["verdicts"][number]["verdict"] };
    const fixture = await brokerFixture(() => ({
      nameOf: people,
      report: async () => viewOf(),
      intent: async (_workspace, _project, request) => answerOf(request.session, verdict.current),
    }));
    try {
      // A question for the person: Claude Code's permission prompt; Codex's agent asks, and its next try passes.
      const claudeAsks = hookOutput(await edit(fixture, "claude-one", "claude"));
      expect(claudeAsks.permissionDecision).toBe("ask");
      expect(claudeAsks.permissionDecisionReason).toContain("Vir's agent");
      const codexAsks = hookOutput(await edit(fixture, "codex-one", "codex"));
      expect(codexAsks.permissionDecision).toBe("deny");
      expect(codexAsks.permissionDecisionReason).toContain("Ask your person in your reply");
      expect(await edit(fixture, "codex-one", "codex")).toBeNull();

      // A denial and a held file stop both.
      for (const kind of ["deny", "held"] as const) {
        verdict.current = kind;
        for (const agent of ["claude", "codex"] as const) {
          const out = hookOutput(await edit(fixture, `${agent}-${kind}`, agent));
          expect(out.permissionDecision).toBe("deny");
          expect(out.permissionDecisionReason).toContain(
            kind === "held" ? "holds src/pay.ts in this project" : "Peer coordinates the agents",
          );
        }
      }

      // A heads-up goes next to the result, once.
      verdict.current = "notify";
      const heads = hookOutput(await edit(fixture, "claude-notify", "claude"));
      expect(heads.permissionDecision).toBeUndefined();
      expect(heads.additionalContext).toContain("also about to change src/pay.ts");
      expect(await edit(fixture, "claude-notify", "claude")).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("goes by its own view for a hub without intent, and does not ask it again for ten minutes", async () => {
    let asked = 0;
    const fixture = await brokerFixture(() => ({
      nameOf: people,
      policy: () => "coordinate",
      report: async () => viewOf({ sessions: [{ ...vir, files: ["src/pay.ts"] }] }),
      intent: async () => {
        asked += 1;
        return { unsupported: true };
      },
    }));
    try {
      const first = hookOutput(await edit(fixture, "one"));
      expect(first.permissionDecision).toBe("deny");
      // Today's text and today's claim: it is the view that decided.
      expect(first.permissionDecisionReason).toContain("also changed src/pay.ts");
      expect(fixture.broker["sessions"].get("claude:one")?.claims).toContain("src/pay.ts");
      expect(
        hookOutput(await edit(fixture, "one", "claude", "src/other.ts")).permissionDecision,
      ).toBeUndefined();
      expect(asked).toBe(1);
      expect(
        (await events(fixture)).filter((entry) => entry.event === "intent.legacy"),
      ).toHaveLength(1);

      // Ten minutes on, it asks again: the hub may have been upgraded since.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 11 * 60_000);
        await edit(fixture, "one", "claude", "src/another.ts");
        expect(asked).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      await fixture.dispose();
    }
  });

  it("remembers a hub without intent for the project that found out, not for the workspace", async () => {
    const asked: string[] = [];
    const fixture = await brokerFixture(() => ({
      placeOf: async (cwd) => ({
        workspace: "acme",
        project: cwd.endsWith("/site") ? "site" : "app",
        root: cwd,
      }),
      report: async () => viewOf(),
      // A hub that has intent answers 404 for a project it does not know: that is no hub without it.
      intent: async (_workspace, project, request) => {
        asked.push(project);
        return project === "app"
          ? { unsupported: true }
          : answerOf(request.session, "clear", { verdicts: [], overlaps: [] });
      },
    }));
    try {
      const inProject = async (id: string, project: "app" | "site") => {
        const cwd = NodePath.join(fixture.root, project);
        await NodeFSP.mkdir(cwd, { recursive: true });
        return fixture.broker["hook"](
          {
            hook_event_name: "PreToolUse",
            session_id: id,
            cwd,
            tool_name: "Edit",
            tool_input: {
              file_path: NodePath.join(cwd, "src/a.ts"),
              old_string: "a",
              new_string: "b",
            },
          },
          {},
        );
      };
      await inProject("one", "app");
      await inProject("one", "app");
      await inProject("two", "site");
      await inProject("two", "site");
      expect(asked).toEqual(["app", "site", "site"]);
    } finally {
      await fixture.dispose();
    }
  });

  it("stops an edit under coordinate and exclusive when the hub fails, and lets notify through marked", async () => {
    const policies = { current: "coordinate" as "notify" | "coordinate" | "ask" };
    const hubPolicies = { current: undefined as Record<string, string> | undefined };
    const fixture = await brokerFixture(() => ({
      policy: () => policies.current,
      report: async () =>
        viewOf(hubPolicies.current === undefined ? {} : { policies: hubPolicies.current }),
      intent: async () => {
        throw new Error("connection refused");
      },
    }));
    try {
      const denied = hookOutput(await edit(fixture, "one"));
      expect(denied.permissionDecision).toBe("deny");
      expect(denied.permissionDecisionReason).toContain(
        "could not confirm this edit with your team's hub",
      );
      expect(denied.permissionDecisionReason).toContain("Try again in a moment");
      expect(denied.permissionDecisionReason).toContain("switch this project to notify");

      // The project's own policy, as the last view had it, outranks this person's.
      policies.current = "notify";
      hubPolicies.current = { app: "exclusive" };
      await fixture.broker["sync"]("acme");
      expect(hookOutput(await edit(fixture, "one")).permissionDecision).toBe("deny");

      hubPolicies.current = undefined;
      await fixture.broker["sync"]("acme");
      expect(await edit(fixture, "one")).toBeNull();
      const log = await events(fixture);
      expect(log.filter((entry) => entry.event === "intent.failed")).toHaveLength(3);
      expect(log.find((entry) => entry.event === "intent.failed")).toMatchObject({
        reason: "connection refused",
        files: ["src/pay.ts"],
      });
      expect(log.filter((entry) => entry.event === "intent.unverified")).toMatchObject([
        { files: ["src/pay.ts"], policy: "notify" },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("leaves it to the person under ask when the hub fails: Claude Code asks, Codex's agent does", async () => {
    const fixture = await brokerFixture(() => ({
      policy: () => "ask",
      report: async () => viewOf(),
      intent: async () => {
        throw new Error("connection refused");
      },
    }));
    try {
      const claude = hookOutput(await edit(fixture, "claude-one", "claude"));
      expect(claude.permissionDecision).toBe("ask");
      expect(claude.permissionDecisionReason).toContain("could not confirm this edit");
      // Approved: the edit runs, and the file is not asked about again.
      await after(fixture, "claude-one");
      expect(await edit(fixture, "claude-one", "claude")).toBeNull();

      const codex = hookOutput(await edit(fixture, "codex-one", "codex"));
      expect(codex.permissionDecision).toBe("deny");
      expect(codex.permissionDecisionReason).toContain("Ask your person in your reply");
      expect(await edit(fixture, "codex-one", "codex")).toBeNull();
    } finally {
      await fixture.dispose();
    }
  });

  it("falls back when the hub does not answer within its deadline, and says so", async () => {
    const called = Promise.withResolvers<void>();
    let timeoutMs = 0;
    const fixture = await brokerFixture(() => ({
      policy: () => "coordinate",
      report: async () => viewOf(),
      intent: (_workspace, _project, _request, given) => {
        timeoutMs = given;
        called.resolve();
        return new Promise<never>(() => undefined);
      },
    }));
    try {
      // The session is known to the hub and the project's `.ai` is read: only the hub is left to wait for.
      const session = await fixture.broker["sessionFor"](
        "claude",
        { session_id: "slow", cwd: fixture.root },
        undefined,
      );
      await fixture.broker["sync"]("acme");
      await fixture.broker["ensureKnowledge"](session!);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const pending = edit(fixture, "slow");
        // Its timer is set as the hub is asked; should the hub not be asked, the answer comes without it.
        await Promise.race([called.promise, pending]);
        await vi.advanceTimersByTimeAsync(2000);
        const out = hookOutput(await pending);
        expect(out.permissionDecision).toBe("deny");
        expect(out.permissionDecisionReason).toContain("Try again in a moment");
      } finally {
        vi.useRealTimers();
      }
      // What was left of its 2 s when the hub was asked, not more.
      expect(timeoutMs).toBeGreaterThan(1500);
      expect(timeoutMs).toBeLessThanOrEqual(2000);
      expect(
        (await events(fixture)).find((entry) => entry.event === "intent.failed"),
      ).toMatchObject({
        reason: "timeout",
        files: ["src/pay.ts"],
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("tells the hub of an agent's approval, and ignores a hub that cannot take it", async () => {
    const acked: Array<readonly string[]> = [];
    let answer: "ok" | "unsupported" | "fails" = "ok";
    const fixture = await brokerFixture(() => ({
      nameOf: people,
      report: async () => viewOf(),
      intent: async (_workspace, _project, request) => answerOf(request.session, "ask"),
      ack: async (_workspace, _project, overlap, session, op) => {
        acked.push([overlap, session, op]);
        if (answer === "fails") throw new Error("hub unreachable");
        if (answer === "unsupported") return { unsupported: true };
        return overlapWith(session, { acks: { [session]: at } });
      },
    }));
    try {
      expect(hookOutput(await edit(fixture, "one")).permissionDecision).toBe("ask");
      // The person has not approved yet: nothing to tell.
      expect(acked).toEqual([]);
      await after(fixture, "one");
      expect(acked).toHaveLength(1);
      expect(acked[0]?.slice(0, 2)).toEqual(["abc123def456", "claude:one"]);
      expect(acked[0]?.[2]).toEqual(expect.any(String));
      await settled();
      expect(
        fixture.broker.snapshot().overlaps.find((overlap) => overlap.id === "abc123def456")?.acks,
      ).toEqual({ "claude:one": at });
      expect((await events(fixture)).filter((entry) => entry.event === "ack")).toHaveLength(1);

      // The same approval is not told twice, and it settles the question for the file.
      await after(fixture, "one");
      expect(acked).toHaveLength(1);
      expect(await edit(fixture, "one")).toBeNull();

      // A hub from before acknowledgements, or one that fails: the edit is not affected.
      for (const [id, how] of [
        ["two", "unsupported"],
        ["three", "fails"],
      ] as const) {
        answer = how;
        expect(hookOutput(await edit(fixture, id)).permissionDecision).toBe("ask");
        await after(fixture, id);
        await settled();
        expect(acked.at(-1)?.[1]).toBe(`claude:${id}`);
      }
      const log = await events(fixture);
      expect(log.filter((entry) => entry.event === "ack.failed")).toMatchObject([
        { reason: "hub unreachable" },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("sends one op with each note or resolution, one for the command and told apart per overlap", async () => {
    const posted: Array<{ kind: string; overlap: string; op: string | undefined }> = [];
    const other = (id: string): HubOverlap => ({
      ...overlapWith("claude:me"),
      id,
      sessions: ["claude:me", `claude:peer-${id}`],
    });
    const fixture = await brokerFixture(() => ({
      report: async () => viewOf({ overlaps: [other("aaaaaaaaaaaa"), other("bbbbbbbbbbbb")] }),
      note: async (_workspace, _project, overlap, _text, _session, op) => {
        posted.push({ kind: "note", overlap, op });
        return other(overlap);
      },
      resolve: async (_workspace, _project, overlap, _text, _session, op) => {
        posted.push({ kind: "resolve", overlap, op });
        return { ...other(overlap), state: "resolved" };
      },
    }));
    try {
      await fixture.broker["sessionFor"](
        "claude",
        { session_id: "me", cwd: fixture.root },
        undefined,
      );
      const headers = { "x-peer-session": "claude:me" };
      await fixture.broker["runCli"]("note", ["I change pay() only"], headers);
      await fixture.broker["runCli"]("note", ["I change pay() only"], headers);
      await fixture.broker["runCli"]("resolve", ["Ana first"], headers);
      expect(posted).toHaveLength(6);
      const ops = posted.map(({ op }) => op ?? "");
      for (const op of ops) expect(op.length).toBeGreaterThan(0);
      for (const op of ops) expect(op.length).toBeLessThanOrEqual(64);
      // Every post is its own (the hub never takes one for another), and an invocation's overlaps share the command's.
      expect(new Set(ops).size).toBe(6);
      const command = (post: number) => ops[post]?.split(":")[0];
      expect(command(0)).toBe(command(1));
      expect(command(2)).toBe(command(3));
      expect(command(4)).toBe(command(5));
      expect(new Set([command(0), command(2), command(4)]).size).toBe(3);
      expect(ops[0]?.endsWith(`:${posted[0]?.overlap}`)).toBe(true);
    } finally {
      await fixture.dispose();
    }
  });
  it("lets exactly one of two computers' first edits of a file through, however close they come", async () => {
    // A hub that decides in one step, as the real one does: whoever asks first holds the path.
    const holders = new Map<string, string>();
    const asked: string[] = [];
    const hub = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => (raw += chunk));
      request.on("end", () => {
        const ask = JSON.parse(raw) as HubIntentRequest;
        asked.push(ask.session);
        const overlaps: HubOverlap[] = [];
        const verdicts = ask.paths.map((path) => {
          const holder = holders.get(path);
          if (holder === undefined || holder === ask.session) {
            holders.set(path, ask.session);
            return { path, verdict: "clear" as const, with: [], overlaps: [] };
          }
          overlaps.push({
            ...overlapWith(ask.session),
            id: `ov-${path.replace(/\W/g, "-")}`.slice(0, 40),
            sessions: [ask.session, holder].toSorted(),
            files: [path],
          });
          return {
            path,
            verdict: "deny" as const,
            with: [holder],
            overlaps: overlaps.map((overlap) => overlap.id),
          };
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ policy: "coordinate", policySource: "client", verdicts, overlaps, at }),
        );
      });
    });
    await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(hub.address() as NodeNet.AddressInfo).port}`;
    const computer = () =>
      brokerFixture(() => ({
        policy: () => "coordinate",
        report: async () => viewOf({ sessions: [] }),
        // Over the wire, as Peer's hub client does it (its own tests cover that client).
        intent: async (_workspace, _project, request) =>
          (await fetch(`${url}/intent`, {
            method: "POST",
            body: JSON.stringify(request),
          }).then((response) => response.json())) as HubIntentAnswer,
      }));
    const ana = await computer();
    const bob = await computer();
    try {
      for (let round = 0; round < 20; round += 1) {
        const file = `src/race-${round}.ts`;
        const outs = await Promise.all([
          edit(ana, "ana", "claude", file),
          edit(bob, "bob", "claude", file),
        ]);
        const stopped = outs.filter((out) => hookOutput(out).permissionDecision === "deny");
        expect(stopped, `round ${round + 1}: ${JSON.stringify(outs)}`).toHaveLength(1);
        expect(hookOutput(stopped[0] ?? null).permissionDecisionReason).toContain(
          `peer note "<your plan for ${file}>"`,
        );
      }
      // Each edit asked the hub: neither computer decided on a view of its own.
      expect(asked).toHaveLength(40);
    } finally {
      await Promise.all([ana.dispose(), bob.dispose()]);
      await new Promise<void>((resolve) => {
        hub.closeAllConnections();
        hub.close(() => resolve());
      });
    }
  });
});

describe("exact shared-context reads", () => {
  it("returns the exact recorded text while a newer mirror arrives", async () => {
    const recording = Promise.withResolvers<void>();
    const confirm = Promise.withResolvers<void>();
    const initial = {
      project: "app",
      scope: "task:other",
      version: 1,
      text: "# Contract\nUse local date.",
      updatedAt: new Date().toISOString(),
    };
    let recorded = 0;
    const fixture = await brokerFixture(() => ({
      readContext: async () => initial,
      contextRead: async (_workspace, project, scope, session, version) => {
        recorded = version;
        recording.resolve();
        await confirm.promise;
        return { project, scope, session, version, environment: "test", at: initial.updatedAt };
      },
    }));
    try {
      await fixture.register("reader");
      await fixture.broker["mirror"]("acme", initial);
      const session = fixture.broker["sessions"].get("claude:reader")!;
      const pending = fixture.broker["contextCli"](session, "task:other", undefined);
      await recording.promise;
      await fixture.broker["mirror"]("acme", {
        ...initial,
        version: 2,
        text: "# Contract\nUse UTC date.",
      });
      confirm.resolve();
      const text = await pending;
      expect(recorded).toBe(1);
      expect(text).toContain("version 1");
      expect(text).toContain("Use local date.");
      expect(text).not.toContain("Use UTC date.");
      expect(session.read.get("task:other")).toMatchObject({ version: 1, text: initial.text });
    } finally {
      confirm.resolve();
      await fixture.dispose();
    }
  });
  it("reads canonical hub text instead of attributing a pending local edit to an old version", async () => {
    const initial = {
      project: "app",
      scope: "project",
      version: 1,
      text: "# Contract\nCommitted shared decision.",
      updatedAt: new Date().toISOString(),
    };
    const fixture = await brokerFixture(() => ({ readContext: async () => initial }));
    try {
      await fixture.register("keeper");
      const mirror = await fixture.broker["mirror"]("acme", initial);
      mirror.text = "# Contract\nPending uncommitted decision.";
      mirror.unsent = true;
      const session = fixture.broker["sessions"].get("claude:keeper")!;
      const text = await fixture.broker["contextCli"](session, "project", undefined);
      expect(text).toContain("Committed shared decision.");
      expect(text).not.toContain("Pending uncommitted decision.");
      expect(mirror.unsent).toBe(true);
      expect(mirror.text).toContain("Pending uncommitted decision.");
    } finally {
      await fixture.dispose();
    }
  });
});
