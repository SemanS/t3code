import type {
  EnvironmentId,
  PeerHubStatus,
  PeerTask,
  PeerWorkStatus,
  ProjectId,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleIcon,
  EllipsisIcon,
  PlusIcon,
  Share2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { cn } from "../../lib/utils";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { OverlapList } from "./Coordination";
import { GitHubConnect } from "./GitHubConnect";
import {
  projectCheckout,
  useOpenWorkspaceProject,
  type ProjectCheckout,
} from "./useOpenWorkspaceProject";
import { failureMessage, usePeerHubStatus } from "./WorkspaceAccess";
import {
  activeAgents,
  buildWorkTree,
  type ActiveAgentNode,
  type WorkOpen,
  type WorkProjectNode,
  type WorkTaskNode,
  type WorkThreadNode,
} from "./workTree.logic";

const STATUS_LABEL: Readonly<Record<PeerWorkStatus, string>> = {
  working: "Working",
  blocked: "Needs an answer",
  done: "Done",
  idle: "Idle",
  unknown: "Unknown",
};

function StatusGlyph({
  status,
  stale = false,
}: {
  readonly status: PeerWorkStatus;
  readonly stale?: boolean;
}) {
  const label = stale ? `${STATUS_LABEL[status]} (not reported lately)` : STATUS_LABEL[status];
  if (status === "blocked") {
    return <CircleAlertIcon aria-label={label} className="size-3.5 shrink-0 text-warning" />;
  }
  if (status === "done") {
    return <CheckIcon aria-label={label} className="size-3.5 shrink-0 text-muted-foreground" />;
  }
  return (
    <span className="flex size-3.5 shrink-0 items-center justify-center" aria-label={label}>
      <CircleIcon
        className={cn(
          "size-2.5",
          status === "working" ? "fill-current text-success" : "text-muted-foreground",
          stale && "opacity-50",
        )}
      />
    </span>
  );
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>): boolean {
  const message = failureMessage(result);
  if (message !== null) {
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }
  return message === null;
}

/** Opens a local thread, or brings a herdr agent forward in herdr. */
function useOpenWork(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const focusAgent = useAtomCommand(serverEnvironment.peerHubFocusAgent, { reportFailure: false });
  return (open: WorkOpen) => {
    if (open.kind === "thread") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(open.environmentId, open.threadId)),
      });
      return;
    }
    if (environmentId === null) return;
    void focusAgent({ environmentId, input: { paneId: open.paneId } }).then((result) =>
      reportFailure("Could not show that agent in herdr", result),
    );
  };
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
  const open = useOpenWork(environmentId);
  const tree = useMemo(
    () => (status === null ? [] : buildWorkTree({ status, localThreads: threads, now })),
    [now, status, threads],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [`${p.environmentId}:${p.id}`, p.title] as const)),
    [projects],
  );
  const running = useMemo(
    () =>
      activeAgents({
        status,
        localThreads: threads,
        projectNames,
        localEnvironmentId: environmentId,
      }),
    [environmentId, projectNames, status, threads],
  );

  return (
    <div className="flex flex-col gap-4 pb-6">
      {environmentId !== null && status !== null && status.signedIn ? (
        <OverlapList environmentId={environmentId} status={status} />
      ) : null}
      <ActiveAgents agents={running} herdr={status?.agents.herdr ?? null} onOpen={open} />
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
            onOpen={open}
          />
        ))
      )}
      {environmentId !== null && status?.signedIn && status.workspaces.length > 0 ? (
        <ShareProject environmentId={environmentId} status={status} />
      ) : null}
    </div>
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

