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

import {
  activeAgents,
  adviceLabel,
  adviceOnWork,
  buildWorkTree,
  taskMenuItems,
  taskNamedIn,
  threadMenuItems,
} from "./workTree.logic";

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
    modelSelection: { instanceId: "claudeAgent", model: "claude-sonnet-5-5" },
    latestUserMessageAt: null,
    updatedAt: "2026-10-03T11:00:00Z",
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

function status(project: PeerProjectState, role: "owner" | "member" = "owner"): PeerHubStatus {
  return {
    hubUrl: "https://hub.example.test",
    signedIn: true,
    email: "slavo@acme.test",
    pendingSignIn: null,
    workspaces: [
      {
        slug: "acme",
        name: "Acme",
        role,
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
    github: { cli: true, account: "slavo", signIn: null, error: null },
    coordination: {
      enabled: false,
      policy: "coordinate",
      claudeHooks: false,
      logPath: "",
      sessions: [],
      overlaps: [],
      findings: [],
      contexts: [],
      candidates: [],
    },
    sharedThreads: ["peer:t1"],
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
    expect(partnerRec?.status).toBe("idle"); // A settled runtime does not prove delivery.
    const str = project?.areas[1]?.tasks[1];
    expect(str?.threads[0]?.stale).toBe(true);
    expect(project?.unsorted.map((t) => t.title)).toEqual(["Tidy the README"]);
  });

  it("opens this computer's threads and herdr agents, and only those can be placed", () => {
    const [project] = buildWorkTree({ status: status(kirkwood()), localThreads: LOCAL, now: NOW });
    const threads = project?.areas[0]?.tasks[0]?.threads ?? [];
    expect(threads.find((t) => t.source === "herdr")?.open).toEqual({
      kind: "herdr",
      agentId: "herdr:term1",
      paneId: "w1:p2",
    });
    expect(threads.find((t) => t.title === "Main implementation")?.open).toEqual({
      kind: "thread",
      environmentId: HERE,
      threadId: ThreadId.make("t1"),
    });
    expect(threads.find((t) => t.person === "Yev")?.placeable).toBe(false);
  });

  it("puts your own threads first, then what needs attention", () => {
    const project = kirkwood();
    const colleague = project.work.threads[0];
    const waiting = {
      ...colleague!,
      id: "peer:t10",
      title: "Payments review",
      email: "chino@acme.test",
      status: "blocked" as const,
    };
    const [tree] = buildWorkTree({
      status: status({ ...project, work: { ...project.work, threads: [colleague!, waiting] } }),
      localThreads: LOCAL,
      now: NOW,
    });
    expect(tree?.areas[0]?.tasks[0]?.threads.map((t) => [t.person, t.status])).toEqual([
      ["Slavo", "blocked"],
      ["Slavo", "working"],
      ["Chino", "blocked"],
      ["Yev", "working"],
    ]);
  });

  it("lets the task's creator, a lead or an admin remove it, as the hub does", () => {
    const project = kirkwood();
    const asMember = {
      ...project,
      project: { ...project.project, role: "member" as const },
      work: {
        ...project.work,
        tasks: [
          { ...task("mine", "Mine", "Revenue"), createdBy: "slavo@acme.test" },
          { ...task("theirs", "Theirs", "Revenue"), createdBy: "yev@acme.test" },
        ],
      },
    };
    const removable = (role: "owner" | "member") =>
      buildWorkTree({ status: status(asMember, role), localThreads: [], now: NOW })[0]
        ?.areas.flatMap((a) => a.tasks)
        .map((t) => [t.id, t.removable]);
    expect(removable("member")).toEqual([
      ["mine", true],
      ["theirs", false],
    ]);
    expect(removable("owner")).toEqual([
      ["mine", true],
      ["theirs", true],
    ]);
  });
});

