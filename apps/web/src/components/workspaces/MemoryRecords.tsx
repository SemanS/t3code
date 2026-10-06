import type {
  PeerMemoryRecord,
  PeerMemoryRecordRef,
  PeerMemorySearchResult,
} from "@t3tools/contracts";
import { memoryKnowledgeLabel, memoryReviewReasons } from "@t3tools/client-runtime/peer-memory";
import { Checkbox } from "../ui/checkbox";

export type MemoryTab = "all" | "topics" | "assertions" | "questions" | "review";
export const MEMORY_TABS: readonly { value: MemoryTab; label: string }[] = [
  { value: "all", label: "All" },
  { value: "topics", label: "Topics" },
  { value: "assertions", label: "Assertions" },
  { value: "questions", label: "Questions" },
  { value: "review", label: "Review" },
];

export function memoryTabIncludes(
  tab: MemoryTab,
  record: PeerMemoryRecord,
  conflicts: readonly PeerMemoryRecord[],
) {
  return (
    tab === "all" ||
    (tab === "topics" && record.kind === "context") ||
    (tab === "assertions" && record.kind === "assertion") ||
    (tab === "questions" && record.kind === "question" && record.question?.closed !== true) ||
    (tab === "review" && memoryReviewReasons(record, conflicts).length > 0)
  );
}

export function MemoryRecords({
  result,
  tab,
  selected,
  onSelect,
  onOpen,
}: {
  result: PeerMemorySearchResult;
  tab: MemoryTab;
  selected: readonly PeerMemoryRecordRef[];
  onSelect: (ref: PeerMemoryRecordRef, checked: boolean) => void;
  onOpen: (ref: PeerMemoryRecordRef) => void;
}) {
  const rows = result.records.filter(({ record, conflicts }) =>
    memoryTabIncludes(tab, record, conflicts),
  );
  if (rows.length === 0)
    return (
      <p role="status" className="py-8 text-sm text-muted-foreground">
        {tab === "questions"
          ? "No open questions on this page."
          : tab === "review"
            ? "Nothing needs review on this page."
            : "No memory matches on this page."}
      </p>
    );
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map(({ record, conflicts, whyIncluded }) => {
        const ref = { id: record.id, version: record.version };
        const reasons = memoryReviewReasons(record, conflicts);
        return (
          <li key={`${record.id}@${record.version}`} className="flex min-w-0 items-start gap-3 p-3">
            <div className="pt-1">
              <Checkbox
                aria-label={`Select ${record.title}, version ${record.version} for a projection`}
                checked={selected.some(
                  (item) => item.id === ref.id && item.version === ref.version,
                )}
                onCheckedChange={(checked) => onSelect(ref, checked)}
              />
            </div>
            <button
              type="button"
              className="flex min-w-0 flex-1 flex-col gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpen(ref)}
            >
              <span className="line-clamp-2 break-words text-sm font-medium">
                {record.title || record.id}
              </span>
              <span className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {record.kind} · v{record.version}
                </span>
                <span>
                  {record.lifecycle} · {record.grounding}
                </span>
                {memoryKnowledgeLabel(record) ? <span>{memoryKnowledgeLabel(record)}</span> : null}
              </span>
              {record.applicability.revision ? (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  Commit {record.applicability.revision}
                </span>
              ) : null}
              {reasons.length > 0 ? (
                <span className="text-xs text-warning">{reasons.join(" · ")}</span>
              ) : null}
              {whyIncluded.length > 0 ? (
                <span className="text-xs text-muted-foreground">{whyIncluded.join(" · ")}</span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