function ActiveAgents({
  agents,
  herdr,
  onOpen,
}: {
  readonly agents: ReadonlyArray<ActiveAgentNode>;
  readonly herdr: PeerHubStatus["agents"]["herdr"] | null;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  return (
    <section aria-label="Active agents">
      <SectionLabel>Active agents</SectionLabel>
      {agents.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          {herdr === "running"
            ? "Nothing is running right now."
            : "Nothing is running. Agents you run in herdr (herdr.dev) show up here too."}
        </p>
      ) : (
        <ul className="flex flex-col gap-px">
          {agents.map((agent) => (
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
      )}
    </section>
  );
}

function ProjectSection({
  environmentId,
  status,
  project,
  showWorkspace,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly project: WorkProjectNode;
  readonly showWorkspace: boolean;
  readonly onOpen: (open: WorkOpen) => void;
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
        <div className="flex flex-col gap-1 pl-2">
          {adding ? (
            <NewTaskForm
              environmentId={environmentId}
              scope={scope}
              areas={project.areas.flatMap((a) => (a.name === null ? [] : [a.name]))}
              onDone={() => setAdding(false)}
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
              <p className="px-2 pt-1 text-xs text-muted-foreground">
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
                      scope={scope}
                      task={task}
                      tasks={project.tasks}
                      t3ProjectId={t3ProjectId}
                      onOpen={onOpen}
                    />
                  ))}
                </ul>
              )}
            </div>
          ))}
          {project.unsorted.length > 0 ? (
            <div>
              <p className="px-2 pt-1 text-xs text-muted-foreground">Not on a task</p>
              <ul className="flex flex-col gap-px">
                {project.unsorted.map((thread) => (
                  <ThreadRow
                    key={thread.key}
                    environmentId={environmentId}
                    scope={scope}
                    thread={thread}
                    tasks={project.tasks}
                    onOpen={onOpen}
                  />
                ))}
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

interface Scope {
  readonly workspace: string;
  readonly projectId: string;
}

function TaskRow({
  environmentId,
  scope,
  task,
  tasks,
  t3ProjectId,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: Scope;
  readonly task: WorkTaskNode;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly t3ProjectId: ProjectId | undefined;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  const [expanded, setExpanded] = useState(!task.done);
  const updateTask = useAtomCommand(serverEnvironment.peerHubUpdateTask, { reportFailure: false });
  const deleteTask = useAtomCommand(serverEnvironment.peerHubDeleteTask, { reportFailure: false });
  const assignThread = useAtomCommand(serverEnvironment.peerHubAssignThread, {
    reportFailure: false,
  });
  const openNewThread = useNewThreadHandler();
  const label = task.key ? `${task.key} · ${task.title}` : task.title;

  const startThread = async () => {
    if (t3ProjectId === undefined) return;
    const draft = await openNewThread(scopeProjectRef(environmentId, t3ProjectId));
    if (draft === null) return;
    // The draft already knows the id its thread will have, so the thread starts under the task.
    reportFailure(
      "Could not put the new thread under the task",
      await assignThread({
        environmentId,
        input: { ...scope, thread: `peer:${draft.threadId}`, taskId: task.id },
      }),
    );
  };

  return (
    <li>
      <div className="group/task flex items-center gap-1 pr-1">
        <button
          type="button"
          className={cn(
            "flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover",
            task.done && "text-muted-foreground",
          )}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <ChevronRightIcon
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              expanded && "rotate-90",
              task.threads.length === 0 && "opacity-0",
            )}
          />
          <StatusGlyph status={task.status} />
          <span className={cn("min-w-0 flex-1 truncate", task.done && "line-through")}>
            {label}
          </span>
          {task.threads.length > 0 ? (
            <span className="shrink-0 text-xs text-muted-foreground">{task.threads.length}</span>
          ) : null}
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`New thread on ${label}`}
                disabled={t3ProjectId === undefined}
                onClick={() => void startThread()}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {t3ProjectId === undefined ? "Clone the project first" : "New thread on this task"}
          </TooltipPopup>
        </Tooltip>
        <Menu>
          <MenuTrigger
            render={
              <Button size="icon-xs" variant="ghost-muted" aria-label={`More for ${label}`} />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              onClick={() =>
                void updateTask({
                  environmentId,
                  input: { ...scope, taskId: task.id, status: task.done ? "open" : "done" },
                }).then((result) => reportFailure(`Could not update ${label}`, result))
              }
            >
              {task.done ? "Reopen" : "Mark done"}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={() =>
                void deleteTask({ environmentId, input: { ...scope, taskId: task.id } }).then(
                  (result) => reportFailure(`Could not remove ${label}`, result),
                )
              }
            >
              Remove task
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {expanded && task.threads.length > 0 ? (
        <ul className="ml-4 flex flex-col gap-px border-l border-sidebar-border pl-1">
          {task.threads.map((thread) => (
            <ThreadRow
              key={thread.key}
              environmentId={environmentId}
              scope={scope}
              thread={thread}
              tasks={tasks}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ThreadRow({
  environmentId,
  scope,
  thread,
  tasks,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly scope: Scope;
  readonly thread: WorkThreadNode;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  const assignThread = useAtomCommand(serverEnvironment.peerHubAssignThread, {
    reportFailure: false,
  });
  const details = [
    thread.source === "herdr" ? "in herdr" : null,
    thread.harness,
    thread.branch,
    thread.stale ? "not reported lately" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const row = (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <StatusGlyph status={thread.status} stale={thread.stale} />
      <span className={cn("min-w-0 flex-1 truncate", thread.stale && "text-muted-foreground")}>
        {thread.title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{thread.person}</span>
    </span>
  );
  const open = thread.open;
  return (
    <li className="group/thread flex items-center gap-1 pr-1">
      <Tooltip>
        <TooltipTrigger
          render={
            open === undefined ? (
              <div className="flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-sm text-sidebar-foreground" />
            ) : (
              <button
                type="button"
                className="flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover"
                onClick={() => onOpen(open)}
              />
            )
          }
        >
          {row}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {details === "" ? STATUS_LABEL[thread.status] : details}
        </TooltipPopup>
      </Tooltip>
      {thread.placeable ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Move ${thread.title} to a task`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {tasks
              .filter((task) => task.status === "open")
              .map((task) => (
                <MenuItem
                  key={task.id}
                  onClick={() =>
                    void assignThread({
                      environmentId,
                      input: { ...scope, thread: thread.key, taskId: task.id },
                    }).then((result) => reportFailure("Could not move the thread", result))
                  }
                >
                  {task.key ? `${task.key} · ${task.title}` : task.title}
                </MenuItem>
              ))}
            <MenuSeparator />
            <MenuItem
              onClick={() =>
                void assignThread({
                  environmentId,
                  input: { ...scope, thread: thread.key, taskId: null },
                }).then((result) => reportFailure("Could not move the thread", result))
              }
            >
              Not on a task
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
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
