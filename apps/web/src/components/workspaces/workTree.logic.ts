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
  ContextMenuItem,
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
  /** A herdr agent opens in Peer's agent view; its pane is where herdr shows it. */
  | { readonly kind: "herdr"; readonly agentId: string; readonly paneId: string }
  /** A thread on another computer whose owner shares it opens read-only, relayed by the hub. */
  | {
      readonly kind: "observe";
      readonly workspace: string;
      readonly environment: string;
      readonly thread: string;
    };

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
  /** Why a colleague's thread concerns you, e.g. its agent overlaps with yours. */
  readonly concerns: string | undefined;
  /** Its owner lets the team watch it live: yours when you shared it, a colleague's to observe. */
  readonly observable: boolean;
  /**
   * The agent that runs it: this computer's provider instance and model for a
   * Peer thread here, else the harness name (claude, codex, …) it reported.
   */
  readonly agent: WorkAgent | undefined;
  /** When it was last active, for threads on this computer. */
  readonly activeAt: string | undefined;
  /** Its agent keeps the shared context of the work it is on. */
  readonly keepsContext: boolean;
}

export type WorkAgent =
  | { readonly instanceId: string; readonly model: string }
  | { readonly harness: string };

export interface WorkTaskNode {
  readonly id: string;
  readonly key: string | undefined;
  readonly title: string;
  readonly done: boolean;
  /** What the task's threads add up to: blocked beats working beats the rest. */
  readonly status: PeerWorkStatus;
  readonly threads: ReadonlyArray<WorkThreadNode>;
  /** Its creator, the project's leads and the workspace's admins may remove it. */
  readonly removable: boolean;
  /** Its shared context, once an agent on it started one. */
  readonly context: WorkContextNode | undefined;
}

/**
 * A task's shared context (or a project's, for work on no task): kept by one
 * agent session at a time, read by the other agents on it and by people.
 */
