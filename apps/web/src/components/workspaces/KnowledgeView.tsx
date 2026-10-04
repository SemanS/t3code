import type {
  PeerKnowledgeCandidate,
  PeerKnowledgeStatus,
  PeerProjectState,
} from "@t3tools/contracts";
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
import { decisionStats, kontextCaptureCommand } from "./knowledge.logic";
import { reportFailure } from "./WorkPanel";
import { usePeerHubStatus } from "./WorkspaceAccess";
import { personName, taskLabel } from "./workTree.logic";

type Status = PeerKnowledgeCandidate["status"];

/**
 * What agents found that a project may want to keep beyond their tasks: lines
 * an agent marked for the project, findings several agents reached on their
 * own, and what a task's context held. People keep a candidate, which kontext
 * writes into the project's knowledge (staged, reviewed with the commit), or
 * dismiss it. Their decisions are what the agents' guidance is improved on.
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
  const [changes, setChanges] = useState(0);
  const list = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.peerHubKnowledgeCandidates({
          environmentId,
          input: { workspace, project, waiting },
        }),
  );
  const store = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.peerHubKnowledgeStatus({
          environmentId,
          input: { workspace, project, waiting: changes },
        }),
  );
  const knowledge = store.data ?? null;
  const decideCandidate = useAtomCommand(serverEnvironment.peerHubDecideCandidate, {
    reportFailure: false,
  });
  const keepCandidate = useAtomCommand(serverEnvironment.peerHubKeepCandidate, {
    reportFailure: false,
  });
  const setupKnowledge = useAtomCommand(serverEnvironment.peerHubSetupKnowledge, {
    reportFailure: false,
  });
  const improveGuidance = useAtomCommand(serverEnvironment.peerHubImproveGuidance, {
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
  const [busy, setBusy] = useState<string | null>(null);
  const candidates = mergeDecided(list.data ?? [], decided);
  const proposed = candidates.filter((c) => c.status === "proposed");
  const settled = candidates.filter((c) => c.status !== "proposed");
  const stats = decisionStats(candidates);

  const settle = (candidate: PeerKnowledgeCandidate, next: PeerKnowledgeCandidate) =>
    setDecided((list) => [...list.filter((c) => c.id !== candidate.id), next]);

  const decide = async (candidate: PeerKnowledgeCandidate, next: Status) => {
    if (environmentId === null) return;
    const result = await decideCandidate({
      environmentId,
      input: { workspace, project, id: candidate.id, status: next },
    });
    if (!reportFailure("Could not record that", result)) return;
    const { keptAs: _kept, ...rest } = candidate;
    settle(candidate, { ...rest, status: next });
  };

  /** Into the project's knowledge through kontext when it keeps knowledge here, else by hand. */
  const keep = async (candidate: PeerKnowledgeCandidate) => {
    if (environmentId === null) return;
    if (knowledge?.store !== true) {
      await decide(candidate, "promoted");
      copyToClipboard(kontextCaptureCommand(candidate), undefined);
      return;
    }
    setBusy(candidate.id);
    const result = await keepCandidate({
      environmentId,
      input: { workspace, project, id: candidate.id },
    });
    setBusy(null);
    if (!reportFailure("Could not keep it", result) || result._tag !== "Success") return;
    const kept = result.value;
    settle(candidate, { ...candidate, status: "promoted", keptAs: kept.keptAs });
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Kept as ${kept.keptAs.path}`,
        description: `Staged in ${kept.checkout}: it goes to the team with your next commit there.${kept.asWritten === null ? "" : ` It reads as the agents wrote it: ${kept.asWritten}.`}${kept.related === null ? "" : ` The knowledge already has “${kept.related}”: check they do not say the same.`}`,
      }),
    );
  };

  const setUp = async () => {
    if (environmentId === null) return;
    setBusy("setup");
    const result = await setupKnowledge({ environmentId, input: { workspace, project } });
    setBusy(null);
    if (reportFailure("Could not set up knowledge", result)) setChanges((n) => n + 1);
  };

  const improve = async () => {
    if (environmentId === null) return;
    setBusy("guidance");
    const result = await improveGuidance({ environmentId, input: { workspace, project } });
    setBusy(null);
    if (!reportFailure("Could not propose guidance", result) || result._tag !== "Success") return;
    setChanges((n) => n + 1);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: `Proposed guidance: ${result.value.title}`,
        description: `Staged as ${result.value.path} in ${result.value.checkout}. Read it, then commit it: from then on the project's agents follow it.`,
      }),
    );
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
            <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-muted-foreground">
              <p>
                What agents found that may hold beyond their tasks: lines an agent marked for the
                project, findings several agents reached on their own, and what a task's context
                held. Keep what the project should know; dismiss the rest.
              </p>
              <StoreLine
                knowledge={knowledge}
                busy={busy === "setup"}
                onSetUp={() => void setUp()}
              />
              {stats.decided === 0 ? null : (
                <p>
                  Kept {stats.kept} of {stats.decided} decided
                  {stats.marked === 0
                    ? ""
                    : ` · agents' own marks kept ${stats.markedKept} of ${stats.marked}`}
                  .
                </p>
              )}
            </div>
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
                    busy={busy === candidate.id}
                    onKeep={() => void keep(candidate)}
                    onDismiss={() => void decide(candidate, "dismissed")}
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
            <Guidance
              knowledge={knowledge}
              decided={stats.decided}
              busy={busy === "guidance"}
              onImprove={() => void improve()}
            />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

