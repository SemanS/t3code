import type { ComponentProps } from "react";
import { Button } from "../ui/button";
import { MemoryRecordDetail } from "./MemoryRecordDetail";

type DetailProps = ComponentProps<typeof MemoryRecordDetail>;

export function MemoryDetailPanel({
  view,
  error,
  receiptsError,
  onClose,
  ...detail
}: Omit<DetailProps, "view"> & {
  view: DetailProps["view"] | null;
  error: string | null;
  receiptsError: string | null;
  onClose: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close detail
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : view ? (
        <MemoryRecordDetail
          key={`${view.record.id}@${view.record.version}`}
          view={view}
          {...detail}
        />
      ) : (
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          Loading record and history…
        </p>
      )}
      {receiptsError ? (
        <p role="alert" className="text-xs text-destructive">
          Delivery receipts unavailable: {receiptsError}
        </p>
      ) : null}
    </div>
  );
}
