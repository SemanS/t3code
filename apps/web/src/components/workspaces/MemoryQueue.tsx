import type { EnvironmentId, PeerMemoryScope } from "@t3tools/contracts";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MemoryField } from "./MemoryFields";
import { reportFailure } from "./WorkPanel";

export function MemoryQueue({
  environmentId,
  scope,
  onChange,
}: {
  environmentId: EnvironmentId;
  scope: PeerMemoryScope;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const queue = useEnvironmentQuery(
    open ? serverEnvironment.peerHubMemoryQueue({ environmentId, input: scope }) : null,
  );
  const retryOperation = useAtomCommand(serverEnvironment.peerHubMemoryRetry, {
    reportFailure: false,
  });
  const discardOperation = useAtomCommand(serverEnvironment.peerHubMemoryDiscard, {
    reportFailure: false,
  });
  const data = queue.error === null && !queue.isPending ? queue.data : null;
  const refresh = () => {
    queue.refresh();
    onChange();
  };
  const retry = async (operationId: string) => {
    setBusy(operationId);
    try {
      const result = await retryOperation({ environmentId, input: { ...scope, operationId } });
      if (
        reportFailure("Could not retry the memory operation", result) &&
        result._tag === "Success"
      ) {
        setNotice(
          result.value.status === "stored"
            ? "Stored in shared memory."
            : "Still pending locally · not shared.",
        );
        refresh();
      }
    } finally {
      setBusy(null);
    }
  };
  const discard = async (operationId: string, reason: string) => {
    setBusy(operationId);
    try {
      const result = await discardOperation({
        environmentId,
        input: { ...scope, operationId, reason },
      });
      if (
        reportFailure("Could not discard the local operation", result) &&
        result._tag === "Success"
      ) {
        setNotice(`Discarded ${operationId}. Shared memory was not changed.`);
        refresh();
      }
    } finally {
      setBusy(null);
    }
  };
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Pending and blocked local operations
      </summary>
      {open ? (
        <div className="flex flex-col gap-3 pt-3">
          <p className="text-xs text-muted-foreground">
            Pending operations have not been shared. Retry resends the original operation and its
            expected version. For a version conflict, inspect the current record, create a new
            change, then discard the blocked original with a reason.
          </p>
          <div>
            <Button size="xs" variant="outline" onClick={() => queue.refresh()}>
              Refresh local queue
            </Button>
          </div>
          {notice ? (
            <p role="status" className="text-sm">
              {notice}
            </p>
          ) : null}
          {queue.error ? (
            <p role="alert" className="text-sm text-destructive">
              {queue.error}
            </p>
          ) : data === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading local operations…
            </p>
          ) : data.operations.length === 0 ? (
            <p role="status" className="text-sm text-muted-foreground">
              No local operations are waiting.
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {data.operations.map((operation) => (
                <li
                  key={operation.operationId}
                  className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3"
                >
                  <p className="break-all text-sm font-medium">
                    {operation.command.type} · {operation.status}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {operation.operationId} · {operation.at}
                  </p>
                  {operation.blockedReason ? (
                    <p className="break-words text-sm text-warning">{operation.blockedReason}</p>
                  ) : null}
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Original command and scope
                    </summary>
                    <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-all pt-2 text-xs">
                      {JSON.stringify(operation.command, null, 2)}
                    </pre>
                  </details>
                  <div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void retry(operation.operationId)}
                    >
                      Retry original operation
                    </Button>
                  </div>
                  <form
                    className="flex flex-col gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = new FormData(event.currentTarget);
                      void discard(operation.operationId, String(values.get("reason")).trim());
                    }}
                  >
                    <MemoryField
                      label="Reason to discard this unshared operation"
                      name="reason"
                      required
                    />
                    <div>
                      <Button
                        type="submit"
                        size="sm"
                        variant="destructive"
                        disabled={busy !== null}
                      >
                        Discard local operation
                      </Button>
                    </div>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </details>
  );
}