describe("shared contexts", () => {
  const session = (id: string, email: string) => ({
    id,
    workspace: "acme",
    project: "kirkwood",
    email,
    label: "work",
    status: "working" as const,
    files: ["src/pay.ts"],
    claims: [],
    local: email === "slavo@acme.test",
  });

  it("gives a task its context: who keeps it while at work, and what was found since it changed", () => {
    const project = kirkwood();
    const yevAgent = {
      id: "herdr:claude:s-yev",
      task: "krk-812",
      title: "Webhook retries",
      email: "yev@acme.test",
      status: "working" as const,
      source: "herdr" as const,
      environment: "yev-laptop",
      seenAt: "2026-10-03T11:59:30Z",
    };
    const base = status({
      ...project,
      work: { ...project.work, threads: [...project.work.threads, yevAgent] },
    });
    const finding = (id: string, text: string, at: string, task?: string) => ({
      id,
      workspace: "acme",
      project: "kirkwood",
      ...(task === undefined ? {} : { task }),
      text,
      email: "chino@acme.test",
      at,
    });
    const keeper = (session: string, email: string) => ({
      session,
      email,
      environment: "laptop",
      since: "2026-10-03T10:00:00Z",
    });
    const [tree] = buildWorkTree({
      status: {
        ...base,
        coordination: {
          ...base.coordination,
          sessions: [session("claude:s-yev", "yev@acme.test")],
          findings: [
            finding("f1", "Stripe retries webhooks for 3 days", "2026-10-03T11:50:00Z", "krk-812"),
            finding("f2", "Folded in already", "2026-10-03T11:00:00Z", "krk-812"),
            finding("f3", "Work outside tasks", "2026-10-03T11:55:00Z"),
          ],
          contexts: [
            {
              workspace: "acme",
              project: "kirkwood",
              scope: "task:krk-812",
              version: 4,
              keeper: keeper("claude:s-yev", "yev@acme.test"),
              updatedAt: "2026-10-03T11:30:00Z",
              updatedBy: "yev@acme.test",
              updatedSession: "claude:s-yev",
              gist: "Stripe webhooks retry; we dedupe by event id",
              bytes: 8_400,
            },
            {
              workspace: "acme",
              project: "kirkwood",
              scope: "project",
              version: 0,
              keeper: keeper("claude:ended", "chino@acme.test"),
              updatedAt: "2026-10-03T09:00:00Z",
              bytes: 0,
            },
          ],
        },
      },
      localThreads: LOCAL,
      now: NOW,
    });
    const task = tree?.areas[0]?.tasks[0];
    expect([task?.id, task?.context?.keeper?.person, task?.context?.updatedBy]).toEqual([
      "krk-812",
      "Yev",
      "Yev",
    ]);
    expect([task?.context?.gist, task?.context?.tokens]).toEqual([
      "Stripe webhooks retry; we dedupe by event id",
      2_100,
    ]);
    expect(task?.threads.filter((t) => t.keepsContext).map((t) => t.title)).toEqual([
      "Webhook retries",
    ]);
    expect(task?.context?.reports.map((r) => r.text)).toEqual([
      "Stripe retries webhooks for 3 days",
    ]);
    expect(tree?.context?.keeper).toBeUndefined();
    expect(tree?.context?.reports.map((r) => r.text)).toEqual(["Work outside tasks"]);
    expect(tree?.areas[0]?.tasks[1]?.context).toBeUndefined();
  });

  it("says why a colleague's thread concerns you", () => {
    const project = kirkwood();
    const yevAgent = {
      id: "herdr:claude:s-yev",
      task: "krk-812",
      title: "Pay form validation",
      email: "yev@acme.test",
      status: "working" as const,
      source: "herdr" as const,
      environment: "yev-laptop",
      seenAt: "2026-10-03T11:59:30Z",
    };
    const base = status({
      ...project,
      work: { ...project.work, threads: [...project.work.threads, yevAgent] },
    });
    const [tree] = buildWorkTree({
      status: {
        ...base,
        coordination: {
          ...base.coordination,
          sessions: [
            session("claude:s-me", "slavo@acme.test"),
            session("claude:s-yev", "yev@acme.test"),
          ],
          overlaps: [
            {
              id: "o1",
              workspace: "acme",
              project: "kirkwood",
              sessions: ["claude:s-me", "claude:s-yev"],
              files: ["src/pay.ts"],
              state: "open" as const,
              notes: [],
              updatedAt: "2026-10-03T11:59:00Z",
            },
          ],
        },
      },
      localThreads: LOCAL,
      now: NOW,
    });
    const threads = tree?.areas[0]?.tasks[0]?.threads ?? [];
    expect(threads.find((t) => t.title === "Pay form validation")?.concerns).toBe(
      "Its agent and yours both change src/pay.ts",
    );
    expect(threads.find((t) => t.title === "UI adjustments")?.concerns).toBeUndefined();
  });
});