export interface WorkContextNode {
  readonly workspace: string;
  readonly project: string;
  /** `task:<id>`, or `project`. */
  readonly scope: string;
  readonly version: number;
  /** Where the work stands, in a line, as its keeper put it. */
  readonly gist: string | undefined;
  /** About how many tokens its text takes. */
  readonly tokens: number;
  /** The agent keeping it, while that agent reports. */
  readonly keeper:
    | {
        readonly person: string;
        readonly mine: boolean;
        readonly session: string;
        /** What its session is called: the thread's title or the agent's first prompt. */
        readonly label: string | undefined;
        readonly since: string;
      }
    | undefined;
  readonly updatedAt: string;
  /** Who wrote the version there is: the keeper's person, or the person who brought an older one back. */
  readonly updatedBy: string | undefined;
  /** The older version a person brought back, when that is what the version there is. */
  readonly restoredFrom: number | undefined;
  /** What the work's agents found since it last changed: for its keeper to fold in, newest first. */
  readonly reports: ReadonlyArray<{
    readonly id: string;
    readonly person: string;
    readonly text: string;
    readonly at: string;
  }>;
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
  /** The shared context of the project's work on no task. */
  readonly context: WorkContextNode | undefined;
  /** Knowledge candidates waiting for people to keep or dismiss. */
  readonly candidates: number;
  readonly tasks: ReadonlyArray<PeerTask>;
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

/** Your own threads first, then what needs attention. */
function byActivity(a: WorkThreadNode, b: WorkThreadNode): number {
  return (
    Number(b.mine) - Number(a.mine) ||
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    a.title.localeCompare(b.title)
  );
}

function rollup(threads: ReadonlyArray<WorkThreadNode>, done: boolean): PeerWorkStatus {
  if (threads.some((t) => t.status === "blocked")) return "blocked";
  if (threads.some((t) => t.status === "working")) return "working";
  if (done || (threads.length > 0 && threads.every((t) => t.status === "done"))) return "done";
  return "idle";
}

/** A member as people call them: their name in the project, else the start of their address. */
export function personName(project: PeerProjectState, email: string): string {
  return (
    project.project.members.find((m) => m.email === email)?.name ?? email.split("@")[0] ?? email
  );
}

/** A shared context as the tree shows it, with what was found on its work since it last changed. */
function contextNode(
  status: PeerHubStatus,
  workspace: string,
  state: PeerProjectState,
  scope: string,
): WorkContextNode | undefined {
  const project = state.project.id;
  const context = status.coordination.contexts.find(
    (c) => c.workspace === workspace && c.project === project && c.scope === scope,
  );
  if (context === undefined) return undefined;
  const keeper = context.keeper;
  const keeping =
    keeper === undefined
      ? undefined
      : status.coordination.sessions.find((session) => session.id === keeper.session);
  const since = context.version === 0 ? 0 : Date.parse(context.updatedAt);
  return {
    workspace,
    project,
    scope,
    version: context.version,
    gist: context.gist,
    tokens: Math.round(context.bytes / 4),
    keeper:
      keeper === undefined || keeping === undefined
        ? undefined
        : {
            person: personName(state, keeper.email),
            mine: keeper.email === status.email,
            session: keeper.session,
            label: keeping.label,
            since: keeper.since,
          },
    updatedAt: context.updatedAt,
    updatedBy: context.updatedBy === undefined ? undefined : personName(state, context.updatedBy),
    restoredFrom: context.restoredFrom,
    reports: status.coordination.findings
      .filter(
        (finding) =>
          finding.workspace === workspace &&
          finding.project === project &&
          (finding.task === undefined ? "project" : `task:${finding.task}`) === scope &&
          Date.parse(finding.at) > since,
      )
      .map((finding) => ({
        id: finding.id,
        person: personName(state, finding.email),
        text: finding.text,
        at: finding.at,
      })),
  };
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

  const shared = new Set(status.sharedThreads);
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
        concerns: undefined,
        observable: shared.has(key),
        agent: {
          instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
          model: thread.modelSelection.model,
        },
        activeAt: thread.latestUserMessageAt ?? thread.updatedAt,
        keepsContext: false,
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
        open: { kind: "herdr", agentId: agent.id, paneId: agent.paneId },
        placeable: true,
        concerns: undefined,
        observable: shared.has(agent.id),
        agent: agent.agent === undefined ? undefined : { harness: agent.agent },
        activeAt: undefined,
        keepsContext: false,
      },
    });
  }
  // A colleague's agent in an open overlap with one of yours concerns you.
  const yours = new Set(
    status.coordination.sessions
      .filter((session) => session.email === me)
      .map((session) => session.id),
  );
  const overlapping = new Map<string, string>();
  for (const overlap of status.coordination.overlaps) {
    if (
      overlap.state !== "open" ||
      overlap.workspace !== workspace.slug ||
      overlap.project !== state.project.id
    ) {
      continue;
    }
    const [a, b] = overlap.sessions;
    if (a === undefined || b === undefined || yours.has(a) === yours.has(b)) continue;
    overlapping.set(yours.has(a) ? b : a, overlap.files.join(", "));
  }
  for (const thread of work.threads) {
    const seenAt = Date.parse(thread.seenAt);
    // A herdr agent known by its session reports `herdr:<agent>:<session>`; coordination says `<agent>:<session>`.
    const session = /^herdr:([^:]+:.+)$/.exec(thread.id)?.[1];
    const files = session === undefined ? undefined : overlapping.get(session);
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
        open:
          thread.observable === true
            ? {
                kind: "observe",
                workspace: workspace.slug,
                environment: thread.environment,
                thread: thread.id,
              }
            : undefined,
        placeable: false,
        concerns:
          files === undefined || thread.email === me
            ? undefined
            : `Its agent and yours both change ${files}`,
        observable: thread.observable === true,
        agent: thread.harness === undefined ? undefined : { harness: thread.harness },
        activeAt: undefined,
        keepsContext: false,
      },
    });
  }

  // A herdr agent's thread is known by its session (`herdr:claude:<id>`, after its computer for a
  // colleague's), the keeper by the session alone.
  const keeping = (context: WorkContextNode | undefined) => (node: WorkThreadNode) =>
    context?.keeper !== undefined &&
    /(?:^|:)herdr:(.+)$/.exec(node.key)?.[1] === context.keeper.session
      ? { ...node, keepsContext: true }
      : node;
  const taskNodes = new Map<string, WorkTaskNode>();
  for (const task of work.tasks) {
    const context = contextNode(status, workspace.slug, state, `task:${task.id}`);
    const threads = placed
      .filter((entry) => entry.task === task.id)
      .map((entry) => keeping(context)(entry.node))
      .toSorted(byActivity);
    taskNodes.set(task.id, {
      id: task.id,
      key: task.key,
      title: task.title,
      done: task.status === "done",
      status: rollup(threads, task.status === "done"),
      threads,
      removable:
        task.createdBy === me || state.project.role === "lead" || workspace.role !== "member",
      context,
    });
  }
  const projectContext = contextNode(status, workspace.slug, state, "project");
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
      .map((entry) => keeping(projectContext)(entry.node))
      .toSorted(byActivity),
    context: projectContext,
    candidates:
      status.coordination.candidates.find(
        (waiting) => waiting.workspace === workspace.slug && waiting.project === state.project.id,
      )?.proposed ?? 0,
    tasks: work.tasks,
  };
}

