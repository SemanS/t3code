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

async function brokerFixture() {
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
  const broker = new CoordinationBroker(deps);
  const register = async (id: string) => {
    await broker["sessionFor"]("claude", { session_id: id, cwd: root }, undefined);
  };
  const find = (id: string) =>
    broker["runCli"]("find", ["format prices"], { "x-peer-session": `claude:${id}` });
  const dispose = async () => {
    await broker.stop();
    await NodeFSP.rm(root, { recursive: true, force: true });
  };
  return { register, find, dispose };
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
