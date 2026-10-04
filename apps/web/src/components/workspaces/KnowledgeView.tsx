import type { PeerKnowledgeCandidate, PeerProjectState } from "@t3tools/contracts";
import { ChevronRightIcon, LightbulbIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { kontextCaptureCommand } from "./knowledge.logic";
import { reportFailure } from "./WorkPanel";
import { usePeerHubStatus } from "./WorkspaceAccess";
import { personName, taskLabel } from "./workTree.logic";

type Status = PeerKnowledgeCandidate["status"];

/**
 * What agents found that a project may want to keep beyond their tasks: lines
 * an agent marked for the project, and findings several agents reached on
 * their own. People keep a candidate (into the project's knowledge, through
 * kontext) or dismiss it; the hub only weighs them.
 */
export function KnowledgeView({
  workspace,
  project,
}: {
  readonly workspace: string;
  readonly project: string;
}) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const state = status?.workspaces
    .find((w) => w.slug === workspace)
    ?.projects.find((p) => p.project.id === project);
  const waiting =
    status?.coordination.candidates.find((c) => c.workspace === workspace && c.project === project)
      ?.proposed ?? 0;
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.peerHubKnowledgeCandidates({
          environmentId,
          input: { workspace, project, waiting },
        }),
  );
  const decideCandidate = useAtomCommand(serverEnvironment.peerHubDecideCandidate, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () =>
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Marked to keep",
          description:
            "The kontext command is on your clipboard: run it in the project's repository, then promote and commit it there.",
        }),
      ),
  });
  const [decided, setDecided] = useState<ReadonlyArray<PeerKnowledgeCandidate>>([]);
  const candidates = mergeDecided(list.data ?? [], decided);
  const proposed = candidates.filter((c) => c.status === "proposed");
  const settled = candidates.filter((c) => c.status !== "proposed");

  const decide = async (candidate: PeerKnowledgeCandidate, next: Status) => {
    if (environmentId === null) return;
    const result = await decideCandidate({
      environmentId,
      input: { workspace, project, id: candidate.id, status: next },
    });
    if (!reportFailure("Could not record that", result)) return;
    setDecided((list) => [
      ...list.filter((c) => c.id !== candidate.id),
      { ...candidate, status: next },
    ]);
    if (next === "promoted") copyToClipboard(kontextCaptureCommand(candidate), undefined);
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <LightbulbIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {state?.project.name ?? project}
            </span>
            <span className="shrink-0 truncate text-xs text-muted-foreground">
              Knowledge to keep
            </span>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-6">
            <p className="text-xs leading-relaxed text-muted-foreground">
              What agents found that may hold beyond their tasks: lines an agent marked for the
              project, and findings several agents reached on their own. Keep what the project
              should know in its knowledge; dismiss the rest.
            </p>
            {list.data == null && list.error !== null ? (
              <p className="text-sm text-muted-foreground">{list.error}</p>
            ) : proposed.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing waits to be kept.</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {proposed.map((candidate) => (
                  <CandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    state={state}
                    onDecide={(next) => void decide(candidate, next)}
                  />
                ))}
              </ul>
            )}
            {settled.length === 0 ? null : (
              <Settled
                candidates={settled}
                state={state}
                onPropose={(candidate) => void decide(candidate, "proposed")}
              />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** What this page decided wins over the list it read before. */
function mergeDecided(
  read: ReadonlyArray<PeerKnowledgeCandidate>,
  decided: ReadonlyArray<PeerKnowledgeCandidate>,
): ReadonlyArray<PeerKnowledgeCandidate> {
  return read.map((candidate) => decided.find((d) => d.id === candidate.id) ?? candidate);
}

/** Who found it and where, as people name them. */
function sourcesLine(candidate: PeerKnowledgeCandidate, state: PeerProjectState | undefined) {
  const where = (task: string | undefined) => {
    if (task === undefined) return "outside tasks";
    const found = state?.work.tasks.find((t) => t.id === task);
    return found === undefined ? task : taskLabel(found);
  };
  return [
    ...new Set(
      candidate.sources.map(
        (source) =>
          `${state === undefined ? source.email : personName(state, source.email)}’s agent (${where(source.task)})`,
      ),
    ),
  ].join(", ");
}

function CandidateCard({
  candidate,
  state,
  onDecide,
}: {
  readonly candidate: PeerKnowledgeCandidate;
  readonly state: PeerProjectState | undefined;
  readonly onDecide: (status: Status) => void;
}) {
  const marked = candidate.sources.some((source) => source.tagged);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5">
      <p className="text-sm text-foreground">{candidate.text}</p>
      <p className="text-xs text-muted-foreground">
        {[
          marked ? "Marked for the project" : null,
          candidate.finders > 1
            ? `${candidate.finders} agents found it on their own`
            : "One agent found it",
          candidate.reopened === true ? "found again after it was dismissed" : null,
          formatRelativeTimeLabel(candidate.lastAt),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="truncate text-xs text-muted-foreground">{sourcesLine(candidate, state)}</p>
      <div className="flex gap-2 pt-1">
        <Button size="xs" variant="outline" onClick={() => onDecide("promoted")}>
          Keep
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onDecide("dismissed")}>
          Dismiss
        </Button>
      </div>
    </li>
  );
}

/** Candidates people kept or dismissed, folded; each can be proposed again. */
function Settled({
  candidates,
  state,
  onPropose,
}: {
  readonly candidates: ReadonlyArray<PeerKnowledgeCandidate>;
  readonly state: PeerProjectState | undefined;
  readonly onPropose: (candidate: PeerKnowledgeCandidate) => void;
}) {
  const [open, setOpen] = useState(false);
  const who = (email: string | undefined) =>
    email === undefined ? "someone" : state === undefined ? email : personName(state, email);
  return (
    <section aria-label="Decided">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
        Decided · {candidates.length}
      </button>
      {open ? (
        <ul className="flex flex-col gap-2 pt-2">
          {candidates.map((candidate) => (
            <li key={candidate.id} className="flex min-w-0 items-start gap-3">
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{candidate.text}</span>
                <span className="block text-xs text-muted-foreground">
                  {candidate.status === "promoted" ? "Kept" : "Dismissed"} by{" "}
                  {who(candidate.decidedBy)}
                  {candidate.decidedAt === undefined
                    ? ""
                    : `, ${formatRelativeTimeLabel(candidate.decidedAt)}`}
                </span>
              </span>
              <Button size="xs" variant="ghost" onClick={() => onPropose(candidate)}>
                Propose again
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