/** What Peer told one agent, as the work's page lists it. */
export interface WorkAdviceRow {
  readonly key: string;
  /** Whose agent was told, and what it is called. */
  readonly person: string;
  readonly mine: boolean;
  readonly agent: string;
  readonly about: "work" | "knowledge";
  /** A work's scope to open its page, or `kx:<id>` for an entry of the project's knowledge. */
  readonly scope: string;
  readonly name: string;
  readonly level: number;
  readonly kind: "new" | "closer" | "changed";
  readonly why: string;
  readonly source: "words" | "paths" | "model";
  /** For knowledge: decision, convention, learning or incident, and where its file is. */
  readonly entryKind: string | undefined;
  readonly path: string | undefined;
  readonly at: string;
}

/**
 * What Peer told the agents on one work (a task, or the project's work on no task) of related work
 * and of the project's knowledge, newest first: people see what their agents are pointed to.
 */
export function adviceOnWork(input: {
  readonly status: PeerHubStatus;
  readonly workspace: string;
  readonly project: string;
  readonly scope: string;
}): ReadonlyArray<WorkAdviceRow> {
  const { status, workspace, project, scope } = input;
  const state = status.workspaces
    .find((w) => w.slug === workspace)
    ?.projects.find((p) => p.project.id === project);
  const sessions = new Map(status.coordination.sessions.map((session) => [session.id, session]));
  return (status.coordination.advice ?? [])
    .flatMap((advice) => {
      const session = sessions.get(advice.session);
      if (advice.workspace !== workspace || advice.project !== project || session === undefined) {
        return [];
      }
      const on = session.task === undefined ? "project" : `task:${session.task}`;
      if (on !== scope) return [];
      return [
        {
          key: `${advice.session}:${advice.scope}:${advice.at}`,
          person: state === undefined ? session.email : personName(state, session.email),
          mine: session.email === status.email,
          agent: session.label,
          about: advice.about,
          scope: advice.scope,
          name: advice.name,
          level: advice.level,
          kind: advice.kind,
          why: advice.why,
          source: advice.source,
          entryKind: advice.entryKind,
          path: advice.path,
          at: advice.at,
        } satisfies WorkAdviceRow,
      ];
    })
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, 12);
}

