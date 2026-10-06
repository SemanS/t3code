import type { PeerMemoryRecordView, PeerMemoryRecordRef } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function MemoryReferenceList({
  records,
  onOpen,
}: {
  records: PeerMemoryRecordView["related"];
  onOpen: (ref: PeerMemoryRecordRef) => void;
}) {
  return (
    <ul className="flex flex-col gap-1">
      {records.map((record) => (
        <li key={`${record.id}@${record.version}`}>
          <Button variant="ghost" size="sm" className="max-w-full" onClick={() => onOpen(record)}>
            <span className="truncate">{record.title || record.id}</span>
            <span className="shrink-0">· v{record.version}</span>
          </Button>
        </li>
      ))}
    </ul>
  );
}
