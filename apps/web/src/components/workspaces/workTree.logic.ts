/**
 * The work tree: Project → Area → Task → Threads. The hierarchy follows the
 * product and the work; the person is metadata on a thread, never a level.
 *
 * This computer's threads come live from its own thread list (and herdr);
 * other people's and other computers' come from the hub. A thread sits under
 * the task it was placed on, else the task its branch or title names by key
 * (`krk-812-split` → KRK-812), else under the project's unsorted work.
 */
import type {
  EnvironmentId,
  PeerHubStatus,
  PeerLocalAgent,
  PeerProjectState,
  PeerTask,
  PeerWorkStatus,
  PeerWorkspaceState,
  ThreadId,
} from "@t3tools/contracts";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

/** A colleague's thread nobody has reported for this long shows as no longer live. */
export const STALE_AFTER_MS = 3 * 60 * 1000;

export type WorkOpen =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "herdr"; readonly paneId: string };

export interface WorkThreadNode {
  readonly key: string;
  readonly title: string;
  readonly person: string;
  readonly mine: boolean;
  readonly status: PeerWorkStatus;
  readonly harness: string | undefined;
  readonly branch: string | undefined;
  readonly source: "peer" | "herdr";
  /** A colleague's thread whose computer stopped reporting it. */
  readonly stale: boolean;
  readonly open: WorkOpen | undefined;
  /** This computer's threads can be placed under a task. */
  readonly placeable: boolean;
}

export interface WorkTaskNode {
  readonly id: string;
  readonly key: string | undefined;
  readonly title: string;
  readonly done: boolean;
  /** What the task's threads add up to: blocked beats working beats the rest. */
  readonly status: PeerWorkStatus;
  readonly threads: ReadonlyArray<WorkThreadNode>;
}

export interface WorkAreaNode {
  /** Null for tasks without an area. */
  readonly name: string | null;
  readonly tasks: ReadonlyArray<WorkTaskNode>;
}

export interface WorkProjectNode {
  readonly workspace: string;
  readonly workspaceName: string;
  readonly projectId: string;
  readonly name: string;
  readonly areas: ReadonlyArray<WorkAreaNode>;
  /** Threads on no task yet. */
  readonly unsorted: ReadonlyArray<WorkThreadNode>;
  readonly tasks: ReadonlyArray<PeerTask>;
  /** This computer has none of its repositories checked out. */
  readonly checkedOut: boolean;
}

/** A local thread's state: ◐ waiting on an answer, ● working, ✓ settled, ○ idle. */
export function localThreadStatus(thread: EnvironmentThreadShell): PeerWorkStatus {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "blocked";
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  return thread.settledAt !== null ? "done" : "idle";
}

/**
 * The task a branch or title names by key, when exactly one does. Keys match
 * as whole tokens in any case: `krk-812-split` names KRK-812, KRK-8120 does not.
 */
export function taskNamedIn(
  tasks: ReadonlyArray<PeerTask>,
  texts: ReadonlyArray<string | null | undefined>,
): PeerTask | undefined {
  const haystacks = texts.filter((t): t is string => typeof t === "string" && t !== "");
  const named = tasks.filter((task) => {
    if (task.key === undefined) return false;
    const pattern = new RegExp(
      `(^|[^a-z0-9])${task.key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`,
    );
    return haystacks.some((text) => pattern.test(text.toLowerCase()));
  });
  return named.length === 1 ? named[0] : undefined;
}

const STATUS_ORDER: Readonly<Record<PeerWorkStatus, number>> = {
  blocked: 0,
  working: 1,
  idle: 2,
  unknown: 3,
  done: 4,
};

function byActivity(a: WorkThreadNode, b: WorkThreadNode): number {
  return STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title);
}

function rollup(threads: ReadonlyArray<WorkThreadNode>, done: boolean): PeerWorkStatus {
  if (threads.some((t) => t.status === "blocked")) return "blocked";
  if (threads.some((t) => t.status === "working")) return "working";
  if (done || (threads.length > 0 && threads.every((t) => t.status === "done"))) return "done";
  return "idle";
}

function personName(project: PeerProjectState, email: string): string {
  return (
    project.project.members.find((m) => m.email === email)?.name ?? email.split("@")[0] ?? email
  );
}

