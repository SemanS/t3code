// @effect-diagnostics nodeBuiltinImport:off globalDate:off - broker fixtures in a temporary checkout.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { CoordinationBroker, type BrokerDeps } from "./coordinationBroker.ts";
import { runModel } from "./findModel.ts";

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