describe("menus", () => {
  const [project] = buildWorkTree({ status: status(kirkwood()), localThreads: LOCAL, now: NOW });
  const split = project?.areas[0]?.tasks[0];
  const tasks = project?.tasks ?? [];
  const thread = (title: string) => split?.threads.find((t) => t.title === title);

  it("changes only your own threads on this computer", () => {
    const menu = (title: string) =>
      threadMenuItems({ thread: thread(title)!, tasks, taskId: "krk-812", running: true });
    expect(menu("UI adjustments")).toEqual([]);
    expect(menu("Investigation for KRK-812").map((item) => item.id)).toEqual([
      "show-in-herdr",
      "move",
      "share",
    ]);
    const mine = menu("Main implementation");
    expect(mine.map((item) => [item.id, item.disabled ?? false])).toEqual([
      ["rename", false],
      ["move", false],
      ["unshare", false],
      ["archive", true],
      ["delete", false],
    ]);
    const places = mine.find((item) => item.id === "move")?.children ?? [];
    expect(places.filter((item) => item.checked).map((item) => item.id)).toEqual(["task:krk-812"]);
    expect(places.at(-1)?.id).toBe("unassign");
  });

  it("offers removing a task only to those the hub lets remove it", () => {
    const ids = (removable: boolean) =>
      taskMenuItems({ task: { ...split!, removable }, canStartThread: false }).map((i) => i.id);
    expect(ids(true)).toContain("remove");
    expect(ids(false)).not.toContain("remove");
    expect(ids(false)).toContain("rename");
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
  it("puts what waits on you first, and keeps what just works below it", () => {
    const finished = shell("t5", "Webhook retries", {
      latestRun: { completedAt: "2026-10-03T11:00:00Z" },
    } as Partial<EnvironmentThreadShell>);
    const project = status(kirkwood());
    const withDone = {
      ...project,
      agents: {
        ...project.agents,
        list: [
          ...project.agents.list,
          {
            id: "herdr:term3",
            paneId: "w3:p1",
            agent: "claude",
            title: "Review the diff",
            status: "done" as const,
          },
        ],
      },
    };
    const agents = activeAgents({
      status: withDone,
      localThreads: [...LOCAL, finished],
      projectNames: new Map([[`${HERE}:${KIRKWOOD_T3}`, "Kirkwood"]]),
      localEnvironmentId: HERE,
      unseen: (thread) => thread.id === finished.id,
      taskOf: new Map([["herdr:term1", "KRK-812 · Split Payments"]]),
    });
    expect(agents.map((a) => [a.title, a.needs ?? a.status, a.where])).toEqual([
      ["Investigation for KRK-812", "input", "Kirkwood · KRK-812 · Split Payments"],
      ["Review the diff", "review", undefined],
      ["Webhook retries", "review", "Kirkwood"],
      ["Main implementation", "working", "Kirkwood"],
      ["Side project", "working", "side"],
    ]);
  });
});

describe("what an agent did with the team's work", () => {
  const told = (
    over: Partial<NonNullable<PeerHubStatus["coordination"]["advice"]>[number]> = {},
  ): NonNullable<PeerHubStatus["coordination"]["advice"]>[number] => ({
    workspace: "acme",
    project: "kirkwood",
    session: "claude:a",
    about: "work",
    scope: "task:str",
    name: "STR",
    how: "read",
    why: "read its shared context, version 3",
    at: "2026-10-03T11:55:00Z",
    ...over,
  });
  const withAdvice = (advice: ReadonlyArray<ReturnType<typeof told>>): PeerHubStatus => {
    const base = status(kirkwood());
    return {
      ...base,
      coordination: {
        ...base.coordination,
        sessions: [
          {
            id: "claude:a",
            workspace: "acme",
            project: "kirkwood",
            email: "slavo@acme.test",
            label: "Split payments",
            status: "working",
            task: "krk-812",
            files: [],
            claims: [],
            local: true,
          },
          {
            id: "codex:b",
            workspace: "acme",
            project: "kirkwood",
            email: "yev@acme.test",
            label: "UI",
            status: "working",
            task: "krk-812",
            files: [],
            claims: [],
            local: false,
          },
          {
            id: "claude:c",
            workspace: "acme",
            project: "kirkwood",
            email: "chino@acme.test",
            label: "Loose",
            status: "working",
            files: [],
            claims: [],
            local: false,
          },
        ],
        advice,
      },
    };
  };
  const on = (status: PeerHubStatus, scope: string) =>
    adviceOnWork({ status, workspace: "acme", project: "kirkwood", scope });

  it("is listed on the work its agent is on, newest first, with whose agent it was", () => {
    const status = withAdvice([
      told({ at: "2026-10-03T11:50:00Z", name: "Partner Rec", scope: "task:partner-rec" }),
      told({ at: "2026-10-03T11:58:00Z", session: "codex:b", how: "asked" }),
      told({ session: "claude:c", name: "Loose ends" }),
    ]);
    const rows = on(status, "task:krk-812");
    expect(rows.map((row) => [row.person, row.name, row.mine])).toEqual([
      ["Yev", "STR", false],
      ["Slavo", "Partner Rec", true],
    ]);
    // An agent on no task is the project's work.
    expect(on(status, "project").map((row) => row.name)).toEqual(["Loose ends"]);
    expect(on(status, "task:str")).toEqual([]);
  });

  it("leaves out an agent that no longer reports, other projects and other workspaces", () => {
    const status = withAdvice([
      told({ session: "claude:gone" }),
      told({ project: "elsewhere" }),
      told({ workspace: "globex" }),
    ]);
    expect(on(status, "task:krk-812")).toEqual([]);
    // A Peer from before advice lists none.
    const base = withAdvice([]);
    const { advice: _gone, ...coordination } = base.coordination;
    expect(on({ ...base, coordination }, "task:krk-812")).toEqual([]);
  });

  it("says in a line whose agent did what", () => {
    const row = (over: Parameters<typeof told>[0]) => {
      const rows = on(withAdvice([told({ session: "codex:b", ...over })]), "task:krk-812");
      return adviceLabel(rows[0]!);
    };
    expect(row({})).toBe("Yev’s agent read this work’s context");
    expect(row({ how: "asked" })).toBe("Yev’s agent asked this work’s agents");
    expect(row({ how: "found" })).toBe("Yev’s agent was pointed to this work by a model it asked");
    expect(row({ about: "knowledge", scope: "kx:d1", entryKind: "decision", how: "read" })).toBe(
      "Yev’s agent read a decision of the project",
    );
    expect(row({ about: "knowledge", scope: "kx:d1", entryKind: "decision", how: "governs" })).toBe(
      "Yev’s agent was reminded of a decision of the project that governs files it changes",
    );
    expect(row({ about: "knowledge", scope: "kx:d1", how: "found" })).toBe(
      "Yev’s agent was pointed to an entry of the project by a model it asked",
    );
    const mine = on(withAdvice([told({})]), "task:krk-812");
    expect(adviceLabel(mine[0]!)).toBe("Your agent read this work’s context");
  });
});

describe("durable work and runtime presence", () => {
  it("overlays a live local thread on its hub record without duplicating it", () => {
    const base = kirkwood();
    const hub = status(base);
    const record = {
      id: "peer:local",
      task: "krk-812",
      title: "Build",
      email: hub.email!,
      environment: HERE,
      status: "idle" as const,
      source: "peer" as const,
      seenAt: new Date(NOW).toISOString(),
      runtimePresent: true,
      delivery: "review" as const,
    };
    const project = { ...base, work: { ...base.work, threads: [record] } };
    const [tree] = buildWorkTree({
      status: status(project),
      localThreads: [shell("local", "Build", { branch: "fix/KRK-812" })],
      now: NOW,
    });
    const nodes = tree!.areas.flatMap((area) => area.tasks).flatMap((task) => task.threads);
    expect(nodes.filter((node) => node.title === "Build")).toHaveLength(1);
    expect(nodes.find((node) => node.title === "Build")?.delivery).toBe("review");
  });

  it("keeps our absent runtime visible without an Observe action or a working task rollup", () => {
    const base = kirkwood();
    const hub = status(base);
    const project = {
      ...base,
      work: {
        ...base.work,
        threads: [
          {
            id: "herdr:codex:gone",
            task: "krk-812",
            title: "Awaiting merge",
            email: hub.email!,
            environment: HERE,
            status: "working" as const,
            source: "herdr" as const,
            runtimePresent: false,
            observable: true,
            seenAt: new Date(NOW).toISOString(),
            delivery: "review" as const,
          },
        ],
      },
    };
    const s = status(project);
    const [tree] = buildWorkTree({
      status: { ...s, agents: { ...s.agents, list: [] } },
      localThreads: [],
      now: NOW,
    });
    const task = tree!.areas[0]!.tasks[0]!;
    expect(task.threads[0]?.stale).toBe(true);
    expect(task.threads[0]?.open).toBeUndefined();
    expect(task.threads[0]?.status).toBe("unknown");
    expect(task.status).toBe("idle");
    expect(task.threads[0]?.key).toBe("herdr:codex:gone");
    expect(
      threadMenuItems({
        thread: task.threads[0]!,
        taskId: task.id,
        tasks: project.work.tasks,
        running: false,
      }).map((item) => item.id),
    ).toEqual(["move"]);
  });

  it("overlays a temporary herdr identity without duplicating its stable work", () => {
    const base = kirkwood();
    const hub = status(base);
    const record = {
      id: "herdr:codex:stable",
      previousId: "herdr:term1",
      task: "krk-812",
      title: "Investigation for KRK-812",
      email: hub.email!,
      environment: HERE,
      status: "idle" as const,
      source: "herdr" as const,
      runtimePresent: true,
      seenAt: new Date(NOW).toISOString(),
      delivery: "review" as const,
    };
    const project = { ...base, work: { ...base.work, threads: [record] } };
    const [tree] = buildWorkTree({ status: status(project), localThreads: [], now: NOW });
    const rows = tree!.areas.flatMap((area) => area.tasks).flatMap((task) => task.threads);
    expect(rows.filter((node) => node.title === record.title)).toHaveLength(1);
    expect(rows.find((node) => node.title === record.title)?.key).toBe(record.id);
  });
});
