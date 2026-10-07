import type { EnvironmentId, PeerCoordSession, PeerStaleReads } from "@t3tools/contracts";
import {
  coordinationScopeLabel,
  inputReadiness,
  inputReadinessLabels,
  type CoordinationTaskName,
} from "@t3tools/client-runtime/coordinationTimeline";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CircleAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

interface Props {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  sessions: readonly PeerCoordSession[];
  tasks: readonly CoordinationTaskName[];
}

/** Receipts can change without a new context version. Refresh only while this view is visible. */
export function useCoordinationRefresh(refresh: () => void) {
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [refresh]);
}

export function SharedInputs(props: Props) {
  const sessions = props.sessions.filter((session) => session.environment !== undefined);
  if (sessions.length === 0) return null;
  return (
    <section aria-label="Shared inputs" className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-medium">Shared inputs</h2>
      {sessions.map((session) => (
        <AgentInputs key={`${session.environment}:${session.id}`} {...props} session={session} />
      ))}
    </section>
  );
}

function AgentInputs({
  environmentId,
  workspace,
  project,
  tasks,
  session,
}: Props & { session: PeerCoordSession }) {
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    serverEnvironment.peerHubStaleReads({
      environmentId,
      input: { workspace, project, session: session.id, environment: session.environment! },
    }),
  );
  useCoordinationRefresh(query.refresh);
  const data = query.error === null ? query.data : null;
  const state = data === null ? null : inputReadiness(data);
  const [comparing, setComparing] = useState<string | null>(null);
  const stale = data?.stale ?? [];
  return (
    <div className="min-w-0 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium">{session.label}</p>
          <p className="text-xs text-muted-foreground">
            {session.id.startsWith("codex:")
              ? "Codex"
              : session.id.startsWith("claude:")
                ? "Claude"
                : "Agent"}{" "}
            · {session.local ? "This computer" : "Other computer"}
          </p>
        </div>
        <span role="status">
          <Badge
            variant={state === "stale" ? "warning" : state === "current" ? "success" : "secondary"}
          >
            {state === "stale" ? (
              <CircleAlertIcon aria-hidden />
            ) : state === "current" ? (
              <CheckIcon aria-hidden />
            ) : null}
            {state === null
              ? query.error === null
                ? "Checking…"
                : "Check unavailable"
              : inputReadinessLabels[state]}
          </Badge>
        </span>
      </div>
      {query.error !== null ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-muted-foreground">
            Could not check input versions.
          </p>
          <Button size="xs" variant="outline" onClick={query.refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {state === "stale" ? (
        <p className="mt-3 text-sm">Agent must update these inputs before handoff.</p>
      ) : null}
      {stale.map((read) => (
        <div key={read.scope} className="mt-3 border-t border-border pt-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="break-words text-sm font-medium">
                {coordinationScopeLabel(read.scope, tasks)}
              </p>
              <p className="mt-1 text-sm tabular-nums">
                <span className="text-muted-foreground">Read v{read.readVersion}</span>{" "}
                <span aria-hidden>→</span>{" "}
                <strong>
                  {read.currentVersion === null
                    ? "Context removed"
                    : `Latest v${read.currentVersion}`}
                </strong>
              </p>
            </div>
            {read.currentVersion === null ? null : (
              <Button
                size="sm"
                variant="outline"
                aria-expanded={comparing === read.scope}
                onClick={() => setComparing(comparing === read.scope ? null : read.scope)}
              >
                {comparing === read.scope ? "Hide comparison" : "Compare versions"}
              </Button>
            )}
          </div>
          {comparing === read.scope && read.currentVersion !== null ? (
            <ContextComparison
              key={`${read.scope}:${read.readVersion}:${read.currentVersion}`}
              {...{ environmentId, workspace, project, read }}
            />
          ) : null}
        </div>
      ))}
      {data?.reads !== undefined && data.reads.length > 0 ? (
        <details open={state === "current"} className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {data.reads.length} {data.reads.length === 1 ? "context read" : "contexts read"}
          </summary>
          <ul className="mt-2 space-y-2">
            {data.reads.map((read) => (
              <li key={read.scope} className="flex min-w-0 items-center justify-between gap-2">
                <button
                  type="button"
                  className="min-w-0 break-words text-left text-sm underline-offset-4 hover:underline"
                  onClick={() =>
                    void navigate({
                      to: "/context/$workspace/$project/$scope",
                      params: { workspace, project, scope: read.scope },
                    })
                  }
                >
                  {coordinationScopeLabel(read.scope, tasks)}
                </button>
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  Read v{read.version}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function ContextComparison({
  environmentId,
  workspace,
  project,
  read,
}: Pick<Props, "environmentId" | "workspace" | "project"> & {
  read: PeerStaleReads["stale"][number];
}) {
  return (
    <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-2">
      <ContextVersion
        {...{ environmentId, workspace, project }}
        scope={read.scope}
        version={read.readVersion}
        label="Agent read"
      />
      <ContextVersion
        {...{ environmentId, workspace, project }}
        scope={read.scope}
        version={read.currentVersion!}
        label="Latest"
      />
    </div>
  );
}

function ContextVersion({
  environmentId,
  workspace,
  project,
  scope,
  version,
  label,
}: Pick<Props, "environmentId" | "workspace" | "project"> & {
  scope: string;
  version: number;
  label: string;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.peerHubReadContextVersion({
      environmentId,
      input: { workspace, project, scope, version },
    }),
  );
  return (
    <div className="min-w-0 rounded-md bg-muted/40 p-3">
      <h3 className="mb-3 text-xs font-medium text-muted-foreground">
        {label} · v{version}
      </h3>
      {query.error !== null ? (
        <p role="alert" className="text-sm">
          This version is unavailable.
        </p>
      ) : query.data === null ? (
        <p role="status" className="text-sm">
          Loading…
        </p>
      ) : (
        <ChatMarkdown text={query.data.text} cwd={undefined} />
      )}
    </div>
  );
}
