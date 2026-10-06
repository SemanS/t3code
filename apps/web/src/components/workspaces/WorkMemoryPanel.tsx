import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { MemoryDelivery } from "./MemoryDelivery";

export function WorkMemoryPanel({
  environmentId,
  workspace,
  project,
  scope,
}: {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  scope: string;
}) {
  const navigate = useNavigate();
  const state = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryState({ environmentId, input: { workspace, project } }),
  );
  const search = useEnvironmentQuery(
    serverEnvironment.peerHubMemorySearch({
      environmentId,
      input: {
        workspace,
        project,
        search: {
          contextIds: [],
          ...(scope.startsWith("task:") ? { taskId: scope.slice(5) } : {}),
          limit: 20,
        },
      },
    }),
  );
  const receipts = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryReceipts({ environmentId, input: { workspace, project } }),
  );
  const data = search.error === null && !search.isPending ? search.data : null;
  const delivery =
    receipts.error === null && !receipts.isPending ? (receipts.data?.receipts ?? []) : [];
  return (
    <section className="flex flex-col gap-3" aria-label="Memory relevant to this work">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Relevant memory</h2>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/memory/$workspace/$project",
              params: { workspace, project },
              search: {},
            })
          }
        >
          Open Memory
        </Button>
      </div>
      {state.data ? (
        <p className="text-xs text-muted-foreground">
          {state.data.available ? "Shared memory available" : "Memory unavailable"} ·{" "}
          {state.data.pendingLocal} pending locally · {state.data.blockedLocal} blocked · mode{" "}
          {state.data.mode}
        </p>
      ) : null}
      {search.error ? (
        <p role="alert" className="text-sm text-muted-foreground">
          {search.error}
        </p>
      ) : data === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading relevant findings…
        </p>
      ) : data.records.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No relevant memory found. Agent availability is shown separately below.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.records.map(({ record, whyIncluded, conflicts }) => (
            <li
              key={`${record.id}@${record.version}`}
              className="flex flex-col gap-2 rounded-md border border-border p-3"
            >
              <div>
                <Button
                  size="sm"
                  className="max-w-full"
                  variant="ghost"
                  onClick={() =>
                    void navigate({
                      to: "/memory/$workspace/$project",
                      params: { workspace, project },
                      search: { id: record.id, version: record.version },
                    })
                  }
                >
                  <span className="truncate">{record.title || record.id}</span>
                  <span className="shrink-0">· v{record.version}</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {record.kind} · {record.lifecycle} · {record.grounding}
                {record.question?.closed === false ? " · open question" : ""}
                {conflicts.length ? ` · ${conflicts.length} conflicts` : ""} ·{" "}
                {whyIncluded.join(" · ")}
              </p>
              <MemoryDelivery record={record} receipts={delivery} />
            </li>
          ))}
        </ul>
      )}
      {data?.hasMore ? (
        <p className="text-xs text-muted-foreground">More records are available in Memory.</p>
      ) : null}
      {receipts.error ? (
        <p role="alert" className="text-xs text-muted-foreground">
          Delivery is unverified: {receipts.error}
        </p>
      ) : null}
    </section>
  );
}
