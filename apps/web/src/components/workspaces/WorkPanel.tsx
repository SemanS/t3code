import {
  isProviderDriverKind,
  ProviderDriverKind,
  type ContextMenuItem,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type PeerHubStatus,
  type PeerProjectState,
  type PeerTask,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  threadRuntimeCanArchive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { settlePromise, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  EllipsisIcon,
  EyeIcon,
  FileTextIcon,
  LightbulbIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  Share2Icon,
  ShieldQuestionIcon,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { readThreadShell, useProjects, useThreadShells } from "../../state/entities";
import {
  deriveProviderEntriesByEnvironment,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentMachines, usePrimaryEnvironment } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ThreadHoverCard, ThreadHoverCardPopup } from "../ThreadHoverCard";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { OverlapList } from "./Coordination";
import { STATUS_LABEL, STATUS_TONE, StatusGlyph, StatusIcon } from "./workStatus";
import { GitHubConnect } from "./GitHubConnect";
import {
  projectCheckout,
  useOpenWorkspaceProject,
  type ProjectCheckout,
} from "./useOpenWorkspaceProject";
import { failureMessage, usePeerHubStatus } from "./WorkspaceAccess";
import { StartTaskAgent } from "./StartTaskAgent";
import {
  activeAgents,
  buildWorkTree,
  contextSize,
  taskLabel,
  taskMenuItems,
  threadMenuItems,
  type ActiveAgentNode,
  type AgentNeed,
  type WorkAgent,
  type WorkContextNode,
  type WorkOpen,
  type WorkProjectNode,
  type WorkTaskNode,
  type WorkThreadNode,
} from "./workTree.logic";

/** Who a thread belongs to: you in the accent color, a colleague in a quiet outline. */
function PersonMark({ name, mine }: { readonly name: string; readonly mine: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full text-3xs font-semibold",
        mine
          ? "bg-primary text-primary-foreground"
          : "border border-sidebar-border bg-sidebar text-muted-foreground",
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/** What a card needs to know of this computer: its provider instances, and its name and kind. */
interface WorkHere {
  readonly providers: ReadonlyMap<string, ProviderInstanceEntry>;
  readonly label: string | null;
  readonly machine: EnvironmentMachineKind;
}

const WorkHereContext = createContext<WorkHere>({
  providers: new Map(),
  label: null,
  machine: "laptop",
});

/** Harness names agents report, as the drivers whose icons the Threads list draws. */
const HARNESS_DRIVER: Readonly<Record<string, string>> = {
  claude: "claudeAgent",
  "claude-code": "claudeAgent",
  codex: "codex",
  cursor: "cursor",
  "cursor-agent": "cursor",
  opencode: "opencode",
  grok: "grok",
  antigravity: "antigravity",
  pi: "pi",
};

interface AgentLook {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  /** The model, as the Threads list names it. */
  readonly model: string | undefined;
}

/** How a thread's agent looks: this computer's provider instance, or a reported harness. */
function agentLook(
  agent: WorkAgent | undefined,
  providers: ReadonlyMap<string, ProviderInstanceEntry>,
): AgentLook | null {
  if (agent === undefined) return null;
  if ("instanceId" in agent) {
    const entry = providers.get(agent.instanceId);
    if (entry === undefined) return null;
    const model = entry.models.find((candidate) => candidate.slug === agent.model);
    return {
      driverKind: entry.driverKind,
      displayName: entry.displayName,
      accentColor: entry.accentColor,
      acpRegistryAgentId: entry.acpRegistryAgentId,
      acpRegistryIconUrl: entry.acpRegistryIconUrl,
      model: model === undefined ? agent.model : getTriggerDisplayModelLabel(model),
    };
  }
  const name = agent.harness.trim().toLowerCase();
  const slug = HARNESS_DRIVER[name] ?? name;
  return {
    driverKind: isProviderDriverKind(slug) ? slug : ProviderDriverKind.make("agent"),
    displayName: agent.harness,
    model: undefined,
  };
}

/** The agent's mark, where the Threads list draws it. */
function AgentMark({ look }: { readonly look: AgentLook | null }) {
  if (look === null) return null;
  return (
    <ProviderInstanceIcon
      driverKind={look.driverKind}
      displayName={look.displayName}
      accentColor={look.accentColor}
      acpRegistryAgentId={look.acpRegistryAgentId}
      acpRegistryIconUrl={look.acpRegistryIconUrl}
      iconClassName="size-3.5 opacity-60"
    />
  );
}

/** "17h", "now": when a thread was last active, as the Threads list says it. */
function activeLabel(at: string | undefined): string | null {
  if (at === undefined) return null;
  const label = formatRelativeTimeLabel(at);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  const message = failureMessage(result);
  if (message !== null) {
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }
  return message === null;
}

export async function confirmed(message: string, destructive = false): Promise<boolean> {
  const api = readLocalApi();
  if (api === undefined) return true;
  const answer = await settlePromise(() =>
    api.dialogs.confirm(message, destructive ? { variant: "destructive" } : undefined),
  );
  return answer._tag === "Success" && answer.value;
}

interface MenuPosition {
  readonly x: number;
  readonly y: number;
}

/** Shows a menu through the bridge the Threads list uses: native on desktop. */
async function pickFromMenu<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  position: MenuPosition,
): Promise<T | null> {
  const api = readLocalApi();
  if (api === undefined || items.length === 0) return null;
  const picked = await settlePromise(() => api.contextMenu.show(items, position));
  return picked._tag === "Success" ? picked.value : null;
}

function below(event: ReactMouseEvent<HTMLElement>): MenuPosition {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}

type ThreadOpen = Extract<WorkOpen, { readonly kind: "thread" }>;

interface Scope {
  readonly workspace: string;
  readonly projectId: string;
}

/**
 * Everything the tree does to threads and tasks, set up once for the panel:
 * opening, renaming, archiving and deleting your threads, placing them on
 * tasks, and the tasks' own changes.
 */
export function useWorkActions(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const focusAgent = useAtomCommand(serverEnvironment.peerHubFocusAgent, { reportFailure: false });
  const shareThread = useAtomCommand(serverEnvironment.peerHubShareThread, {
    reportFailure: false,
  });
  const assignThread = useAtomCommand(serverEnvironment.peerHubAssignThread, {
    reportFailure: false,
  });
  const updateTask = useAtomCommand(serverEnvironment.peerHubUpdateTask, { reportFailure: false });
  const deleteTask = useAtomCommand(serverEnvironment.peerHubDeleteTask, { reportFailure: false });
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const openNewThread = useNewThreadHandler();
  const { archiveThread, confirmAndDeleteThread } = useThreadActions();
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);

  return {
    /** Opens a local thread, or a herdr agent in Peer's agent view. */
    open: (open: WorkOpen) => {
      if (open.kind === "thread") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(open.environmentId, open.threadId)),
        });
        return;
      }
      if (open.kind === "observe") {
        void navigate({
          to: "/observe/$workspace/$environment/$thread",
          params: { workspace: open.workspace, environment: open.environment, thread: open.thread },
        });
        return;
      }
      void navigate({ to: "/agent/$agentId", params: { agentId: open.agentId } });
    },
    /** Lets the team watch one of your threads live, or stops it. */
    shareThread: async (thread: string, shared: boolean) => {
      if (environmentId === null) return;
      reportFailure(
        shared ? "Could not share the thread" : "Could not stop sharing the thread",
        await shareThread({ environmentId, input: { thread, shared } }),
      );
    },
    /** Brings a herdr agent's pane forward in herdr itself. */
    showInHerdr: (paneId: string) => {
      if (environmentId === null) return;
      void focusAgent({ environmentId, input: { paneId } }).then((result) =>
        reportFailure("Could not show that agent in herdr", result),
      );
    },
    renameThread: async (open: ThreadOpen, title: string, before: string) => {
      const trimmed = title.trim();
      if (trimmed === "" || trimmed === before) return;
      reportFailure(
        "Could not rename the thread",
        await updateThreadMetadata({
          environmentId: open.environmentId,
          input: { threadId: open.threadId, title: trimmed },
        }),
      );
    },
    archiveThread: async (open: ThreadOpen, title: string) => {
      if (confirmThreadArchive && !(await confirmed(`Archive thread "${title}"?`))) return;
      reportFailure(
        "Could not archive the thread",
        await archiveThread(scopeThreadRef(open.environmentId, open.threadId)),
      );
    },
    deleteThread: async (open: ThreadOpen) => {
      const ref = scopeThreadRef(open.environmentId, open.threadId);
      const result = await confirmAndDeleteThread(ref);
      // Once the thread is gone, a failure is its worktree's cleanup, which reports itself.
      if (readThreadShell(ref) !== null) reportFailure("Could not delete the thread", result);
    },
    placeThread: async (scope: Scope, thread: string, taskId: string | null) => {
      if (environmentId === null) return;
      reportFailure(
        "Could not move the thread",
        await assignThread({ environmentId, input: { ...scope, thread, taskId } }),
      );
    },
    startThread: async (scope: Scope, taskId: string, projectId: ProjectId) => {
      if (environmentId === null) return;
      const draft = await openNewThread(scopeProjectRef(environmentId, projectId));
      if (draft === null) return;
      // The draft already knows the id its thread will have, so the thread starts under the task.
      reportFailure(
        "Could not put the new thread under the task",
        await assignThread({
          environmentId,
          input: { ...scope, thread: `peer:${draft.threadId}`, taskId },
        }),
      );
    },
    renameTask: async (scope: Scope, task: WorkTaskNode, title: string) => {
      const trimmed = title.trim();
      if (environmentId === null || trimmed === "" || trimmed === task.title) return;
      reportFailure(
        "Could not rename the task",
        await updateTask({ environmentId, input: { ...scope, taskId: task.id, title: trimmed } }),
      );
    },
    setTaskDone: async (scope: Scope, task: WorkTaskNode, done: boolean) => {
      if (environmentId === null) return;
      reportFailure(
        `Could not update ${taskLabel(task)}`,
        await updateTask({
          environmentId,
          input: { ...scope, taskId: task.id, status: done ? "done" : "open" },
        }),
      );
    },
    removeTask: async (scope: Scope, task: WorkTaskNode) => {
      if (environmentId === null) return;
      const sure = await confirmed(
        [
          `Remove task "${taskLabel(task)}" for everyone on the project?`,
          "Its threads stay, on no task.",
        ].join("\n"),
        true,
      );
      if (!sure) return;
      reportFailure(
        `Could not remove ${taskLabel(task)}`,
        await deleteTask({ environmentId, input: { ...scope, taskId: task.id } }),
      );
    },
  };
}

