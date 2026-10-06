import type { EnvironmentId, PeerCoordSession } from "@t3tools/contracts";
import {
  coordinationEventLabel,
  coordinationTimeline,
  staleInputSummary,
} from "@t3tools/client-runtime/coordinationTimeline";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";

interface Props {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  task?: string;
  revision?: string | undefined;
  sessions?: readonly PeerCoordSession[];
}

const NO_SESSIONS: readonly PeerCoordSession[] = [];

export function PeerCoordTimeline({
  environmentId,
  workspace,
  project,
  task,
  revision,
  sessions = NO_SESSIONS,
}: Props) {
  const history = useEnvironmentQuery(
    serverEnvironment.peerHubCoordEvents({
      environmentId,
      input: { workspace, project, ...(task === undefined ? {} : { task }), limit: 50, revision },
    }),
  );
  return (
    <section aria-label="Coordination history" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">Coordination history</h2>
        <Button
          variant="ghost"
          size="xs"
          disabled={history.isPending}
          onClick={() => history.refresh()}
        >
          Refresh
        </Button>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Shared decisions and exact input versions. Private working notes stay with each agent.
      </p>
      {history.error !== null ? (
        <p role="alert" className="text-xs text-muted-foreground">
          {history.error}
        </p>
      ) : history.data === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          Loading history…
        </p>
      ) : history.data.length === 0 ? (
        <p className="text-xs text-muted-foreground">No coordination events yet.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {coordinationTimeline(history.data).map((event) => (
            <li key={event.id} className="min-w-0 border-l border-border pl-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-xs font-medium">{coordinationEventLabel(event)}</span>
                <time dateTime={event.at} className="text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleString()}
                </time>
              </div>
              <p className="break-words text-xs text-muted-foreground">
                {[event.session ?? event.email, event.scope, event.paths.join(", ")]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ol>
      )}
      {sessions
        .filter((session) => session.environment !== undefined)
        .map((session) => (
          <InputVersions
            key={`${session.environment}:${session.id}`}
            {...{ environmentId, workspace, project, revision, session }}
          />
        ))}
    </section>
  );
}

function InputVersions({
  environmentId,
  workspace,
  project,
  revision,
  session,
}: Omit<Props, "task" | "sessions"> & { session: PeerCoordSession }) {
  const [checking, setChecking] = useState(false);
  const reads = useEnvironmentQuery(
    checking && session.environment !== undefined
      ? serverEnvironment.peerHubStaleReads({
          environmentId,
          input: {
            workspace,
            project,
            session: session.id,
            environment: session.environment,
            revision,
          },
        })
      : null,
  );
  return (
    <div className="mt-3 text-xs">
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          setChecking(true);
          reads.refresh();
        }}
      >
        Check {session.label}’s shared inputs
      </Button>
      {checking ? (
        <p role="status" className="mt-1 break-words text-muted-foreground">
          {reads.error ??
            (reads.data === null ? "Checking versions…" : staleInputSummary(reads.data))}
        </p>
      ) : null}
    </div>
  );
}
