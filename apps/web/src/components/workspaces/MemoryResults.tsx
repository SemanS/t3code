import type { PeerMemoryRecordRef, PeerMemorySearchResult } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { MemoryRecords, MEMORY_TABS, type MemoryTab } from "./MemoryRecords";

export function MemoryResults({
  records,
  error,
  tab,
  cursor,
  selected,
  onSelect,
  onOpen,
  onCursor,
}: {
  records: PeerMemorySearchResult | null;
  error: string | null;
  tab: MemoryTab;
  cursor: number;
  selected: readonly PeerMemoryRecordRef[];
  onSelect: (ref: PeerMemoryRecordRef, checked: boolean) => void;
  onOpen: (ref: PeerMemoryRecordRef) => void;
  onCursor: (cursor: number) => void;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label="Memory records">
      <h2 className="text-sm font-medium">
        {MEMORY_TABS.find((item) => item.value === tab)?.label}
      </h2>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : records ? (
        <>
          {records.traversalIncomplete ? (
            <p role="status" className="text-xs text-warning">
              Related records exceed the search traversal limit. These results may omit related
              context; an exact projection includes its required sources or reports an error.
            </p>
          ) : null}
          <MemoryRecords
            result={records}
            tab={tab}
            selected={selected}
            onSelect={onSelect}
            onOpen={onOpen}
          />
          <p className="text-xs text-muted-foreground">
            {records.records.length} records on this page · memory watermark{" "}
            {records.memoryWatermark}
            {tab === "review" ? " · review covers this page" : ""}
          </p>
          <div className="flex gap-2">
            {cursor > 0 ? (
              <Button size="sm" variant="outline" onClick={() => onCursor(0)}>
                First page
              </Button>
            ) : null}
            {records.hasMore ? (
              <Button size="sm" variant="outline" onClick={() => onCursor(records.cursor)}>
                Next page
              </Button>
            ) : null}
          </div>
        </>
      ) : (
        <div
          role="status"
          aria-busy="true"
          className="rounded-md border border-border p-5 text-sm text-muted-foreground"
        >
          Loading memory…
        </div>
      )}
    </section>
  );
}