/** Where the project's knowledge lives here, or how to start keeping it. */
function StoreLine({
  knowledge,
  busy,
  onSetUp,
}: {
  readonly knowledge: PeerKnowledgeStatus | null;
  readonly busy: boolean;
  readonly onSetUp: () => void;
}) {
  if (knowledge === null) return null;
  if (knowledge.store && knowledge.checkout !== null) {
    return (
      <p>Kept candidates go into {knowledge.checkout}/.ai, staged for your next commit there.</p>
    );
  }
  if (knowledge.checkout === null) {
    return <p>The project is not on this computer: Keep copies a kontext command instead.</p>;
  }
  if (!knowledge.kontext) {
    return (
      <p>Install kontext to keep knowledge in this project; until then Keep copies its command.</p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2">
      <span>This project keeps no knowledge yet ({knowledge.checkout}).</span>
      <Button size="xs" variant="outline" disabled={busy} onClick={onSetUp}>
        {busy ? "Setting up…" : "Set up knowledge"}
      </Button>
    </p>
  );
}

/**
 * The guidance the project's agents get on what to mark for it, and the way
 * to improve it from people's decisions: kontext proposes a convention from
 * what was kept and dismissed, which people review in the commit.
 */
function Guidance({
  knowledge,
  decided,
  busy,
  onImprove,
}: {
  readonly knowledge: PeerKnowledgeStatus | null;
  readonly decided: number;
  readonly busy: boolean;
  readonly onImprove: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (knowledge === null || !knowledge.store) return null;
  const canImprove = knowledge.llm && decided >= 3;
  return (
    <section aria-label="Guidance for agents" className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRightIcon aria-hidden className={cn("size-3", open && "rotate-90")} />
        Guidance for agents
      </button>
      {open ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="whitespace-pre-wrap text-foreground">
            {knowledge.guidance ??
              "None of its own yet: agents follow Peer's general rule on what to mark [project]."}
          </p>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" disabled={!canImprove || busy} onClick={onImprove}>
              {busy ? "Proposing…" : "Improve from decisions"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {!knowledge.llm
                ? "Needs kontext's llm adapter."
                : decided < 3
                  ? `Keep or dismiss ${3 - decided} more first.`
                  : "kontext proposes it from what people kept and dismissed; you review it in the commit."}
            </span>
          </div>
        </div>
      ) : null}
    </section>
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
  busy,
  onKeep,
  onDismiss,
}: {
  readonly candidate: PeerKnowledgeCandidate;
  readonly state: PeerProjectState | undefined;
  readonly busy: boolean;
  readonly onKeep: () => void;
  readonly onDismiss: () => void;
}) {
  const marked = candidate.sources.some((source) => source.tagged && source.origin === undefined);
  const harvested = candidate.sources.some((source) => source.origin !== undefined);
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-border px-3 py-2.5">
      <p className="text-sm text-foreground">{candidate.text}</p>
      {candidate.detail === undefined ? null : (
        <p className="text-xs whitespace-pre-wrap text-muted-foreground">{candidate.detail}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {[
          candidate.kind,
          marked ? "Marked for the project" : null,
          harvested ? "Read from a task's context" : null,
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
        <Button size="xs" variant="outline" disabled={busy} onClick={onKeep}>
          {busy ? "Keeping…" : "Keep"}
        </Button>
        <Button size="xs" variant="ghost" disabled={busy} onClick={onDismiss}>
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
                  {candidate.status === "promoted"
                    ? candidate.keptAs === undefined
                      ? "Kept"
                      : `Kept as ${candidate.keptAs.path}`
                    : "Dismissed"}{" "}
                  by {who(candidate.decidedBy)}
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
