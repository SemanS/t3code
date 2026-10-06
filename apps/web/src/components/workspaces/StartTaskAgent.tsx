import type { EnvironmentId, PeerHubStatus, PeerProjectState } from "@t3tools/contracts";
import { peerAgentStartBlocker } from "@t3tools/client-runtime/peer-task-agent";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
} from "../ui/dialog";
import { failureMessage } from "./WorkspaceAccess";

/** A task launch stays explicit: its own checkout, chosen harness, and a visible prompt. */
export function StartTaskAgent({
  environmentId,
  workspace,
  project,
  taskId,
  taskLabel,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: string;
  readonly project: PeerProjectState;
  readonly taskId: string;
  readonly taskLabel: string;
  readonly status: PeerHubStatus;
}) {
  const start = useAtomCommand(serverEnvironment.peerHubStartAgent, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [harness, setHarness] = useState<"claude" | "codex">("claude");
  const repositories = project.repositories.filter((repo) => repo.state === "ready");
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const selectedRepository = repositories.some((repo) => repo.id === repositoryId)
    ? repositoryId
    : (repositories[0]?.id ?? "");
  const [prompt, setPrompt] = useState(taskLabel);
  const [message, setMessage] = useState<string | null>(null);
  const blocked =
    peerAgentStartBlocker(status) ??
    (project.project.capacity.personal !== "any"
      ? "Use a Peer thread with an approved provider for this project's capacity policy."
      : repositories.length === 0
        ? "Clone and open the project on this environment first."
        : null);
  return (
    <>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Start agent on ${taskLabel}`}
        onClick={(event) => {
          event.stopPropagation();
          setMessage(null);
          setStarted(false);
          setOpen(true);
        }}
      >
        <PlayIcon className="size-3.5" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!busy) setOpen(next);
        }}
      >
        <DialogPopup
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || started || blocked !== null || prompt.trim() === "") return;
              setBusy(true);
              setMessage(null);
              void start({
                environmentId,
                input: {
                  workspace,
                  projectId: project.project.id,
                  taskId,
                  repositoryId: selectedRepository,
                  harness,
                  prompt: prompt.trim(),
                },
              })
                .then((result) => {
                  const failure = failureMessage(result);
                  if (failure !== null) setMessage(failure);
                  else if (result._tag === "Success") {
                    setStarted(true);
                    setMessage(
                      result.value.promptError ??
                        "Agent started in its own checkout. Find it under this task or in Needs you.",
                    );
                  }
                })
                .finally(() => setBusy(false));
            }}
          >
            <DialogHeader>
              <DialogTitle>Start agent on task</DialogTitle>
              <DialogDescription>
                {taskLabel}. Peer creates a feature branch in its own checkout on this environment.
              </DialogDescription>
            </DialogHeader>
            {blocked !== null ? (
              <p role="status" className="text-sm text-muted-foreground">
                {blocked}
              </p>
            ) : null}
            {status.agents.herdr !== "running" ? (
              <a
                className="text-sm underline"
                href="https://herdr.dev/docs/install/"
                target="_blank"
                rel="noreferrer"
              >
                Install herdr on the environment
              </a>
            ) : null}
            <label className="flex flex-col gap-1.5 text-sm">
              Agent
              <select
                className="rounded-md border border-input bg-background px-2 py-1.5"
                value={harness}
                disabled={busy}
                onChange={(event) =>
                  setHarness(event.target.value === "codex" ? "codex" : "claude")
                }
              >
                <option value="claude">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            {repositories.length > 1 ? (
              <label className="flex flex-col gap-1.5 text-sm">
                Repository
                <select
                  className="rounded-md border border-input bg-background px-2 py-1.5"
                  value={selectedRepository}
                  disabled={busy}
                  onChange={(event) => setRepositoryId(event.target.value)}
                >
                  {repositories.map((repo) => (
                    <option key={repo.id} value={repo.id}>
                      {repo.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="flex flex-col gap-1.5 text-sm">
              First prompt
              <textarea
                className="min-h-24 rounded-md border border-input bg-background px-2 py-1.5"
                value={prompt}
                disabled={busy}
                maxLength={20_000}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The running session shows whether its Mod or hooks enforce coordination. Without them,
              Peer observes changes after work.
            </p>
            {message === null ? null : (
              <p role="status" className="text-sm">
                {message}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Close
              </Button>
              <Button
                type="submit"
                disabled={busy || started || blocked !== null || prompt.trim() === ""}
              >
                {busy ? "Starting…" : started ? "Started" : "Start agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
