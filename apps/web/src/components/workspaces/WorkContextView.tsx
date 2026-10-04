import { FileTextIcon } from "lucide-react";
import { useMemo } from "react";

import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { useWorkActions } from "./WorkPanel";
import { StatusGlyph } from "./workStatus";
import { usePeerHubStatus } from "./WorkspaceAccess";
import {
  buildWorkTree,
  taskLabel,
  type WorkContextNode,
  type WorkOpen,
  type WorkThreadNode,
} from "./workTree.logic";

/**
 * The shared context of a task, or of a project's work on no task, as the
 * agent keeping it left it. One agent keeps it at a time; the others read it
 * and send it what they find. Below it, the agents on the work, to open (yours)
 * or watch (a colleague's they share).
 */
export function WorkContextView({
  workspace,
  project,
  scope,
}: {
  readonly workspace: string;
  readonly project: string;
  readonly scope: string;
}) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const localThreads = useThreadShells();
  const now = useRelativeTimeTick(30_000);
  const actions = useWorkActions(environmentId);
  const tree = useMemo(
    () => (status === null ? [] : buildWorkTree({ status, localThreads, now })),
    [localThreads, now, status],
  );
  const node = tree.find((p) => p.workspace === workspace && p.projectId === project);
  const task = scope.startsWith("task:")
    ? node?.areas.flatMap((area) => area.tasks).find((t) => t.id === scope.slice("task:".length))
    : undefined;
  const context = scope === "project" ? node?.context : task?.context;
  const read = useEnvironmentQuery(
    environmentId === null || context === undefined
      ? null
      : serverEnvironment.peerHubReadContext({
          environmentId,
          input: { workspace, project, scope, version: context.version },
        }),
  );
  const text = read.data?.text ?? "";
  const subject =
    task !== undefined
      ? taskLabel(task)
      : `${node?.name ?? project}${scope === "project" ? " · work outside tasks" : ""}`;
  const agents = (scope === "project" ? node?.unsorted : task?.threads) ?? [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{subject}</span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {scope === "project" ? "Shared context" : "Task context"}
              {context === undefined ? "" : ` · version ${context.version}`}
            </span>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
            {context === undefined ? (
              <p className="text-sm text-muted-foreground">
                No shared context yet. The first agent that starts on this work, with agent
                coordination on, starts it and keeps it.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">{keeperLine(context)}</p>
                {read.data == null && read.error !== null ? (
                  <p className="text-sm text-muted-foreground">{read.error}</p>
                ) : text.trim() === "" ? (
                  <p className="text-sm text-muted-foreground">Nobody has written it yet.</p>
                ) : (
                  <ChatMarkdown text={text} cwd={undefined} />
                )}
                {context.reports.length > 0 ? <Reports context={context} /> : null}
              </>
            )}
            <section aria-label="Agents on this work">
              <h2 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Agents on this work · {agents.length}
              </h2>
              {agents.length === 0 ? (
                <p className="text-sm text-muted-foreground">None right now.</p>
              ) : (
                <ul className="flex flex-col">
                  {agents.map((thread) => (
                    <AgentRow key={thread.key} thread={thread} onOpen={actions.open} />
                  ))}
                </ul>
              )}
            </section>
            <p className="text-xs leading-relaxed text-muted-foreground">
              One agent keeps this context at a time, and the next agent on the work takes over when
              its session ends. The other agents read it and send it what they find; they get it as
              reference from their team, never as instructions.
            </p>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function keeperLine(context: WorkContextNode): string {
  const keeper =
    context.keeper === undefined
      ? "Nobody keeps it right now; the next agent on this work does."
      : `Kept by ${context.keeper}’s agent.`;
  const written =
    context.version === 0
      ? ""
      : ` Version ${context.version}${context.updatedBy === undefined ? "" : ` by ${context.updatedBy}’s agent`}, ${formatRelativeTimeLabel(context.updatedAt)}.`;
  return `${keeper}${written}`;
}

/** What the work's agents found since the context last changed, waiting for its keeper. */
function Reports({ context }: { readonly context: WorkContextNode }) {
  return (
    <section aria-label="Found since">
      <h2 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Found since · {context.reports.length}
      </h2>
      <ul className="flex flex-col gap-1">
        {context.reports.map((report) => (
          <li key={report.id} className="text-sm text-foreground">
            <span className="text-muted-foreground">{report.person}’s agent: </span>
            {report.text}
          </li>
        ))}
      </ul>
      <p className="pt-1 text-xs text-muted-foreground">
        The agent keeping the context folds in what holds.
      </p>
    </section>
  );
}

function AgentRow({
  thread,
  onOpen,
}: {
  readonly thread: WorkThreadNode;
  readonly onOpen: (open: WorkOpen) => void;
}) {
  const open = thread.open;
  return (
    <li className="flex min-w-0 items-center gap-2 py-1.5">
      <StatusGlyph status={thread.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{thread.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {[
            thread.mine ? "You" : thread.person,
            thread.harness,
            thread.branch,
            thread.stale ? "not reporting" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {thread.concerns === undefined ? null : (
          <span className="block truncate text-xs text-warning-foreground">{thread.concerns}</span>
        )}
      </span>
      {open === undefined ? null : (
        <Button size="xs" variant="outline" onClick={() => onOpen(open)}>
          {open.kind === "observe" ? "Watch" : "Open"}
        </Button>
      )}
    </li>
  );
}