type WorkActions = ReturnType<typeof useWorkActions>;

/** What the open route shows, in the terms of `WorkOpen`, to highlight it in the tree. */
function openKey(open: WorkOpen): string {
  return open.kind === "thread"
    ? `${open.environmentId}:${open.threadId}`
    : open.kind === "herdr"
      ? `agent:${open.agentId}`
      : `observe:${open.workspace}:${open.environment}:${open.thread}`;
}

/**
 * The sidebar's Work view: what runs on this computer right now, then each
 * workspace project as Project → Area → Task → Threads, everyone's threads
 * with their person as metadata.
 */
export function WorkPanel() {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const threads = useThreadShells();
  const projects = useProjects();
  const now = useRelativeTimeTick(30_000);
  const actions = useWorkActions(environmentId);
  const activeThread = useParams({
    strict: false,
    select: (params) =>
      params.agentId
        ? `agent:${params.agentId}`
        : params.workspace && params.project && params.scope
          ? `context:${params.workspace}:${params.project}:${params.scope}`
          : params.workspace && params.project
            ? `knowledge:${params.workspace}:${params.project}`
            : params.workspace && params.environment && params.thread
              ? `observe:${params.workspace}:${params.environment}:${params.thread}`
              : params.environmentId && params.threadId
                ? `${params.environmentId}:${params.threadId}`
                : null,
  });
  const tree = useMemo(
    () => (status === null ? [] : buildWorkTree({ status, localThreads: threads, now })),
    [now, status, threads],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.title] as const)),
    [projects],
  );
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const machines = useEnvironmentMachines();
  const here = useMemo<WorkHere>(
    () => ({
      providers:
        environmentId === null
          ? new Map()
          : (deriveProviderEntriesByEnvironment(
              [...serverConfigs].map(
                ([id, config]) => [id, config.providers, config.settings] as const,
              ),
            ).get(environmentId) ?? new Map()),
      label: primary?.label ?? null,
      machine: (environmentId === null ? undefined : machines.get(environmentId)) ?? "laptop",
    }),
    [environmentId, machines, primary?.label, serverConfigs],
  );
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const unseen = useCallback(
    (thread: EnvironmentThreadShell) =>
      hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          visited[scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))],
        ),
      }),
    [visited],
  );
  const taskOf = useMemo(
    () =>
      new Map(
        tree.flatMap((project) =>
          project.areas.flatMap((area) =>
            area.tasks.flatMap((task) =>
              task.threads.map((thread) => [thread.key, taskLabel(task)] as const),
            ),
          ),
        ),
      ),
    [tree],
  );
  const agents = useMemo(
    () =>
      activeAgents({
        status,
        localThreads: threads,
        projectNames,
        localEnvironmentId: environmentId,
        unseen,
        taskOf,
      }),
    [environmentId, projectNames, status, taskOf, threads, unseen],
  );

  return (
    <WorkHereContext.Provider value={here}>
      <div className="flex flex-col gap-4 pb-6">
        {environmentId !== null && status !== null && status.signedIn ? (
          <OverlapList environmentId={environmentId} status={status} />
        ) : null}
        <NeedsYou
          agents={agents}
          herdr={status?.agents.herdr ?? null}
          activeThread={activeThread}
          onOpen={actions.open}
        />
        {environmentId === null || status === null ? (
          <p className="px-2 text-xs text-muted-foreground">Connecting…</p>
        ) : !status.signedIn ? (
          <NotSignedIn />
        ) : tree.length === 0 ? (
          <p className="px-2 text-xs leading-relaxed text-muted-foreground">
            {status.workspaces.length === 0
              ? "Join or create a workspace in Settings → Workspaces to work with your team."
              : "No projects yet. Share one below, and everyone in the workspace can work on it."}
          </p>
        ) : (
          tree.map((project) => (
            <ProjectSection
              key={`${project.workspace}/${project.projectId}`}
              environmentId={environmentId}
              status={status}
              project={project}
              showWorkspace={status.workspaces.length > 1}
              activeThread={activeThread}
              actions={actions}
            />
          ))
        )}
        {environmentId !== null && status?.signedIn && status.workspaces.length > 0 ? (
          <ShareProject environmentId={environmentId} status={status} />
        ) : null}
      </div>
    </WorkHereContext.Provider>
  );
}

