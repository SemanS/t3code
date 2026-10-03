import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PeerHubStatus,
  type PeerProjectState,
  type PeerTask,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import { activeAgents, buildWorkTree, taskNamedIn } from "./workTree.logic";

const HERE = EnvironmentId.make("env-here");
const KIRKWOOD_T3 = ProjectId.make("t3-kirkwood");
const NOW = Date.parse("2026-10-03T12:00:00Z");

function task(id: string, title: string, area: string | undefined, key?: string): PeerTask {
  return {
    id,
    title,
    status: "open",
    createdBy: "slavo@acme.test",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...(area === undefined ? {} : { area }),
    ...(key === undefined ? {} : { key }),
  };
}

/** A local thread with only what the work tree reads. */
function shell(
  id: string,
  title: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: HERE,
    id: ThreadId.make(id),
    projectId: KIRKWOOD_T3,
    title,
    branch: null,
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    settledAt: null,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  } as unknown as EnvironmentThreadShell;
}

function kirkwood(): PeerProjectState {
  return {
    project: {
      id: "kirkwood",
      name: "Kirkwood",
      role: "lead",
      members: [
        { email: "slavo@acme.test", name: "Slavo" },
        { email: "yev@acme.test", name: "Yev" },
        { email: "chino@acme.test", name: "Chino" },
      ],
      repositories: [{ id: "app", url: "git@example.test:acme/app.git", branch: "main" }],
      knowledge: { kontext: true, company: true },
      tools: [],
      capacity: { personal: "any", personalHarnesses: [] },
    },
    repositories: [
      {
        id: "app",
        url: "git@example.test:acme/app.git",
        branch: "main",
        path: "/w/acme/kirkwood/app",
        state: "ready",
        projectId: KIRKWOOD_T3,
      },
    ],
    tools: [],
    sharedCapacity: { enabled: false, instanceIds: [] },
    work: {
      areas: ["Groups & Events", "Revenue", "Infrastructure"],
      tasks: [
        task("krk-812", "Split Payments", "Groups & Events", "KRK-812"),
        task("partner-rec", "Partner Rec", "Revenue"),
        task("str", "STR", "Revenue"),
        task("loose", "Loose ends", undefined),
      ],
      threads: [
        {
          id: "peer:t9",
          task: "krk-812",
          title: "UI adjustments",
          email: "yev@acme.test",
          status: "working",
          source: "peer",
          environment: "yev-laptop",
          seenAt: "2026-10-03T11:59:30Z",
        },
        {
          id: "herdr:x1",
          task: "str",
          title: "Variance calculation",
          email: "chino@acme.test",
          status: "working",
          source: "herdr",
          environment: "chino-desk",
          seenAt: "2026-10-03T11:40:00Z",
        },
      ],
      assignments: { "peer:t2": "partner-rec" },
    },
    peers: [],
  };
}

function status(project: PeerProjectState): PeerHubStatus {
  return {
    hubUrl: "https://hub.example.test",
    signedIn: true,
    email: "slavo@acme.test",
    pendingSignIn: null,
    workspaces: [
      {
        slug: "acme",
        name: "Acme",
        role: "owner",
        allowedDomains: ["acme.test"],
        currency: "EUR",
        memberName: "Slavo",
        companyKnowledge: null,
        projects: [project],
        lastSyncAt: null,
        error: null,
      },
    ],
    joinable: [],
    workspaceRoot: "/w",
    environmentId: HERE,
    agents: {
      herdr: "running",
      list: [
        {
          id: "herdr:term1",
          paneId: "w1:p2",
          agent: "codex",
          title: "Investigation for KRK-812",
          status: "blocked",
          workspace: "acme",
          projectId: "kirkwood",
        },
        {
          id: "herdr:term2",
          paneId: "w2:p1",
          agent: "claude",
          title: "Side project",
          status: "working",
          cwd: "/Users/slavo/side",
        },
      ],
    },
    syncing: false,
    lastSyncAt: null,
    error: null,
  };
}

