import type { PeerMemoryMode, PeerMemoryState } from "@t3tools/contracts";
import { MemorySelect } from "./MemoryFields";

export function MemoryStatus({
  state,
  error,
  busy,
  onMode,
}: {
  state: PeerMemoryState | null;
  error: string | null;
  busy: boolean;
  onMode: (mode: PeerMemoryMode) => Promise<void>;
}) {
  if (state === null)
    return error ? (
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
    ) : (
      <p role="status" className="text-sm text-muted-foreground">
        Checking memory availability…
      </p>
    );
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <p role="status" className="text-xs">
        {state.available
          ? "Shared memory available"
          : "Memory unavailable · work remains available"}{" "}
        · {state.pendingLocal} pending locally · {state.blockedLocal} blocked · last sync{" "}
        {state.lastSyncAt ?? "not recorded"}
        {state.projectionAgeMs !== undefined
          ? ` · projection age ${Math.floor(state.projectionAgeMs / 1000)}s`
          : ""}
      </p>
      <div className="max-w-56">
        <MemorySelect
          label="Project memory mode"
          name="mode"
          value={state.mode}
          disabled={busy}
          options={[
            { value: "legacy", label: "Legacy" },
            { value: "shadow", label: "Shadow" },
            { value: "memory", label: "Memory" },
          ]}
          onChange={(mode) => {
            if (mode === "legacy" || mode === "shadow" || mode === "memory") void onMode(mode);
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Legacy keeps the existing context flow; shadow imports marked sources; memory shares
        explicit findings. Returning to legacy preserves records and pending operations.
      </p>
      <p className="text-xs text-muted-foreground">
        {state.capabilities
          .map((capability) => `${capability.adapter}: ${capability.mode}`)
          .join(" · ") || "No runtime capabilities reported"}
      </p>
    </div>
  );
}
