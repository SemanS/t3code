import type { EnvironmentId, PeerContextVersion, PeerProjectState } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, FileTextIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import ChatMarkdown from "../ChatMarkdown";
import { useRelativeTimeTick } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { confirmed, reportFailure, useWorkActions } from "./WorkPanel";
import { StatusGlyph } from "./workStatus";
import { usePeerHubStatus } from "./WorkspaceAccess";
import {
  adviceLabel,
  adviceOnWork,
  buildWorkTree,
  contextSize,
  personName,
  taskLabel,
  type WorkAdviceRow,
  type WorkContextNode,
  type WorkOpen,
  type WorkThreadNode,
} from "./workTree.logic";

interface Place {
  readonly workspace: string;
  readonly project: string;
  readonly scope: string;
}

/**
 * The shared context of a task, or of a project's work on no task, as the
 * agent keeping it left it. One agent keeps it at a time; the others read it
 * and send it what they find. Below it: what waits to be folded in, the agents
 * on the work (to open yours or watch a colleague's they share), and the
 * versions the hub keeps, to see what changed and bring one back.
 */
export function WorkContextView({ workspace, project, scope }: Place) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const localThreads = useThreadShells();
  const now = useRelativeTimeTick(30_000);
  const actions = useWorkActions(environmentId);
  const navigate = useNavigate();
  const restoreContext = useAtomCommand(serverEnvironment.peerHubRestoreContext, {
    reportFailure: false,
  });
  const harvestContext = useAtomCommand(serverEnvironment.peerHubHarvestContext, {
    reportFailure: false,
  });
  const [harvesting, setHarvesting] = useState(false);
  const knowledge = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.peerHubKnowledgeStatus({ environmentId, input: { workspace, project } }),
  ).data;
  const tree = useMemo(
    () => (status === null ? [] : buildWorkTree({ status, localThreads, now })),
    [localThreads, now, status],
  );
  const node = tree.find((p) => p.workspace === workspace && p.projectId === project);
  const state = status?.workspaces
    .find((w) => w.slug === workspace)
    ?.projects.find((p) => p.project.id === project);
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
  const advice = useMemo(
    () => (status === null ? [] : adviceOnWork({ status, workspace, project, scope })),
    [status, workspace, project, scope],
  );

  /** kontext reads the context for what the project should keep; people decide in Knowledge to keep. */
  const harvest = async () => {
    if (environmentId === null) return;
    setHarvesting(true);
    const result = await harvestContext({ environmentId, input: { workspace, project, scope } });
    setHarvesting(false);
    if (!reportFailure("Could not read it", result) || result._tag !== "Success") return;
    const proposed = result.value.proposed;
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title:
          proposed === 0
            ? "Nothing in it holds beyond this work"
            : `${proposed} ${proposed === 1 ? "proposal" : "proposals"} in Knowledge to keep`,
        description: "People keep or dismiss them under the project in Work.",
      }),
    );
  };

  const restore = async (version: number) => {
    if (environmentId === null) return;
    const sure = await confirmed(
      `Bring version ${version} back? It becomes the newest version, and the agent keeping the context goes on from it.`,
    );
    if (!sure) return;
    reportFailure(
      `Could not bring version ${version} back`,
      await restoreContext({ environmentId, input: { workspace, project, scope, version } }),
    );
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">{subject}</span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              {[
                scope === "project" ? "Shared context" : "Task context",
                context === undefined ? null : `version ${context.version}`,
                context === undefined || context.tokens === 0 ? null : contextSize(context.tokens),
              ]
                .filter(Boolean)
                .join(" · ")}
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
                {knowledge?.store === true && knowledge.llm && text.trim() !== "" ? (
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={harvesting}
                      onClick={() => void harvest()}
                    >
                      {harvesting ? "Reading it…" : "Propose what to keep"}
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      kontext reads this context for what the project should keep beyond the work;
                      it waits in Knowledge to keep.
                    </span>
                  </div>
                ) : null}
              </>
            )}
            <section aria-label="Agents on this work">
              <SectionTitle>Agents on this work · {agents.length}</SectionTitle>
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
            {advice.length === 0 ? null : (
              <Advice
                rows={advice}
                onOpenWork={(work) =>
                  void navigate({
                    to: "/context/$workspace/$project/$scope",
                    params: { workspace, project, scope: work },
                  })
                }
              />
            )}
            {context === undefined || context.version === 0 || environmentId === null ? null : (
              <History
                environmentId={environmentId}
                place={{ workspace, project, scope }}
                current={context.version}
                state={state}
                onRestore={(version) => void restore(version)}
              />
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              One agent keeps this context at a time: the first on the work, then the next when its
              session ends or it stays idle while another agent works. The others read it and send
              it what they find, and get it as reference from their team, never as instructions.
            </p>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function SectionTitle({ children }: { readonly children: React.ReactNode }) {
  return (
    <h2 className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function keeperLine(context: WorkContextNode): string {
  const keeper =
    context.keeper === undefined
      ? "Nobody keeps it right now; the next agent on this work does."
      : `Kept by ${context.keeper.mine ? "your agent" : `${context.keeper.person}’s agent`}${context.keeper.label === undefined ? "" : ` (“${context.keeper.label}”)`}.`;
  if (context.version === 0) return keeper;
  const when = formatRelativeTimeLabel(context.updatedAt);
  const written =
    context.restoredFrom !== undefined
      ? `${context.updatedBy ?? "Someone"} brought version ${context.restoredFrom} back`
      : context.updatedBy === undefined
        ? "written"
        : `by ${context.updatedBy}’s agent`;
  return `${keeper} Version ${context.version}${context.restoredFrom !== undefined ? ": " : " "}${written}, ${when}.`;
}

/** What the work's agents found since the context last changed, waiting for its keeper. */
function Reports({ context }: { readonly context: WorkContextNode }) {
  return (
    <section aria-label="Found since">
      <SectionTitle>
        Found since version {context.version} · {context.reports.length}
      </SectionTitle>
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

/**
 * What this work's agents did with the team's work and the project's knowledge: which contexts they
 * read, whose agents they asked, what a model they asked pointed them to, and which decision of the
 * project governs files they change. The agents choose from an index Peer gives them; people see
 * here what they relied on, to trust it or to correct it.
 */
function Advice({
  rows,
  onOpenWork,
}: {
  readonly rows: ReadonlyArray<WorkAdviceRow>;
  readonly onOpenWork: (scope: string) => void;
}) {
  return (
    <section aria-label="What these agents looked at">
      <SectionTitle>What these agents looked at · {rows.length}</SectionTitle>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-start gap-2 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{row.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {adviceLabel(row)} · {formatRelativeTimeLabel(row.at)}
              </span>
              {row.why === "" ? null : (
                <span className="line-clamp-2 block text-xs text-muted-foreground">{row.why}</span>
              )}
              {row.path === undefined ? null : (
                <span className="block truncate font-mono text-xs text-muted-foreground">
                  {row.path}
                </span>
              )}
            </span>
            {row.about === "work" ? (
              <Button size="xs" variant="outline" onClick={() => onOpenWork(row.scope)}>
                Open
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
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
            thread.keepsContext ? "keeps the context" : null,
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

/**
 * The versions the hub keeps, folded until opened: who wrote each and how many
 * lines it added and dropped; one opened shows those lines and can be brought
 * back. The keeper compacts freely because of it, and people see what changed.
 */
function History({
  environmentId,
  place,
  current,
  state,
  onRestore,
}: {
  readonly environmentId: EnvironmentId;
  readonly place: Place;
  readonly current: number;
  readonly state: PeerProjectState | undefined;
  readonly onRestore: (version: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const versions = useEnvironmentQuery(
    open
      ? serverEnvironment.peerHubContextVersions({
          environmentId,
          input: { ...place, version: current },
        })
      : null,
  );
  const name = (email: string | undefined) =>
    email === undefined ? "Someone" : state === undefined ? email : personName(state, email);
  const author = (version: PeerContextVersion) =>
    version.session === undefined && version.restoredFrom !== undefined
      ? `${name(version.by)} brought version ${version.restoredFrom} back`
      : `${name(version.by)}’s agent`;
  return (
    <section aria-label="History">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
        History
      </button>
      {!open ? null : versions.data == null ? (
        <p className="pt-1 text-sm text-muted-foreground">{versions.error ?? "Loading…"}</p>
      ) : (
        <ul className="flex flex-col pt-1">
          {versions.data.map((version) => (
            <li key={version.version}>
              <button
                type="button"
                aria-expanded={selected === version.version}
                className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1 text-left text-sm hover:bg-accent"
                onClick={() =>
                  setSelected((value) => (value === version.version ? null : version.version))
                }
              >
                <span className="w-7 shrink-0 text-muted-foreground tabular-nums">
                  v{version.version}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground">{author(version)}</span>
                <span className="shrink-0 text-xs text-success tabular-nums">+{version.added}</span>
                <span className="shrink-0 text-xs text-destructive tabular-nums">
                  −{version.dropped}
                </span>
                <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                  {formatRelativeTimeLabel(version.at)}
                </span>
              </button>
              {selected === version.version ? (
                <VersionChanges
                  environmentId={environmentId}
                  place={place}
                  version={version.version}
                  current={current}
                  onRestore={onRestore}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The lines one version added and dropped, and the way to bring it back. */
function VersionChanges({
  environmentId,
  place,
  version,
  current,
  onRestore,
}: {
  readonly environmentId: EnvironmentId;
  readonly place: Place;
  readonly version: number;
  readonly current: number;
  readonly onRestore: (version: number) => void;
}) {
  const read = useEnvironmentQuery(
    serverEnvironment.peerHubReadContextVersion({
      environmentId,
      input: { ...place, version },
    }),
  );
  const data = read.data;
  return (
    <div className="mb-2 ml-11 flex flex-col gap-2 border-l border-border pl-3">
      {data == null ? (
        <p className="text-xs text-muted-foreground">{read.error ?? "Loading…"}</p>
      ) : (
        <>
          {data.added.length + data.dropped.length === 0 ? (
            <p className="text-xs text-muted-foreground">No lines changed.</p>
          ) : (
            <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
              {data.added.length === 0 ? null : (
                <p className="text-success">{data.added.map((line) => `+ ${line}`).join("\n")}</p>
              )}
              {data.dropped.length === 0 ? null : (
                <p className="text-destructive">
                  {data.dropped.map((line) => `− ${line}`).join("\n")}
                </p>
              )}
            </div>
          )}
          {version === current ? null : (
            <div>
              <Button size="xs" variant="outline" onClick={() => onRestore(version)}>
                Bring this version back
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
