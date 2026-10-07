import type {
  EnvironmentId,
  PeerCoordinationPolicy,
  PeerHubStatus,
  PeerHubSetCoordinationInput,
  PeerOverlap,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { failureMessage } from "./WorkspaceAccess";
import { taskLabel } from "./workTree.logic";

const POLICIES: ReadonlyArray<{
  readonly value: PeerCoordinationPolicy;
  readonly label: string;
  readonly hint: string;
}> = [
  {
    value: "notify",
    label: "Notify",
    hint: "An agent about to change a file another agent changed hears who and what they work on, and goes on.",
  },
  {
    value: "coordinate",
    label: "Coordinate",
    hint: "An overlapping edit waits until your agent acknowledges the current overlap or writes a coordination note. You can follow the agreement here.",
  },
  {
    value: "ask",
    label: "Ask me",
    hint: "Your agent asks you before it changes a file another agent changed.",
  },
];

function report(title: string, result: AtomCommandResult<unknown, unknown>) {
  const message = failureMessage(result);
  if (message !== null) {
    toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
  }
}

/** What the workspace calls a person; someone it does not name yet by their address. */
export function personName(status: PeerHubStatus, workspace: string, email: string): string {
  const projects = status.workspaces.find((w) => w.slug === workspace)?.projects ?? [];
  for (const state of projects) {
    const name = state.project.members.find((member) => member.email === email)?.name;
    if (name !== undefined && name !== "") return name;
  }
  const local = email.split("@")[0]?.split(/[._-]/)[0] ?? email;
  return local === "" ? email : `${local[0]?.toUpperCase() ?? ""}${local.slice(1)}`;
}

/** The tasks of the project an overlap is in. */
function projectTasks(status: PeerHubStatus, overlap: PeerOverlap) {
  return (
    status.workspaces
      .find((w) => w.slug === overlap.workspace)
      ?.projects.find((p) => p.project.id === overlap.project)?.work.tasks ?? []
  );
}

/**
 * What an overlap is about: the files both agents change, or the task one
 * agent asked the agents of (`peer ask` claims `task:<id>`).
 */
export function overlapTopic(status: PeerHubStatus, overlap: PeerOverlap): string {
  const tasks = projectTasks(status, overlap);
  const asked = overlap.files.flatMap((path) => {
    if (!path.startsWith("task:")) return [];
    const id = path.slice("task:".length);
    const task = tasks.find((candidate) => candidate.id === id);
    return [task === undefined ? id : taskLabel(task)];
  });
  const files = overlap.files.filter((path) => !path.startsWith("task:"));
  return [
    ...(asked.length === 0 ? [] : [`A question about ${asked.join(", ")}`]),
    ...(files.length === 0 ? [] : [files.join(", ")]),
  ].join(" · ");
}

/** The agents Peer adds its hooks to, so they take part wherever they run (herdr, Peer, a terminal). */
const AGENTS = [
  { hooks: "claudeHooks", name: "Claude Code" },
  { hooks: "codexHooks", name: "Codex" },
] as const;

/** Settings → Workspaces: agents coordinating with the team's (experimental). */
export function CoordinationControls({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  const set = useAtomCommand(serverEnvironment.peerHubSetCoordination, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const coordination = status.coordination;
  const run = async (input: PeerHubSetCoordinationInput) => {
    setBusy(true);
    try {
      report("Could not change agent coordination", await set({ environmentId, input }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex max-w-xl flex-col gap-3 pb-3">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={coordination.enabled}
          disabled={busy}
          aria-label="Coordinate this computer's agents with the team's"
          onCheckedChange={(enabled) => void run({ enabled })}
        />
        Coordinate this computer's agents with the team's
      </label>
      {coordination.enabled ? (
        <>
          <p className="text-xs text-muted-foreground">
            Default overlap policy on this environment. A project's policy in Peer Hub takes
            precedence.
          </p>
          <ToggleGroup
            className="w-full"
            aria-label="Default overlap policy on this environment"
            variant="segmented"
            value={[coordination.policy]}
            onValueChange={(next) => {
              const policy = POLICIES.find((p) => p.value === next[0])?.value;
              if (policy !== undefined) void run({ policy });
            }}
          >
            {POLICIES.map((policy) => (
              <Toggle key={policy.value} className="flex-1" value={policy.value}>
                {policy.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <p className="text-xs text-muted-foreground">
            {POLICIES.find((p) => p.value === coordination.policy)?.hint}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={coordination.claudeMod === true}
              disabled={busy}
              aria-label="Use Claude Code Peer Mod"
              onCheckedChange={(claudeMod) => void run({ claudeMod })}
            />
            Use Claude Code Peer Mod
          </label>
          <p className="text-xs text-muted-foreground">
            Claude Code 2.1.291 or newer. The Mod replaces Peer's Claude hooks and waits for the hub
            at tracked edits. Each running agent shows its verified coordination level.
          </p>
          {AGENTS.map((agent) => {
            const added = coordination[agent.hooks] === true;
            // A Peer that cannot add hooks to this agent does not say whether it runs them.
            if (coordination[agent.hooks] === undefined) return null;
            return (
              <div
                key={agent.hooks}
                className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
              >
                <span className="min-w-0 flex-1">
                  {added
                    ? agent.hooks === "codexHooks"
                      ? "Peer's hooks are installed in all configured Codex homes."
                      : `Peer's hooks are installed for ${agent.name}. New sessions take part once the agent loads them.`
                    : `Add Peer's hooks to ${agent.name} so its agents take part, wherever they run.`}
                  {added && agent.hooks === "codexHooks"
                    ? coordination.codexHooksTrusted === true
                      ? " Codex trusts them in every configured home."
                      : coordination.codexHookHomes === undefined
                        ? " Review and trust each Peer command in Codex's /hooks screen."
                        : " Review the Peer commands for each home below before new sessions can coordinate."
                    : null}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ [agent.hooks]: !added })}
                >
                  {added ? `Remove from ${agent.name}` : `Add to ${agent.name}`}
                </Button>
                {agent.hooks === "codexHooks" &&
                !added &&
                coordination.codexHookHomes?.some((home) => home.present) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run({ codexHooks: false })}
                  >
                    Remove from Codex
                  </Button>
                ) : null}
              </div>
            );
          })}
          {coordination.codexHookHomes?.map((home) => (
            <details key={home.home} className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                Codex: {home.home} —{" "}
                {home.trusted
                  ? "ready for new sessions"
                  : home.installed
                    ? "needs review"
                    : "hooks missing or changed"}
              </summary>
              <div className="flex flex-col gap-2 pt-2">
                <p>
                  Hook settings: <code className="select-all">{home.hooksPath}</code>
                </p>
                {home.error === undefined ? null : <p>{home.error}</p>}
                {!home.installed ? (
                  <p>
                    Choose Add to Codex to install the current Peer hooks in all configured homes on
                    this environment.
                  </p>
                ) : (
                  <>
                    <p>
                      These commands run on this environment outside Codex's sandbox. They report
                      agent activity to Peer and coordinate overlapping edits.
                    </p>
                    <ul className="flex flex-col gap-1">
                      {home.hooks.map((hook) => (
                        <li key={hook.key}>
                          {hook.event}
                          {hook.matcher === undefined ? "" : ` (${hook.matcher})`}:{" "}
                          <code className="select-all">{hook.command}</code>
                          {hook.enabled ? "" : " — disabled in Codex"}
                        </li>
                      ))}
                    </ul>
                    {home.hooks.some((hook) => !hook.enabled) ? (
                      <p>
                        Some Peer hooks are disabled in Codex. Enable them there before new sessions
                        can coordinate.
                      </p>
                    ) : null}
                    {!home.trusted ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy || home.hooks.some((hook) => !hook.enabled)}
                        onClick={() =>
                          void run({
                            codexHookApproval: { home: home.home, reviewId: home.reviewId },
                          })
                        }
                      >
                        Trust these Peer hooks
                      </Button>
                    ) : null}
                  </>
                )}
              </div>
            </details>
          ))}
          <p className="text-xs text-muted-foreground">
            Every coordination event is logged to{" "}
            <code className="rounded bg-muted px-1 py-px text-2xs select-all">
              {coordination.logPath}
            </code>
          </p>
          <ExperimentSteps />
        </>
      ) : null}
    </div>
  );
}

/** A short experiment to run on two computers, so the log shows how agents settle an overlap. */
function ExperimentSteps() {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button className="self-start" size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Experiment: two agents, one file
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-xs text-muted-foreground">
      <p className="font-medium text-foreground">Experiment: two agents, one file</p>
      <ol className="list-decimal space-y-1 pl-4">
        <li>
          On both computers: the same workspace project cloned, coordination on, Coordinate, and
          Peer's hooks added to the agent you use there (Claude Code or Codex).
        </li>
        <li>On both, start that agent in herdr in that checkout, each on a branch of its own.</li>
        <li>
          Computer A: “In apps/server/src/webhooks.rs every delivery should also send user-agent:
          app-webhooks/&lt;version&gt; and webhook-attempt: &lt;n&gt; (1-based); pass the attempt
          from round() into post(). Keep it small, do not run cargo, do not push.”
        </li>
        <li>
          A minute later, computer B: “In apps/server/src/webhooks.rs let post() sign the delivery
          itself (give it the secret instead of a ready signature) and rename sign() to signature(),
          keeping the specification test. Keep it small, do not run cargo, do not push.”
        </li>
        <li>
          Watch the Overlaps section of the Work view, then send both coordination logs (path
          above).
        </li>
      </ol>
      <Button className="self-start" size="xs" variant="ghost" onClick={() => setOpen(false)}>
        Hide
      </Button>
    </div>
  );
}

/** Notes this recent mean the agents are still talking it through. */
const TALKING_MS = 2 * 60 * 1000;
/** Asked this long ago and still open: the person may ask again, or close it themselves. */
const ASKED_LONG_MS = 3 * 60 * 1000;
/** An overlap its agents settled stays in view this long, with what they agreed. */
const SETTLED_SHOWN_MS = 10 * 60 * 1000;

/**
 * The Work view's overlaps: two agents changing the same files, or one asking
 * another task's agents, with the notes they wrote each other. A person asks
 * the agents to settle one (Resolve), and sees for a while what they agreed.
 */
export function OverlapList({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const open = status.coordination.overlaps.filter((overlap) => overlap.state === "open");
  const settled = status.coordination.overlaps.filter(
    (overlap) =>
      overlap.state === "resolved" && now - Date.parse(overlap.updatedAt) < SETTLED_SHOWN_MS,
  );
  if (!status.coordination.enabled || open.length + settled.length === 0) return null;
  return (
    <section aria-label="Overlaps" className="flex flex-col gap-1.5">
      <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Overlaps
      </p>
      {open.map((overlap) => (
        <OverlapCard
          key={`${overlap.workspace}/${overlap.id}`}
          environmentId={environmentId}
          status={status}
          overlap={overlap}
          now={now}
        />
      ))}
      {settled.map((overlap) => (
        <p
          key={`${overlap.workspace}/${overlap.id}`}
          className="mx-1 flex items-start gap-1.5 px-2 text-xs text-muted-foreground"
        >
          <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
          <span className="min-w-0">
            <span className="text-sidebar-foreground">{overlapTopic(status, overlap)}</span>
            {overlap.resolution === undefined ? " settled" : ` · agreed: ${overlap.resolution}`}
          </span>
        </p>
      ))}
    </section>
  );
}

function OverlapCard({
  environmentId,
  status,
  overlap,
  now,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly overlap: PeerOverlap;
  readonly now: number;
}) {
  const settle = useAtomCommand(serverEnvironment.peerHubSettleOverlap, { reportFailure: false });
  const resolve = useAtomCommand(serverEnvironment.peerHubResolveOverlap, {
    reportFailure: false,
  });
  const [writing, setWriting] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = { workspace: overlap.workspace, project: overlap.project, overlap: overlap.id };
  const nameOf = (email: string) => personName(status, overlap.workspace, email);
  const tasks = projectTasks(status, overlap);
  const agentOf = (id: string) => {
    const session = status.coordination.sessions.find(
      (s) => s.id === id && s.workspace === overlap.workspace && s.project === overlap.project,
    );
    if (session === undefined) return undefined;
    const task = tasks.find((candidate) => candidate.id === session.task);
    return {
      name: session.local ? "your agent" : `${nameOf(session.email)}'s agent`,
      on: task === undefined ? `“${session.label}”` : taskLabel(task),
    };
  };
  const sides = overlap.sessions.map((id) => {
    const agent = agentOf(id);
    return agent === undefined ? "an agent no longer at work" : `${agent.name} (${agent.on})`;
  });
  const lastAgentNote = overlap.notes.findLast((entry) => entry.session !== undefined);
  const askedAt = overlap.askedAt === undefined ? undefined : Date.parse(overlap.askedAt);
  const askedLong = askedAt !== undefined && now - askedAt >= ASKED_LONG_MS;
  const talking =
    askedAt === undefined &&
    lastAgentNote !== undefined &&
    now - Date.parse(lastAgentNote.at) < TALKING_MS;
  // Nobody is settling it: the agents went quiet, or never wrote.
  const waiting = askedAt === undefined && !talking;
  const act = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    try {
      const result = await action();
      report(title, result);
      if (result._tag === "Success") {
        setMessage("");
        setWriting(false);
      }
    } finally {
      setBusy(false);
    }
  };
  const ask = () =>
    act("Could not ask the agents", () =>
      settle({
        environmentId,
        input: { ...scope, ...(message.trim() === "" ? {} : { message: message.trim() }) },
      }),
    );
  return (
    <div className="mx-1 flex flex-col gap-1.5 rounded-md border border-sidebar-border p-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sidebar-foreground">
        <CircleAlertIcon
          aria-hidden
          className={cn("size-3.5 shrink-0", waiting ? "text-warning" : "text-muted-foreground")}
        />
        <span className="min-w-0 truncate">{overlapTopic(status, overlap)}</span>
      </p>
      <div>
        <Badge variant="warning">
          {askedAt !== undefined
            ? "Agreement requested"
            : talking
              ? "Discussing overlap"
              : "Needs coordination"}
        </Badge>
      </div>
      <p className="text-muted-foreground">{sides.join(" + ")}</p>
      {overlap.notes.length === 0 ? null : (
        <details className="text-muted-foreground">
          <summary className="cursor-pointer">
            {overlap.notes.length} coordination{" "}
            {overlap.notes.length === 1 ? "message" : "messages"}
          </summary>
          <div className="mt-2 max-h-60 space-y-2 overflow-y-auto">
            {overlap.notes.map((entry) => (
              <p key={entry.id} className="break-words">
                <span className="font-medium text-sidebar-foreground">
                  {entry.session === undefined
                    ? nameOf(entry.email)
                    : `${nameOf(entry.email)}’s agent`}
                  :{" "}
                </span>
                {entry.text}
              </p>
            ))}
          </div>
        </details>
      )}
      {writing ? (
        <Input
          className="min-w-0"
          size="sm"
          nativeInput
          autoFocus
          placeholder="Message for both agents (optional)"
          aria-label="Message for both agents"
          value={message}
          readOnly={busy}
          onChange={(event) => setMessage(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void ask();
          }}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <span className="relative inline-flex">
          {waiting ? (
            // A few stepped pulses when it starts waiting for a decision, then it holds still.
            <span
              key={overlap.updatedAt}
              aria-hidden
              className="pointer-events-none absolute inset-0 animate-attention-ping rounded-md bg-warning/50 motion-reduce:animate-none"
            />
          ) : null}
          <Button
            size="xs"
            disabled={busy || (askedAt !== undefined && !askedLong)}
            onClick={() => void ask()}
          >
            {askedAt === undefined
              ? "Request agreement"
              : askedLong
                ? "Ask again"
                : "Waiting for agents"}
          </Button>
        </span>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setWriting((open) => !open)}
        >
          {writing ? "No message" : "Add a message"}
        </Button>
        {askedLong ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act("Could not close the overlap", () =>
                resolve({
                  environmentId,
                  input: { ...scope, resolution: "Closed by a person in Peer" },
                }),
              )
            }
          >
            Close it yourself
          </Button>
        ) : null}
      </div>
    </div>
  );
}