const LOCAL = [
  shell("t1", "Main implementation", {
    branch: "krk-812-backend",
    runtime: { status: "running" } as EnvironmentThreadShell["runtime"],
  }),
  shell("t2", "Consolidated average", { settledAt: "2026-10-02T10:00:00Z" }),
  shell("t3", "Tidy the README"),
  shell("t4", "Archived work", { archivedAt: "2026-10-02T10:00:00Z" }),
];

describe("buildWorkTree", () => {
  it("follows the product: project → area → task → threads, people as metadata", () => {
    const [project] = buildWorkTree({ status: status(kirkwood()), localThreads: LOCAL, now: NOW });
    expect(project?.name).toBe("Kirkwood");
    expect(project?.areas.map((a) => a.name)).toEqual([
      "Groups & Events",
      "Revenue",
      "Infrastructure",
      null,
    ]);
    const split = project?.areas[0]?.tasks[0];
    expect(split?.key).toBe("KRK-812");
    // A herdr agent naming the key, a branch naming it, and a colleague's thread placed on it.
    expect(split?.threads.map((t) => [t.title, t.person, t.status])).toEqual([
      ["Investigation for KRK-812", "Slavo", "blocked"],
      ["Main implementation", "Slavo", "working"],
      ["UI adjustments", "Yev", "working"],
    ]);
    expect(split?.status).toBe("blocked");
    const partnerRec = project?.areas[1]?.tasks[0];
    expect(partnerRec?.threads.map((t) => [t.title, t.status])).toEqual([
      ["Consolidated average", "done"],
    ]);
    expect(partnerRec?.status).toBe("done");
    const str = project?.areas[1]?.tasks[1];
    expect(str?.threads[0]?.stale).toBe(true);
    expect(project?.unsorted.map((t) => t.title)).toEqual(["Tidy the README"]);
  });

  it("opens this computer's threads and herdr agents, and only those can be placed", () => {
    const [project] = buildWorkTree({ status: status(kirkwood()), localThreads: LOCAL, now: NOW });
    const threads = project?.areas[0]?.tasks[0]?.threads ?? [];
    expect(threads.find((t) => t.source === "herdr")?.open).toEqual({
      kind: "herdr",
      paneId: "w1:p2",
    });
    expect(threads.find((t) => t.title === "Main implementation")?.open).toEqual({
      kind: "thread",
      environmentId: HERE,
      threadId: ThreadId.make("t1"),
    });
    expect(threads.find((t) => t.person === "Yev")?.placeable).toBe(false);
  });
});

describe("taskNamedIn", () => {
  const tasks = [task("krk-812", "Split", "A", "KRK-812"), task("krk-81", "Rec", "A", "KRK-81")];
  it("matches a key as a whole token, never two at once", () => {
    expect(taskNamedIn(tasks, ["feature/krk-812-split"])?.id).toBe("krk-812");
    expect(taskNamedIn(tasks, ["Fix KRK-81 totals"])?.id).toBe("krk-81");
    expect(taskNamedIn(tasks, ["KRK-8120"])).toBeUndefined();
    expect(taskNamedIn(tasks, ["KRK-81 and KRK-812"])).toBeUndefined();
  });
});

describe("activeAgents", () => {
  it("lists what runs here and may need you, blocked first", () => {
    const agents = activeAgents({
      status: status(kirkwood()),
      localThreads: LOCAL,
      projectNames: new Map([[`${HERE}:${KIRKWOOD_T3}`, "Kirkwood"]]),
      localEnvironmentId: HERE,
    });
    expect(agents.map((a) => [a.title, a.status, a.where])).toEqual([
      ["Investigation for KRK-812", "blocked", "Kirkwood"],
      ["Main implementation", "working", "Kirkwood"],
      ["Side project", "working", "side"],
    ]);
  });
});
