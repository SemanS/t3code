import type {
  EnvironmentId,
  PeerCoordinationPolicy,
  PeerHubStatus,
  PeerOverlap,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { failureMessage } from "./WorkspaceAccess";

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
    hint: "It writes the other agent a note first; they settle it between them, and you see every note here.",
  },
  {
    value: "ask",
    label: "Ask me",
    hint: "Claude Code asks you before it changes a file another agent changed.",
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
  const run = async (input: {
    readonly enabled?: boolean;
    readonly policy?: PeerCoordinationPolicy;
    readonly claudeHooks?: boolean;
  }) => {
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
          <ToggleGroup
            className="w-full"
            aria-label="When agents change the same file"
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
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1">
              {coordination.claudeHooks
                ? "Claude Code runs Peer's hooks: its agents hear each other only when they share a file."
                : "Add Peer's hooks to Claude Code so its agents (in herdr or anywhere) take part."}
            </span>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ claudeHooks: !coordination.claudeHooks })}
            >
              {coordination.claudeHooks ? "Remove from Claude Code" : "Add to Claude Code"}
            </Button>
          </div>
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
          Peer's hooks added to Claude Code.
        </li>
        <li>On both, start Claude Code in herdr in that checkout, each on a branch of its own.</li>
        <li>
          Computer A: “In apps/server/src/webhooks.rs make post() retry a failed delivery up to 3
          times with backoff (1 s, 2 s, 4 s). Keep it small, do not push.”
        </li>
        <li>
          A minute later, computer B: “In apps/server/src/webhooks.rs rename sign() to signature()
          and update every caller; add a doc comment on what is signed. Keep it small, do not push.”
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

/**
 * The Work view's open overlaps: two agents changing the same files, with the
 * notes they wrote each other. People add a note both agents hear, or settle it.
 */
export function OverlapList({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  const open = status.coordination.overlaps.filter((overlap) => overlap.state === "open");
  if (!status.coordination.enabled || open.length === 0) return null;
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
        />
      ))}
    </section>
  );
}

function OverlapCard({
  environmentId,
  status,
  overlap,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly overlap: PeerOverlap;
}) {
  const note = useAtomCommand(serverEnvironment.peerHubNoteOverlap, { reportFailure: false });
  const resolve = useAtomCommand(serverEnvironment.peerHubResolveOverlap, {
    reportFailure: false,
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = { workspace: overlap.workspace, project: overlap.project, overlap: overlap.id };
  const nameOf = (email: string) => personName(status, overlap.workspace, email);
  const sides = overlap.sessions.map((id) => {
    const session = status.coordination.sessions.find((s) => s.id === id);
    if (session === undefined) return "an agent no longer at work";
    return `${session.local ? "your" : `${nameOf(session.email)}'s`} agent (“${session.label}”)`;
  });
  const act = async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    try {
      const result = await action();
      report(title, result);
      if (result._tag === "Success") setText("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-1 flex flex-col gap-1.5 rounded-md border border-sidebar-border p-2 text-xs">
      <p className="flex items-center gap-1.5 font-medium text-sidebar-foreground">
        <CircleAlertIcon className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 truncate">{overlap.files.join(", ")}</span>
      </p>
      <p className="text-muted-foreground">{sides.join(" and ")}</p>
      {overlap.notes.slice(-4).map((entry) => (
        <p key={entry.id} className="text-muted-foreground">
          <span className="text-sidebar-foreground">
            {entry.session === undefined ? nameOf(entry.email) : `${nameOf(entry.email)}'s agent`}
          </span>
          : {entry.text}
        </p>
      ))}
      <form
        className="flex gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || text.trim() === "") return;
          void act("Could not add the note", () =>
            note({ environmentId, input: { ...scope, text: text.trim() } }),
          );
        }}
      >
        <Input
          className="min-w-0 flex-1"
          size="sm"
          nativeInput
          placeholder="A note both agents hear"
          aria-label="Note on the overlap"
          value={text}
          readOnly={busy}
          onChange={(event) => setText(event.currentTarget.value)}
        />
        <Button type="submit" size="xs" disabled={busy || text.trim() === ""}>
          Send
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act("Could not resolve the overlap", () =>
              resolve({
                environmentId,
                input: {
                  ...scope,
                  resolution: text.trim() === "" ? "Settled by a person" : text.trim(),
                },
              }),
            )
          }
        >
          Resolve
        </Button>
      </form>
    </div>
  );
}
