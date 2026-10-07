import type { EnvironmentId, PeerCoordSession } from "@t3tools/contracts";
import {
  coordinationActorLabel,
  coordinationEventLabel,
  coordinationScopeLabel,
  coordinationTimeline,
  type CoordinationTaskName,
} from "@t3tools/client-runtime/coordinationTimeline";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { useCoordinationRefresh } from "./SharedInputs";

interface Props {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  task?: string;
  revision?: string | undefined;
  sessions?: readonly PeerCoordSession[];
  tasks?: readonly CoordinationTaskName[];
}

const NO_SESSIONS: readonly PeerCoordSession[] = [];
const NO_TASKS: readonly CoordinationTaskName[] = [];

export function PeerCoordTimeline({
  environmentId,
  workspace,
  project,
  task,
  revision,
  sessions = NO_SESSIONS,
  tasks = NO_TASKS,
}: Props) {
  const [open, setOpen] = useState(false);
  const history = useEnvironmentQuery(
    open
      ? serverEnvironment.peerHubCoordEvents({
          environmentId,
          input: {
            workspace,
            project,
            ...(task === undefined ? {} : { task }),
            limit: 50,
            revision,
          },
        })
      : null,
  );
  useCoordinationRefresh(history.refresh);
  return (
    <section aria-label="Coordination history" className="min-w-0 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="text-sm font-medium hover:underline"
        >
          {open ? "Hide activity" : "Coordination history"}
        </button>
        {open ? (
          <Button variant="ghost" size="xs" disabled={history.isPending} onClick={history.refresh}>
            Refresh
          </Button>
        ) : null}
      </div>
      {!open ? null : history.error !== null ? (
        <p role="alert" className="mt-3 text-sm text-muted-foreground">
          {history.error}
        </p>
      ) : history.data === null ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Loading history…
        </p>
      ) : history.data.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ol className="mt-4 flex flex-col gap-4">
          {coordinationTimeline(history.data).map((event) => (
            <li key={event.id} className="min-w-0 border-l border-border pl-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-sm font-medium">{coordinationEventLabel(event)}</span>
                <time dateTime={event.at} className="text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleString([], {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                {[
                  coordinationActorLabel(event, sessions),
                  event.scope === undefined
                    ? undefined
                    : coordinationScopeLabel(event.scope, tasks),
                  event.paths.join(", "),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
