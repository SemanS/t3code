import type { EnvironmentId, PeerMemoryChange, PeerMemoryRecordRef } from "@t3tools/contracts";
import { coalesceMemoryCriticalChanges } from "@t3tools/client-runtime/peer-memory";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";

export function MemoryChangesNotice({
  environmentId,
  workspace,
  project,
  watermark,
  onRefresh,
  onOpen,
}: {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  watermark: number;
  onRefresh: () => void;
  onOpen: (ref: PeerMemoryRecordRef) => void;
}) {
  const [after, setAfter] = useState(watermark);
  const [critical, setCritical] = useState<readonly PeerMemoryChange[]>([]);
  const [resync, setResync] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const loadChanges = useAtomQueryRunner(serverEnvironment.peerHubMemoryChanges, {
    reportFailure: false,
    refresh: true,
  });
  const refreshChanges = useEffectEvent(async (cursor = after) => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await loadChanges({
        environmentId,
        input: { workspace, project, after: cursor, limit: 100 },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not verify memory changes.");
        return;
      }
      setError(null);
      const changes = result.value;
      if (changes.resyncRequired && !resync) {
        setResync(true);
        onRefresh();
      }
      if (changes.cursor <= after) return;
      if (changes.changes.length > 0) {
        setCritical((previous) => coalesceMemoryCriticalChanges(previous, changes.changes));
        onRefresh();
      }
      setAfter(changes.cursor);
    } finally {
      inFlight.current = false;
    }
  });
  useEffect(() => {
    void refreshChanges(after);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshChanges();
    }, 15_000);
    const onFocus = () => {
      void refreshChanges();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [after]);
  if (error !== null)
    return (
      <p role="alert" className="text-xs text-muted-foreground">
        Memory change tracking is unavailable: {error}. Refresh to verify selected versions.
      </p>
    );
  if (!critical.length && !resync) return null;
  return (
    <section
      aria-label="Critical memory changes"
      className="flex flex-col gap-2 rounded-md border border-border p-3"
    >
      <p role="status" className="text-sm text-warning">
        {resync
          ? "Memory history requires a refresh. Previously delivered versions may be outdated."
          : "Conflicts or retractions changed memory. Review these versions before using an earlier projection."}
      </p>
      <ul className="flex flex-col gap-1">
        {critical.map((change) => (
          <li key={change.id}>
            <Button
              size="xs"
              variant="outline"
              className="max-w-full"
              onClick={() => onOpen(change)}
            >
              <span className="truncate">
                {change.id}@{change.version} · {change.type}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      <div>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            setCritical([]);
            setResync(false);
          }}
        >
          Dismiss reviewed changes
        </Button>
      </div>
    </section>
  );
}
