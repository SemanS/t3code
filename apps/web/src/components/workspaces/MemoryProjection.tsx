import type { PeerMemoryProjection, PeerMemoryRecordRef } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { MemoryField } from "./MemoryFields";

export function MemoryProjectionPanel({
  selected,
  projection,
  busy,
  onProject,
  onRemove,
}: {
  selected: readonly PeerMemoryRecordRef[];
  projection: PeerMemoryProjection | null;
  busy: boolean;
  onProject: (purpose: string, budget: number) => Promise<void>;
  onRemove: (ref: PeerMemoryRecordRef) => void;
}) {
  if (selected.length === 0 && projection === null) return null;
  return (
    <section
      className="flex flex-col gap-3 rounded-md border border-border p-4"
      aria-label="Selected projection"
    >
      <h2 className="text-sm font-medium">Selected projection · {selected.length} records</h2>
      <ul className="flex flex-wrap gap-2">
        {selected.map((ref) => (
          <li key={`${ref.id}@${ref.version}`} className="min-w-0 max-w-full">
            <Button
              size="xs"
              className="max-w-full"
              variant="outline"
              onClick={() => onRemove(ref)}
              aria-label={`Remove ${ref.id} version ${ref.version} from selection`}
            >
              <span className="truncate">
                {ref.id}@{ref.version}
              </span>
              <span aria-hidden>×</span>
            </Button>
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void onProject(String(values.get("purpose") ?? ""), Number(values.get("budget")));
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <MemoryField label="Purpose" name="purpose" required />
          <MemoryField
            label="Estimated token budget"
            name="budget"
            type="number"
            value="3000"
            required
            hint="32–32,000; estimate uses characters ÷ 4."
          />
        </div>
        <div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || selected.length === 0}
          >
            {busy ? "Preparing…" : "Preview selected versions"}
          </Button>
        </div>
      </form>
      {projection ? (
        <>
          <p className="break-all text-xs text-muted-foreground">
            Manifest {projection.manifest.id} · {projection.manifest.createdAt} · memory watermark{" "}
            {projection.manifest.memoryWatermark} · {projection.manifest.tokenEstimate} estimated
            tokens
          </p>
          <p className="break-all text-xs">
            Included versions:{" "}
            {projection.manifest.selected.map((ref) => `${ref.id}@${ref.version}`).join(", ")}
          </p>
          {projection.manifest.omitted.length ? (
            <p className="text-xs text-warning">
              Omitted from this budget:{" "}
              {projection.manifest.omitted.map((ref) => `${ref.id}@${ref.version}`).join(", ")}
            </p>
          ) : null}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Manifest and requested filters
            </summary>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all pt-2 text-xs">
              {JSON.stringify(projection.manifest, null, 2)}
            </pre>
          </details>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs leading-relaxed">
            {projection.text}
          </pre>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        This is a human preview. Runtime delivery is recorded separately when an agent accepts the
        selected versions.
      </p>
    </section>
  );
}