function projectTree(input: {
  readonly status: PeerHubStatus;
  readonly workspace: PeerWorkspaceState;
  readonly state: PeerProjectState;
  readonly localThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly agents: ReadonlyArray<PeerLocalAgent>;
  readonly now: number;
}): WorkProjectNode {
  const { status, workspace, state } = input;
  const { work } = state;
  const me = status.email;
  const myName = me === null ? "you" : personName(state, me);
  const t3ProjectIds = new Set(
    state.repositories.flatMap((repo) => (repo.projectId === undefined ? [] : [repo.projectId])),
  );
  const taskOf = (placed: string | undefined, texts: ReadonlyArray<string | null | undefined>) =>
    (placed !== undefined && work.tasks.some((t) => t.id === placed)
      ? placed
      : taskNamedIn(work.tasks, texts)?.id) ?? null;

  const placed: Array<{ readonly task: string | null; readonly node: WorkThreadNode }> = [];
  for (const thread of input.localThreads) {
    if (
      thread.environmentId !== status.environmentId ||
      !t3ProjectIds.has(thread.projectId) ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null
    ) {
      continue;
    }
    const key = `peer:${thread.id}`;
    placed.push({
      task: taskOf(work.assignments[key], [thread.branch, thread.title]),
      node: {
        key,
        title: thread.title,
        person: myName,
        mine: true,
        status: localThreadStatus(thread),
        harness: undefined,
        branch: thread.branch ?? undefined,
        source: "peer",
        stale: false,
        open: { kind: "thread", environmentId: thread.environmentId, threadId: thread.id },
        placeable: true,
      },
    });
  }
  for (const agent of input.agents) {
    if (agent.workspace !== workspace.slug || agent.projectId !== state.project.id) continue;
    placed.push({
      task: taskOf(work.assignments[agent.id], [agent.branch, agent.title]),
      node: {
        key: agent.id,
        title: agent.title,
        person: myName,
        mine: true,
        status: agent.status,
        harness: agent.agent,
        branch: agent.branch,
        source: "herdr",
        stale: false,
        open: { kind: "herdr", paneId: agent.paneId },
        placeable: true,
      },
    });
  }
  for (const thread of work.threads) {
    const seenAt = Date.parse(thread.seenAt);
    placed.push({
      task:
        thread.task !== undefined && work.tasks.some((t) => t.id === thread.task)
          ? thread.task
          : null,
      node: {
        key: `${thread.environment}:${thread.id}`,
        title: thread.title,
        person: personName(state, thread.email),
        mine: thread.email === me,
        status: thread.status,
        harness: thread.harness,
        branch: thread.branch,
        source: thread.source,
        stale: Number.isFinite(seenAt) && input.now - seenAt > STALE_AFTER_MS,
        open: undefined,
        placeable: false,
      },
    });
  }

  const taskNodes = new Map<string, WorkTaskNode>();
  for (const task of work.tasks) {
    const threads = placed
      .filter((entry) => entry.task === task.id)
      .map((entry) => entry.node)
      .toSorted(byActivity);
    taskNodes.set(task.id, {
      id: task.id,
      key: task.key,
      title: task.title,
      done: task.status === "done",
      status: rollup(threads, task.status === "done"),
      threads,
    });
  }
  // Areas the project declares come first, in its order; then those tasks name; then no area.
  const areaNames = [...work.areas];
  for (const task of work.tasks) {
    if (task.area !== undefined && !areaNames.includes(task.area)) areaNames.push(task.area);
  }
  const areas: WorkAreaNode[] = areaNames.map((name) => ({
    name,
    tasks: work.tasks.filter((t) => t.area === name).flatMap((t) => taskNodes.get(t.id) ?? []),
  }));
  const loose = work.tasks.filter((t) => t.area === undefined);
  if (loose.length > 0) {
    areas.push({ name: null, tasks: loose.flatMap((t) => taskNodes.get(t.id) ?? []) });
  }
  return {
    workspace: workspace.slug,
    workspaceName: workspace.name,
    projectId: state.project.id,
    name: state.project.name,
    areas,
    unsorted: placed
      .filter((entry) => entry.task === null)
      .map((entry) => entry.node)
      .toSorted(byActivity),
    tasks: work.tasks,
    checkedOut: state.repositories.some((repo) => repo.state === "ready"),
  };
}

/** Every workspace project this person is on, as a tree. */
export function buildWorkTree(input: {
  readonly status: PeerHubStatus;
  readonly localThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: number;
}): ReadonlyArray<WorkProjectNode> {
  return input.status.workspaces.flatMap((workspace) =>
    workspace.projects.map((state) =>
      projectTree({
        status: input.status,
        workspace,
        state,
        localThreads: input.localThreads,
        agents: input.status.agents.list,
        now: input.now,
      }),
    ),
  );
}

export interface ActiveAgentNode {
  readonly key: string;
  readonly title: string;
  readonly status: PeerWorkStatus;
  readonly harness: string | undefined;
  /** The project it works in, when there is one. */
  readonly where: string | undefined;
  readonly open: WorkOpen;
}

/**
 * What runs on this computer right now and may need you: herdr's agents
 * (whatever started them) and this computer's threads that are working or
 * waiting on an answer. Blocked first.
 */
export function activeAgents(input: {
  readonly status: PeerHubStatus | null;
  readonly localThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly localEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<ActiveAgentNode> {
  const agents: ActiveAgentNode[] = [];
  const projectTitle = (workspace: string | undefined, projectId: string | undefined) =>
    workspace === undefined || projectId === undefined
      ? undefined
      : input.status?.workspaces
          .find((w) => w.slug === workspace)
          ?.projects.find((p) => p.project.id === projectId)?.project.name;
  for (const agent of input.status?.agents.list ?? []) {
    if (agent.status === "idle") continue;
    agents.push({
      key: agent.id,
      title: agent.title,
      status: agent.status,
      harness: agent.agent,
      where: projectTitle(agent.workspace, agent.projectId) ?? agent.cwd?.split("/").at(-1),
      open: { kind: "herdr", paneId: agent.paneId },
    });
  }
  for (const thread of input.localThreads) {
    if (input.localEnvironmentId !== null && thread.environmentId !== input.localEnvironmentId) {
      continue;
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const status = localThreadStatus(thread);
    if (status !== "working" && status !== "blocked") continue;
    agents.push({
      key: `peer:${thread.id}`,
      title: thread.title,
      status,
      harness: undefined,
      where: input.projectNames.get(`${thread.environmentId}:${thread.projectId}`),
      open: { kind: "thread", environmentId: thread.environmentId, threadId: thread.id },
    });
  }
  return agents.toSorted(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title),
  );
}
