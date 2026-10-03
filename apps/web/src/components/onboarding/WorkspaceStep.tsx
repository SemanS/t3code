import type { EnvironmentId, PeerHubStatus } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import {
  WorkspacePicker,
  WorkspaceSignIn,
  failureMessage,
  usePeerHubStatus,
} from "../workspaces/WorkspaceAccess";

/**
 * First-run step, like Slack's: sign in with a work email, then join the
 * team's workspace (its domain or an invite admits you) or create one.
 * Skippable — Peer works on its own, and Settings → Workspaces has the same.
 */
export function WorkspaceStep({ onContinue }: { readonly onContinue: () => void }) {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary !== null && primary.connection.phase === "connected" && primary.serverConfig !== null
      ? primary.environmentId
      : null;
  const status = usePeerHubStatus(environmentId);
  const [addingAnother, setAddingAnother] = useState(false);

  if (environmentId === null || status === null) {
    return (
      <>
        <Heading title="Join your team" description="Connecting to this computer…" />
        <div className="mt-5 flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Starting Peer
        </div>
        <Footer onSkip={onContinue} />
      </>
    );
  }

  if (!status.signedIn) {
    return (
      <>
        <Heading
          title="Join your team"
          description="Sign in with your work email. Your team’s workspace brings its projects, agent tools, knowledge and shared AI capacity — or create one for your team."
        />
        <div className="mt-5">
          <WorkspaceSignIn environmentId={environmentId} status={status} />
        </div>
        <Footer onSkip={onContinue} />
      </>
    );
  }

  if (status.workspaces.length === 0 || addingAnother) {
    return (
      <>
        <Heading
          title="Choose a workspace"
          description={`Signed in as ${status.email ?? "you"}. Join the workspace your address qualifies for, or create one.`}
        />
        <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(30rem,55dvh)]">
          <div className="pr-3">
            <WorkspacePicker
              environmentId={environmentId}
              status={status}
              onJoined={() => setAddingAnother(false)}
            />
          </div>
        </ScrollArea>
        <Footer
          onSkip={onContinue}
          {...(status.workspaces.length > 0 ? { onBack: () => setAddingAnother(false) } : {})}
        />
      </>
    );
  }

  return (
    <ProjectsToOpen
      environmentId={environmentId}
      status={status}
      onJoinAnother={() => setAddingAnother(true)}
      onContinue={onContinue}
    />
  );
}

function ProjectsToOpen({
  environmentId,
  status,
  onJoinAnother,
  onContinue,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly onJoinAnother: () => void;
  readonly onContinue: () => void;
}) {
  const openProject = useAtomCommand(serverEnvironment.peerHubOpenProject, {
    reportFailure: false,
  });
  const candidates = status.workspaces.flatMap((workspace) =>
    workspace.projects
      .filter((state) => state.project.repositories.length > 0)
      .map((state) => ({
        key: `${workspace.slug}/${state.project.id}`,
        workspace,
        state,
        opened: state.repositories.every(
          (repo) => repo.state === "ready" && repo.projectId !== undefined,
        ),
      })),
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(candidates.filter((c) => !c.opened).map((c) => c.key)),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = status.workspaces.map((workspace) => workspace.name).join(", ");

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      // Clones run on the computer in the background; Settings → Workspaces shows their progress.
      for (const candidate of candidates) {
        if (candidate.opened || !selected.has(candidate.key)) continue;
        const message = failureMessage(
          await openProject({
            environmentId,
            input: { workspace: candidate.workspace.slug, projectId: candidate.state.project.id },
          }),
        );
        if (message !== null) {
          setError(`${candidate.state.project.name}: ${message}`);
          return;
        }
      }
      onContinue();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Heading
        title={`You’re in ${names}`}
        description={
          candidates.length === 0
            ? "Your workspaces list no projects with repositories for you yet. A lead adds you to projects; they appear in Settings → Workspaces."
            : "Pick the projects to clone to this computer. They open in the sidebar with their tools and knowledge."
        }
      />
      {candidates.length > 0 ? (
        <ScrollArea scrollFade className="mt-5 h-auto max-h-[min(26rem,50dvh)]">
          <fieldset className="space-y-2 pr-3">
            <legend className="sr-only">Projects to clone</legend>
            {candidates.map((candidate) => (
              <label
                key={candidate.key}
                className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
              >
                <Checkbox
                  checked={candidate.opened || selected.has(candidate.key)}
                  disabled={candidate.opened || busy}
                  onCheckedChange={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(candidate.key);
                      else next.delete(candidate.key);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium break-words">
                    {candidate.state.project.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {[
                      status.workspaces.length > 1 ? candidate.workspace.name : null,
                      candidate.state.project.client,
                      `${candidate.state.project.repositories.length} repositor${candidate.state.project.repositories.length === 1 ? "y" : "ies"}`,
                      candidate.opened ? "already on this computer" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        </ScrollArea>
      ) : null}
      {error ? (
        <Alert variant="error" className="mt-3">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mt-6 flex items-center justify-between gap-3">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onJoinAnother}>
          Join another workspace
        </Button>
        <Button autoFocus disabled={busy} onClick={() => void open()}>
          {busy ? "Opening…" : "Continue"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
    </>
  );
}

function Heading({ title, description }: { readonly title: string; readonly description: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

function Footer({ onSkip, onBack }: { readonly onSkip: () => void; readonly onBack?: () => void }) {
  return (
    <div className="mt-6 flex items-center justify-between gap-3">
      {onBack ? (
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      ) : (
        <span />
      )}
      <Button variant="ghost" size="sm" onClick={onSkip}>
        Skip for now
      </Button>
    </div>
  );
}