/** What one telling says, in a line: whose agent, and what happened. */
export function adviceLabel(row: WorkAdviceRow): string {
  const who = row.mine ? "Your agent" : `${row.person}’s agent`;
  const what =
    row.about === "knowledge"
      ? `was reminded of ${row.entryKind === undefined ? "an entry" : `a ${row.entryKind}`} of the project`
      : row.kind === "closer"
        ? "was told this work came closer to its own"
        : row.kind === "changed"
          ? "heard this work said more where it bears on its own"
          : "was pointed to this related work";
  const how =
    row.source === "model"
      ? " (a model that read both said so)"
      : row.source === "paths"
        ? " (it governs files the agent works on)"
        : "";
  return `${who} ${what}${how}`;
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

/** Why an agent waits on you: an approval, an answer, or finished work to look at. */
export type AgentNeed = "approval" | "input" | "review";

export interface ActiveAgentNode {
  readonly key: string;
  readonly title: string;
  readonly status: PeerWorkStatus;
  readonly harness: string | undefined;
  /** The project it works in, and its task there, when there are. */
  readonly where: string | undefined;
  readonly open: WorkOpen;
  /** Set while it waits on you; unset while it just works. */
  readonly needs: AgentNeed | undefined;
  readonly agent: WorkAgent | undefined;
}

const NEED_ORDER: Readonly<Record<AgentNeed, number>> = { approval: 0, input: 1, review: 2 };

/**
 * What on this computer needs you, and what just runs: herdr's agents
 * (whatever started them) and this computer's threads. An agent needs you
 * while it waits for an approval or an answer, and once it finished work you
 * have not looked at yet; working ones are not news.
 */
export function activeAgents(input: {
  readonly status: PeerHubStatus | null;
  readonly localThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly localEnvironmentId: EnvironmentId | null;
  /** A thread finished work its owner has not opened since. */
  readonly unseen: (thread: EnvironmentThreadShell) => boolean;
  /** Thread key (`peer:<id>`, `herdr:<id>`) → the task it is on, as the work tree places it. */
  readonly taskOf?: ReadonlyMap<string, string>;
}): ReadonlyArray<ActiveAgentNode> {
  const agents: ActiveAgentNode[] = [];
  const place = (key: string, project: string | undefined) => {
    const parts = [project, input.taskOf?.get(key)].filter((part) => part !== undefined);
    return parts.length === 0 ? undefined : parts.join(" · ");
  };
  const projectTitle = (workspace: string | undefined, projectId: string | undefined) =>
    workspace === undefined || projectId === undefined
      ? undefined
      : input.status?.workspaces
          .find((w) => w.slug === workspace)
          ?.projects.find((p) => p.project.id === projectId)?.project.name;
  for (const agent of input.status?.agents.list ?? []) {
    // herdr says "done" for finished work nobody has looked at, "idle" once someone has.
    const needs =
      agent.status === "blocked" ? "input" : agent.status === "done" ? "review" : undefined;
    if (needs === undefined && agent.status !== "working") continue;
    agents.push({
      key: agent.id,
      title: agent.title,
      status: agent.status,
      harness: agent.agent,
      where: place(
        agent.id,
        projectTitle(agent.workspace, agent.projectId) ?? agent.cwd?.split("/").at(-1),
      ),
      open: { kind: "herdr", agentId: agent.id, paneId: agent.paneId },
      needs,
      agent: agent.agent === undefined ? undefined : { harness: agent.agent },
    });
  }
  for (const thread of input.localThreads) {
    if (input.localEnvironmentId !== null && thread.environmentId !== input.localEnvironmentId) {
      continue;
    }
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    const status = localThreadStatus(thread);
    const needs: AgentNeed | undefined = thread.hasPendingApprovals
      ? "approval"
      : thread.hasPendingUserInput
        ? "input"
        : status !== "working" && input.unseen(thread)
          ? "review"
          : undefined;
    if (needs === undefined && status !== "working") continue;
    const key = `peer:${thread.id}`;
    agents.push({
      key,
      title: thread.title,
      status,
      harness: undefined,
      where: place(key, input.projectNames.get(`${thread.environmentId}:${thread.projectId}`)),
      open: { kind: "thread", environmentId: thread.environmentId, threadId: thread.id },
      needs,
      agent: {
        instanceId: thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId,
        model: thread.modelSelection.model,
      },
    });
  }
  const rank = (agent: ActiveAgentNode) =>
    agent.needs === undefined ? 3 + STATUS_ORDER[agent.status] : NEED_ORDER[agent.needs];
  return agents.toSorted((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** A context's size the way people read it: `~2.1k tokens`. */
export function contextSize(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

/** A task the way lists and menus name it: `KRK-812 · Split Payments`. */
export function taskLabel(task: { readonly key?: string | undefined; readonly title: string }) {
  return task.key ? `${task.key} · ${task.title}` : task.title;
}

export type WorkThreadMenuId =
  | "rename"
  | "share"
  | "unshare"
  | "show-in-herdr"
  | "move"
  | `task:${string}`
  | "unassign"
  | "archive"
  | "delete";

/**
 * What a thread's menu offers. Only your own work on this computer changes
 * from here: a colleague's thread, or yours on another computer, is read-only.
 * herdr owns its agents' names and lifetimes, so those only move between tasks.
 */
export function threadMenuItems(input: {
  readonly thread: WorkThreadNode;
  readonly tasks: ReadonlyArray<PeerTask>;
  /** The task the thread sits under now, null when on none. */
  readonly taskId: string | null;
  /** Archive refuses a thread whose agent is still attached. */
  readonly running: boolean;
}): ReadonlyArray<ContextMenuItem<WorkThreadMenuId>> {
  const { thread, taskId } = input;
  if (!thread.mine || thread.open === undefined || thread.open.kind === "observe") return [];
  const local = thread.open.kind === "thread";
  const choices = input.tasks.filter((task) => task.status === "open" || task.id === taskId);
  return [
    local
      ? { id: "rename", label: "Rename thread", icon: "pencil" }
      : { id: "show-in-herdr", label: "Show in herdr" },
    ...(thread.placeable
      ? [
          {
            id: "move" as const,
            label: "Move to task",
            icon: "folder-tree",
            children: [
              ...choices.map((task) => ({
                id: `task:${task.id}` as const,
                label: taskLabel(task),
                checked: task.id === taskId,
              })),
              {
                id: "unassign" as const,
                label: "Not on a task",
                checked: taskId === null,
                separatorBefore: choices.length > 0,
              },
            ],
          },
        ]
      : []),
    thread.observable
      ? { id: "unshare" as const, label: "Stop letting the team watch" }
      : { id: "share" as const, label: "Let the team watch" },
    ...(local
      ? [
          {
            id: "archive" as const,
            label: "Archive thread",
            icon: "archive",
            disabled: input.running,
            separatorBefore: true,
          },
          { id: "delete" as const, label: "Delete", icon: "trash", destructive: true },
        ]
      : []),
  ];
}

export type WorkTaskMenuId = "new-thread" | "rename" | "toggle-done" | "remove";

/** What a task's menu offers. Anyone on the project renames or closes a task. */
export function taskMenuItems(input: {
  readonly task: WorkTaskNode;
  /** A new thread needs the project's checkout on this computer. */
  readonly canStartThread: boolean;
}): ReadonlyArray<ContextMenuItem<WorkTaskMenuId>> {
  return [
    {
      id: "new-thread",
      label: "New thread on this task",
      icon: "message-square-plus",
      disabled: !input.canStartThread,
    },
    { id: "rename", label: "Rename task", icon: "pencil", separatorBefore: true },
    {
      id: "toggle-done",
      label: input.task.done ? "Reopen task" : "Mark done",
      icon: "circle-check",
    },
    ...(input.task.removable
      ? [
          {
            id: "remove" as const,
            label: "Remove task",
            icon: "trash",
            destructive: true,
            separatorBefore: true,
          },
        ]
      : []),
  ];
}