function NotSignedIn() {
  const navigate = useNavigate();
  return (
    <div className="px-2 text-xs leading-relaxed text-muted-foreground">
      <p>Sign in with your work email to see your team’s projects, tasks and agents.</p>
      <Button
        className="mt-2"
        size="xs"
        variant="outline"
        onClick={() => void navigate({ to: "/settings/workspaces" })}
      >
        Open Workspaces
      </Button>
    </div>
  );
}

function SectionLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </p>
  );
}

const NEED: Readonly<
  Record<AgentNeed, { readonly label: string; readonly icon: LucideIcon; readonly tone: string }>
> = {
  approval: { label: "Needs approval", icon: ShieldQuestionIcon, tone: "text-warning-foreground" },
  input: { label: "Needs input", icon: MessageCircleQuestionIcon, tone: "text-warning-foreground" },
  review: { label: "Finished", icon: CircleCheckIcon, tone: "text-success" },
};

/**
 * What on this computer waits on you — an approval, an answer, finished work
 * to look at — with what merely runs folded away below it.
 */
function NeedsYou({
  agents,
  herdr,
  activeThread,
  onOpen,
}: {
  readonly agents: ReadonlyArray<ActiveAgentNode>;
  readonly herdr: PeerHubStatus["agents"]["herdr"] | null;
  readonly activeThread: string | null;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  const [showRunning, setShowRunning] = useState(false);
  const waiting = agents.filter((agent) => agent.needs !== undefined);
  const running = agents.filter((agent) => agent.needs === undefined);
  return (
    <section aria-label="Needs you">
      <SectionLabel>Needs you{waiting.length > 0 ? ` · ${waiting.length}` : ""}</SectionLabel>
      {waiting.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          {running.length > 0 || herdr === "running"
            ? "Nothing needs you right now."
            : "Nothing needs you. Agents you run in herdr (herdr.dev) show up here too."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {waiting.map((agent) => (
            <NeedCard
              key={agent.key}
              agent={agent}
              active={activeThread === openKey(agent.open)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      {running.length > 0 ? (
        <>
          <button
            type="button"
            className="mt-1 flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover"
            aria-expanded={showRunning}
            onClick={() => setShowRunning((value) => !value)}
          >
            <ChevronRightIcon className={cn("size-3 shrink-0", showRunning && "rotate-90")} />
            <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-info" />
            {running.length === 1 ? "1 agent working" : `${running.length} agents working`}
          </button>
          {showRunning ? (
            <ul className="flex flex-col gap-px">
              {running.map((agent) => (
                <li key={agent.key}>
                  <button
                    type="button"
                    className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover"
                    onClick={() => onOpen(agent.open)}
                  >
                    <StatusGlyph status={agent.status} />
                    <span className="min-w-0 flex-1 truncate">{agent.title}</span>
                    <span className="shrink-0 truncate text-xs text-muted-foreground">
                      {[agent.harness, agent.where].filter(Boolean).join(" · ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** One thing that waits on you, as a card like the work tree's threads. */
function NeedCard({
  agent,
  active,
  onOpen,
}: {
  readonly agent: ActiveAgentNode;
  readonly active: boolean;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  const here = useContext(WorkHereContext);
  if (agent.needs === undefined) return null;
  const need = NEED[agent.needs];
  const Icon = need.icon;
  const look = agentLook(agent.agent, here.providers);
  return (
    <li className="list-none py-px">
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative w-full rounded-md px-2.5 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
        )}
        onClick={() => onOpen(agent.open)}
      >
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-xs">
          <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", need.tone)}>
            <Icon aria-hidden className="size-3.5 shrink-0" />
            {need.label}
          </span>
          <span aria-hidden className="ml-auto inline-flex shrink-0 items-center gap-1.5">
            {agent.open.kind === "herdr" ? (
              <span className="text-2xs text-muted-foreground/70">herdr</span>
            ) : null}
            <AgentMark look={look} />
          </span>
        </span>
        <span className="mt-0.5 block truncate text-sm font-medium text-foreground">
          {agent.title}
        </span>
        {agent.where === undefined ? null : (
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">{agent.where}</span>
        )}
      </button>
    </li>
  );
}

function ProjectSection({
  environmentId,
  status,
  project,
  showWorkspace,
  activeThread,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly project: WorkProjectNode;
  readonly showWorkspace: boolean;
  readonly activeThread: string | null;
  readonly actions: WorkActions;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [adding, setAdding] = useState(false);
  const state = status.workspaces
    .find((w) => w.slug === project.workspace)
    ?.projects.find((p) => p.project.id === project.projectId);
  const checkout = state === undefined ? undefined : projectCheckout(state);
  const t3ProjectId = checkout?.projectId;
  const scope = { workspace: project.workspace, projectId: project.projectId };
  const opener = useOpenWorkspaceProject({ environmentId, ...scope, name: project.name });

  return (
    <section aria-label={project.name}>
      <div className="group/project flex items-center gap-1 pr-1">
        <button
          type="button"
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1 text-left text-xs font-semibold tracking-wide text-sidebar-foreground uppercase hover:bg-sidebar-row-hover"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 text-muted-foreground", !collapsed && "rotate-90")}
          />
          <span className="truncate">{project.name}</span>
          {showWorkspace ? (
            <span className="truncate font-normal text-muted-foreground normal-case">
              · {project.workspaceName}
            </span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Add a task to ${project.name}`}
                onClick={() => {
                  setCollapsed(false);
                  setAdding(true);
                }}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">Add a task</TooltipPopup>
        </Tooltip>
      </div>
      {collapsed ? null : (
        <div className="flex flex-col gap-1 pl-1">
          {adding ? (
            <NewTaskForm
              environmentId={environmentId}
              scope={scope}
              areas={project.areas.flatMap((a) => (a.name === null ? [] : [a.name]))}
              onDone={() => setAdding(false)}
            />
          ) : null}
          <MemoryRow workspace={project.workspace} project={project.projectId} />
          {project.candidates > 0 ? (
            <KnowledgeRow
              workspace={project.workspace}
              project={project.projectId}
              count={project.candidates}
              activeThread={activeThread}
            />
          ) : null}
          {checkout !== undefined && checkout.projectId === undefined ? (
            <NotOpenHere
              environmentId={environmentId}
              github={status.github}
              checkout={checkout}
              opening={opener.opening}
              onOpen={() => void opener.open()}
            />
          ) : null}
          {project.areas.map((area) => (
            <div key={area.name ?? "—"}>
              <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
                {area.name ?? "Other tasks"}
              </p>
              {area.tasks.length === 0 ? (
                <p className="px-2 py-0.5 text-xs text-muted-foreground/70">No tasks</p>
              ) : (
                <ul className="flex flex-col gap-px">
                  {area.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      environmentId={environmentId}
                      projectState={state}
                      status={status}
                      scope={scope}
                      task={task}
                      tasks={project.tasks}
                      t3ProjectId={t3ProjectId}
                      activeThread={activeThread}
                      actions={actions}
                    />
                  ))}
                </ul>
              )}
            </div>
          ))}
          {project.unsorted.some((thread) => thread.mine) || project.context !== undefined ? (
            <div>
              <p className="px-2 pt-1.5 pb-0.5 text-xs font-medium text-muted-foreground">
                Not on a task
              </p>
              <ul className="flex flex-col">
                {project.context === undefined ? null : (
                  <ContextRow
                    context={project.context}
                    label="Shared context"
                    activeThread={activeThread}
                  />
                )}
                <ThreadList
                  scope={scope}
                  threads={project.unsorted}
                  taskId={null}
                  tasks={project.tasks}
                  activeThread={activeThread}
                  actions={actions}
                />
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * A workspace project not open on this computer: clone and open it, or say
 * why that failed, with GitHub to connect when the account was the reason.
 */
function NotOpenHere({
  environmentId,
  github,
  checkout,
  opening,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly github: PeerHubStatus["github"];
  readonly checkout: ProjectCheckout;
  readonly opening: boolean;
  readonly onOpen: () => void;
}) {
  const busy = opening || checkout.cloning;
  const failed = !busy && checkout.errors.length > 0;
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className={cn("min-w-0 flex-1", failed && "text-destructive")}>
          {failed
            ? checkout.errors.join(" ")
            : checkout.missing
              ? "Not on this computer yet."
              : "On this computer, not open yet."}
        </span>
        <Button size="xs" variant="outline" disabled={busy} onClick={onOpen}>
          {busy
            ? checkout.missing
              ? "Cloning…"
              : "Opening…"
            : failed
              ? "Try again"
              : checkout.missing
                ? "Clone & open"
                : "Open"}
        </Button>
      </div>
      {failed && checkout.gitHubSignIn ? (
        <GitHubConnect environmentId={environmentId} github={github} onConnected={onOpen} />
      ) : null}
    </div>
  );
}

/** Edits a title in place: Enter or leaving the field saves, Escape keeps the old one. */
function TitleInput({
  value,
  label,
  onDone,
}: {
  readonly value: string;
  readonly label: string;
  /** The edited title, or null when cancelled. */
  readonly onDone: (title: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const finished = useRef(false);
  const finish = (title: string | null) => {
    if (finished.current) return;
    finished.current = true;
    onDone(title);
  };
  return (
    <input
      autoFocus
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(draft);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(draft)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      className="min-w-0 flex-1 rounded-sm border border-input bg-card px-1 text-sm font-medium text-card-foreground outline-none focus:border-foreground"
    />
  );
}

/** A person on a task: their mark, and their whole name on hover or click. */
function TaskPerson({ name, mine }: { readonly name: string; readonly mine: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip
      open={open}
      onOpenChange={(next, details) => {
        // A click shows the name; it does not take it away again.
        if (!next && details.reason === "trigger-press") return;
        setOpen(next);
      }}
    >
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={name}
            className="flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          />
        }
      >
        <PersonMark name={name} mine={mine} />
      </TooltipTrigger>
      <TooltipPopup side="top">{name}</TooltipPopup>
    </Tooltip>
  );
}

/** Up to three people on a task, you first. */
function TaskPeople({ threads }: { readonly threads: ReadonlyArray<WorkThreadNode> }) {
  const people = [
    ...new Map(threads.map((t) => [`${t.mine}:${t.person}`, t] as const)).values(),
  ].slice(0, 3);
  if (people.length === 0) return null;
  return (
    <span className="flex items-center -space-x-1">
      {people.map((t) => (
        <TaskPerson key={`${t.mine}:${t.person}`} name={t.person} mine={t.mine} />
      ))}
    </span>
  );
}

function TaskRow({
  environmentId,
  projectState,
  status,
  scope,
  task,
  tasks,
  t3ProjectId,
  activeThread,
  actions,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectState: PeerProjectState | undefined;
  readonly status: PeerHubStatus;
  readonly scope: Scope;
  readonly task: WorkTaskNode;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly t3ProjectId: ProjectId | undefined;
  readonly activeThread: string | null;
  readonly actions: WorkActions;
}) {
  const [expanded, setExpanded] = useState(!task.done);
  const [renaming, setRenaming] = useState(false);
  const label = taskLabel(task);

  const startThread = () => {
    if (t3ProjectId !== undefined) void actions.startThread(scope, task.id, t3ProjectId);
  };
  const showMenu = async (position: MenuPosition) => {
    const choice = await pickFromMenu(
      taskMenuItems({ task, canStartThread: t3ProjectId !== undefined }),
      position,
    );
    if (choice === "new-thread") startThread();
    else if (choice === "rename") setRenaming(true);
    else if (choice === "toggle-done") void actions.setTaskDone(scope, task, !task.done);
    else if (choice === "remove") void actions.removeTask(scope, task);
  };

  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={label}
        className="group/task flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-1 outline-none select-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          if (!renaming) setExpanded((value) => !value);
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button, input")) return;
          event.preventDefault();
          setRenaming(true);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          } else if (event.key === "F2") {
            event.preventDefault();
            setRenaming(true);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void showMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-muted-foreground",
            expanded && "rotate-90",
            !task.threads.some((thread) => thread.mine) &&
              task.context === undefined &&
              "invisible",
          )}
        />
        <StatusGlyph status={task.status} />
        {task.key ? (
          <span className="shrink-0 rounded-sm bg-muted px-1 font-mono text-2xs text-muted-foreground">
            {task.key}
          </span>
        ) : null}
        {renaming ? (
          <TitleInput
            value={task.title}
            label="Task title"
            onDone={(title) => {
              setRenaming(false);
              if (title !== null) void actions.renameTask(scope, task, title);
            }}
          />
        ) : (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              task.done ? "text-muted-foreground line-through" : "text-sidebar-foreground",
            )}
          >
            {task.title}
          </span>
        )}
        {/* Who is on it, always; the task's actions join them on hover or keyboard focus. */}
        <span className="flex h-5 shrink-0 items-center text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <TaskPeople threads={task.threads} />
            {task.threads.length > 0 ? (
              <span className="tabular-nums">{task.threads.length}</span>
            ) : null}
          </span>
          <span className="ml-1 flex items-center opacity-0 group-hover/task:opacity-100 has-[:focus-visible]:opacity-100 max-md:opacity-100">
            {!task.done && projectState !== undefined ? (
              <StartTaskAgent
                environmentId={environmentId}
                workspace={scope.workspace}
                project={projectState}
                taskId={task.id}
                taskLabel={label}
                status={status}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`New thread on ${label}`}
                    disabled={t3ProjectId === undefined}
                    onClick={(event) => {
                      event.stopPropagation();
                      startThread();
                    }}
                  />
                }
              >
                <PlusIcon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {t3ProjectId === undefined ? "Clone the project first" : "New thread on this task"}
              </TooltipPopup>
            </Tooltip>
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={`More for ${label}`}
              onClick={(event) => {
                event.stopPropagation();
                void showMenu(below(event));
              }}
            >
              <EllipsisIcon className="size-3.5" />
            </Button>
          </span>
        </span>
      </div>
      {expanded && (task.context !== undefined || task.threads.some((thread) => thread.mine)) ? (
        <ul className="mt-px mb-1 ml-3 flex flex-col border-l border-sidebar-border pl-1">
          {task.context === undefined ? null : (
            <ContextRow context={task.context} label="Task context" activeThread={activeThread} />
          )}
          <ThreadList
            scope={scope}
            threads={task.threads}
            taskId={task.id}
            tasks={tasks}
            activeThread={activeThread}
            actions={actions}
          />
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The shared context of a task, or of the project's work on no task: where the
 * work stands, as the agent keeping it put it, and how much waits for that
 * agent to fold in. It opens the page that shows it; the team's threads are
 * there too, not in the tree.
 */
function ContextRow({
  context,
  label,
  activeThread,
}: {
  readonly context: WorkContextNode;
  readonly label: string;
  readonly activeThread: string | null;
}) {
  const navigate = useNavigate();
  const active =
    activeThread === `context:${context.workspace}:${context.project}:${context.scope}`;
  const keeper =
    context.keeper === undefined
      ? "Nobody keeps it now"
      : context.keeper.mine
        ? "Your agent keeps it"
        : `${context.keeper.person}’s agent keeps it`;
  const written =
    context.version === 0
      ? "nothing written yet"
      : `version ${context.version}, ${formatRelativeTimeLabel(context.updatedAt)}`;
  return (
    <li className="list-none">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground",
                active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
              )}
              onClick={() =>
                void navigate({
                  to: "/context/$workspace/$project/$scope",
                  params: {
                    workspace: context.workspace,
                    project: context.project,
                    scope: context.scope,
                  },
                })
              }
            />
          }
        >
          <FileTextIcon aria-hidden className="size-3.5 shrink-0" />
          <span className="shrink-0 font-medium text-sidebar-foreground">{label}</span>
          <span className="min-w-0 flex-1 truncate">
            {context.gist ?? (context.version === 0 ? "nothing written yet" : "")}
          </span>
          {context.reports.length > 0 ? (
            <span className="shrink-0 text-info tabular-nums">{context.reports.length} new</span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {keeper} · {written}
          {context.tokens > 0 ? ` · ${contextSize(context.tokens)}` : ""}
        </TooltipPopup>
      </Tooltip>
    </li>
  );
}

/** Shared findings, evidence, questions, and review remain reachable even when no candidates wait. */
function MemoryRow({ workspace, project }: { workspace: string; project: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      onClick={() =>
        void navigate({
          to: "/memory/$workspace/$project",
          params: { workspace, project },
          search: {},
        })
      }
    >
      <LightbulbIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate font-medium text-sidebar-foreground">Memory</span>
    </button>
  );
}

/** What agents found that the project may want to keep, waiting for people to decide. */
function KnowledgeRow({
  workspace,
  project,
  count,
  activeThread,
}: {
  readonly workspace: string;
  readonly project: string;
  readonly count: number;
  readonly activeThread: string | null;
}) {
  const navigate = useNavigate();
  const active = activeThread === `knowledge:${workspace}:${project}`;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-left text-xs text-muted-foreground",
        active ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
      )}
      onClick={() =>
        void navigate({ to: "/knowledge/$workspace/$project", params: { workspace, project } })
      }
    >
      <LightbulbIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">
        Knowledge to keep
      </span>
      <span className="shrink-0 text-info tabular-nums">{count}</span>
    </button>
  );
}

/** A task's threads in the tree: yours. The team's are on the task's context page. */
function ThreadList({
  scope,
  threads,
  taskId,
  tasks,
  activeThread,
  actions,
}: {
  readonly scope: Scope;
  readonly threads: ReadonlyArray<WorkThreadNode>;
  readonly taskId: string | null;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly activeThread: string | null;
  readonly actions: WorkActions;
}) {
  return (
    <>
      {threads
        .filter((thread) => thread.mine)
        .map((thread) => (
          <ThreadCard
            key={thread.key}
            scope={scope}
            thread={thread}
            taskId={taskId}
            tasks={tasks}
            activeThread={activeThread}
            actions={actions}
          />
        ))}
    </>
  );
}

/**
 * One thread as the Threads list shows it: who and how it is doing, the
 * title, then branch and agent. Your own carry the accent and, on this
 * computer, open on click and rename, move, archive or delete from their
 * menu; a colleague's are read-only and quieter.
 */
function ThreadCard({
  scope,
  thread,
  taskId,
  tasks,
  activeThread,
  actions,
}: {
  readonly scope: Scope;
  readonly thread: WorkThreadNode;
  /** The task it sits under here, null under "Not on a task". */
  readonly taskId: string | null;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly activeThread: string | null;
  readonly actions: WorkActions;
}) {
  const [renaming, setRenaming] = useState(false);
  const open = thread.open;
  const local = open?.kind === "thread" ? open : undefined;
  const actionable = thread.mine && thread.placeable;
  const active = open !== undefined && activeThread === openKey(open);
  const here = useContext(WorkHereContext);
  const look = agentLook(thread.agent, here.providers);
  const elsewhere = !actionable && thread.localEnvironment !== true;
  const who = thread.mine ? (elsewhere ? "You · other computer" : "You") : thread.person;
  const machine = !thread.mine
    ? `${thread.person}’s computer`
    : elsewhere
      ? "Your other computer"
      : (here.label ?? "This computer");
  const details = [
    thread.mine
      ? elsewhere
        ? thread.observable
          ? "Yours on another computer: open it to watch it"
          : "Yours on another computer: open it there"
        : thread.observable
          ? "The team can watch it"
          : null
      : thread.observable
        ? `${thread.person} shares it: open it to watch it live`
        : `${thread.person}’s thread: only they change it`,
    thread.stale ? "Agent unavailable; its work and saved context remain here" : null,
    thread.delivery === "review" ? "Waiting for every linked pull request to merge" : null,
  ].filter((line) => line !== null);

  const showMenu = async (position: MenuPosition) => {
    const shell =
      local === undefined
        ? null
        : readThreadShell(scopeThreadRef(local.environmentId, local.threadId));
    const choice = await pickFromMenu(
      threadMenuItems({
        thread,
        tasks,
        taskId,
        running: shell !== null && !threadRuntimeCanArchive(shell.runtime),
      }),
      position,
    );
    if (choice === null || choice === "move") return;
    if (choice === "rename") setRenaming(true);
    else if (choice === "share" || choice === "unshare") {
      void actions.shareThread(thread.key, choice === "share");
    } else if (choice === "show-in-herdr") {
      if (open?.kind === "herdr") actions.showInHerdr(open.paneId);
    } else if (choice === "archive") {
      if (local !== undefined) void actions.archiveThread(local, thread.title);
    } else if (choice === "delete") {
      if (local !== undefined) void actions.deleteThread(local);
    } else if (choice === "unassign") void actions.placeThread(scope, thread.key, null);
    else void actions.placeThread(scope, thread.key, choice.slice("task:".length));
  };

  const runtimeLabel = thread.status === "done" ? "Turn finished" : STATUS_LABEL[thread.status];
  const statusLabel = thread.stale ? (
    <span className="text-muted-foreground">Agent offline</span>
  ) : thread.status === "idle" || thread.status === "unknown" ? (
    <span className="text-secondary-label tabular-nums">{activeLabel(thread.activeAt)}</span>
  ) : (
    <span className={cn("inline-flex items-center gap-1 font-medium", STATUS_TONE[thread.status])}>
      <StatusIcon status={thread.status} />
      {runtimeLabel}
    </span>
  );

  return (
    <li className="list-none py-px">
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              role={open === undefined ? undefined : "button"}
              tabIndex={open === undefined ? undefined : 0}
              aria-label={`${thread.title}, ${who}, ${runtimeLabel}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group/work-thread relative w-full overflow-hidden rounded-md px-2.5 py-1.5 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                active
                  ? "bg-sidebar-row-active"
                  : open === undefined
                    ? "cursor-default"
                    : "cursor-pointer hover:bg-sidebar-row-hover",
                thread.stale && "opacity-60",
              )}
              onClick={() => {
                if (open !== undefined && !renaming) actions.open(open);
              }}
              onDoubleClick={(event) => {
                if (!actionable || local === undefined) return;
                if ((event.target as HTMLElement).closest("button, input")) return;
                event.preventDefault();
                setRenaming(true);
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || open === undefined) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  actions.open(open);
                } else if (event.key === "F2" && actionable && local !== undefined) {
                  event.preventDefault();
                  setRenaming(true);
                }
              }}
              onContextMenu={(event) => {
                if (!actionable) return;
                event.preventDefault();
                void showMenu({ x: event.clientX, y: event.clientY });
              }}
            />
          }
        >
          {thread.mine ? (
            <span aria-hidden className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-primary" />
          ) : null}
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <PersonMark name={thread.person} mine={thread.mine} />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                thread.mine ? "font-medium text-sidebar-foreground" : "text-secondary-label",
              )}
            >
              {who}
            </span>
            {thread.keepsContext ? (
              <FileTextIcon
                aria-label="Keeps the task's shared context"
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            {thread.observable ? (
              <EyeIcon
                aria-label={thread.mine ? "The team can watch it" : "Shared to watch live"}
                className="size-3 shrink-0 text-muted-foreground"
              />
            ) : null}
            {/* The state at rest; the thread's menu takes the slot on hover or keyboard focus. */}
            <span className="group/thread-slot relative flex h-5 min-w-5 shrink-0 items-center justify-end text-xs">
              <span
                className={cn(
                  "flex items-center",
                  actionable &&
                    "group-hover/work-thread:pointer-events-none group-hover/work-thread:absolute group-hover/work-thread:right-0 group-hover/work-thread:opacity-0 group-has-[:focus-visible]/thread-slot:pointer-events-none group-has-[:focus-visible]/thread-slot:absolute group-has-[:focus-visible]/thread-slot:right-0 group-has-[:focus-visible]/thread-slot:opacity-0",
                )}
              >
                {statusLabel}
                {thread.delivery === undefined ? null : (
                  <span className="text-muted-foreground">
                    ·{" "}
                    {
                      {
                        open: "In progress",
                        review: "Awaiting merge",
                        merged: "Merged",
                        closed: "Closed",
                      }[thread.delivery]
                    }
                  </span>
                )}
              </span>
              {actionable ? (
                <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center opacity-0 group-hover/work-thread:pointer-events-auto group-hover/work-thread:static group-hover/work-thread:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100">
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`More for ${thread.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void showMenu(below(event));
                    }}
                  >
                    <EllipsisIcon className="size-3.5" />
                  </Button>
                </span>
              ) : null}
            </span>
          </div>
          <div className="mt-0.5 flex min-w-0">
            {renaming && local !== undefined ? (
              <TitleInput
                value={thread.title}
                label="Thread title"
                onDone={(title) => {
                  setRenaming(false);
                  if (title !== null) void actions.renameThread(local, title, thread.title);
                }}
              />
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  thread.mine ? "font-medium text-foreground" : "text-secondary-label",
                )}
              >
                {thread.title}
              </span>
            )}
          </div>
          {thread.concerns === undefined ? null : (
            <p className="mt-0.5 truncate text-xs text-warning-foreground">{thread.concerns}</p>
          )}
          {thread.branch !== undefined || look !== null || thread.source === "herdr" ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-secondary-label">
              {thread.branch !== undefined ? (
                <>
                  <GitBranchIcon aria-hidden className="size-3 shrink-0 opacity-50" />
                  <span className="flex min-w-0 flex-1 text-muted-foreground/60">
                    <MiddleTruncate value={thread.branch} showTitle={false} />
                  </span>
                </>
              ) : (
                <span className="flex-1" />
              )}
              <span aria-hidden className="ml-auto inline-flex shrink-0 items-center gap-1.5">
                {thread.source === "herdr" ? (
                  <span className="text-2xs text-muted-foreground/70">herdr</span>
                ) : null}
                <AgentMark look={look} />
              </span>
            </div>
          ) : null}
        </TooltipTrigger>
        <ThreadHoverCardPopup side="right" align="start" sideOffset={4}>
          <ThreadHoverCard title={thread.title}>
            <div className="flex min-w-0 items-center gap-2">
              <EnvironmentMachineIcon
                kind={elsewhere ? "laptop" : here.machine}
                className="size-3 shrink-0 stroke-muted-foreground"
              />
              <div className="min-w-0 truncate text-foreground/75">{machine}</div>
            </div>
            {thread.branch === undefined ? null : (
              <div className="flex min-w-0 items-center gap-2">
                <GitBranchIcon className="size-3 shrink-0 stroke-muted-foreground" />
                <MiddleTruncate value={thread.branch} className="flex" />
              </div>
            )}
            {look === null ? null : (
              <div className="flex min-w-0 items-center gap-2">
                <AgentMark look={look} />
                <div className="min-w-0 truncate text-foreground/75">
                  {look.model ?? look.displayName}
                  {thread.source === "herdr" ? " in herdr" : ""}
                </div>
              </div>
            )}
            {details.map((line) => (
              <div key={line} className="min-w-0 text-foreground/75">
                {line}
              </div>
            ))}
          </ThreadHoverCard>
        </ThreadHoverCardPopup>
      </Tooltip>
    </li>
  );
}

function NewTaskForm({
  environmentId,
  scope,
  areas,
  onDone,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: Scope;
  readonly areas: ReadonlyArray<string>;
  readonly onDone: () => void;
}) {
  const createTask = useAtomCommand(serverEnvironment.peerHubCreateTask, { reportFailure: false });
  const [title, setTitle] = useState("");
  const [key, setKey] = useState("");
  const [area, setArea] = useState(areas[0] ?? "");
  const [busy, setBusy] = useState(false);
  const listId = `peer-areas-${scope.workspace}-${scope.projectId}`;
  return (
    <form
      className="flex flex-col gap-1.5 rounded-md border border-sidebar-border p-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || title.trim() === "") return;
        setBusy(true);
        void createTask({
          environmentId,
          input: {
            ...scope,
            title: title.trim(),
            ...(key.trim() === "" ? {} : { key: key.trim() }),
            ...(area.trim() === "" ? {} : { area: area.trim() }),
          },
        })
          .then((result) => {
            if (reportFailure("Could not add the task", result)) onDone();
          })
          .finally(() => setBusy(false));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onDone();
      }}
    >
      <Input
        size="sm"
        nativeInput
        autoFocus
        placeholder="Task, e.g. Split Payments"
        aria-label="Task title"
        value={title}
        readOnly={busy}
        onChange={(event) => setTitle(event.currentTarget.value)}
      />
      <div className="flex gap-1.5">
        <Input
          className="w-24"
          size="sm"
          nativeInput
          placeholder="KRK-812"
          aria-label="Tracker key (optional)"
          value={key}
          readOnly={busy}
          onChange={(event) => setKey(event.currentTarget.value)}
        />
        <Input
          className="min-w-0 flex-1"
          size="sm"
          nativeInput
          placeholder="Area"
          aria-label="Area"
          list={listId}
          value={area}
          readOnly={busy}
          onChange={(event) => setArea(event.currentTarget.value)}
        />
        <datalist id={listId}>
          {areas.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      </div>
      <div className="flex justify-end gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy || title.trim() === ""}>
          {busy ? "Adding…" : "Add task"}
        </Button>
      </div>
    </form>
  );
}

/**
 * Any member shares a project with the workspace the way "Add project" takes
 * one: a repository by its address (GitHub's owner/repo or a clone URL), or a
 * project on this computer by its origin. Everyone then clones it with
 * "Clone & open".
 */
function ShareProject({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  const projects = useProjects();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const shareProject = useAtomCommand(serverEnvironment.peerHubShareProject, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState(status.workspaces[0]?.slug ?? "");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const bound = new Set(
    status.workspaces.flatMap((w) =>
      w.projects.flatMap((p) => p.repositories.flatMap((r) => (r.projectId ? [r.projectId] : []))),
    ),
  );
  // Threads without a project ("No project") have no repository to share.
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  const candidates = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      !bound.has(project.id) &&
      !isScratchProject(project, scratchRoot),
  );
  const workspaceName = status.workspaces.find((w) => w.slug === workspace)?.name ?? workspace;
  const share = (
    key: string,
    label: string,
    what: { readonly projectId: ProjectId } | { readonly repository: string },
  ) => {
    setBusy(key);
    void shareProject({ environmentId, input: { workspace, ...what } })
      .then((result) => {
        if (reportFailure(`Could not share ${label}`, result)) {
          toastManager.add({ type: "success", title: `${label} is shared with ${workspaceName}` });
          setAddress("");
          setOpen(false);
        }
      })
      .finally(() => setBusy(null));
  };
  if (!open) {
    return (
      <Button
        className="mx-2 self-start"
        size="xs"
        variant="ghost-muted"
        onClick={() => setOpen(true)}
      >
        <Share2Icon className="size-3.5" />
        Share a project with your team
      </Button>
    );
  }
  return (
    <section
      aria-label="Share a project"
      className="mx-1 rounded-md border border-sidebar-border p-2"
    >
      <p className="text-xs text-muted-foreground">
        Everyone in the workspace sees the project and clones it with “Clone &amp; open”.
      </p>
      {status.workspaces.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {status.workspaces.map((w) => (
            <Button
              key={w.slug}
              size="xs"
              variant={w.slug === workspace ? "secondary" : "ghost"}
              onClick={() => setWorkspace(w.slug)}
            >
              {w.name}
            </Button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-2 flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          const repository = address.trim();
          if (repository === "" || busy !== null) return;
          share("address", repository, { repository });
        }}
      >
        <Input
          className="min-w-0 flex-1"
          size="sm"
          nativeInput
          placeholder="owner/repo or clone URL"
          aria-label="Repository to share"
          value={address}
          readOnly={busy !== null}
          onChange={(event) => setAddress(event.currentTarget.value)}
        />
        <Button type="submit" size="xs" disabled={busy !== null || address.trim() === ""}>
          {busy === "address" ? "Sharing…" : "Share"}
        </Button>
      </form>
      {status.github.account !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          GitHub repositories open as {status.github.account}.
        </p>
      ) : status.github.cli ? (
        <div className="mt-1.5">
          <GitHubConnect environmentId={environmentId} github={status.github} />
        </div>
      ) : null}
      {candidates.length > 0 ? (
        <>
          <p className="mt-3 text-xs text-muted-foreground">Or a project on this computer:</p>
          <ul className="mt-1 flex flex-col gap-px">
            {candidates.map((project) => (
              <li key={project.id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{project.title}</span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => share(project.id, project.title, { projectId: project.id })}
                >
                  {busy === project.id ? "Sharing…" : "Share"}
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="mt-2 flex justify-end">
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </section>
  );
}
