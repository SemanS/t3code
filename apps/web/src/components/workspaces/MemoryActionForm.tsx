import type { PeerMemoryCommand, PeerMemoryRecord } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Button } from "../ui/button";
import { randomUUID } from "../../lib/utils";
import { MemoryActionFields } from "./MemoryActionFields";
import { buildMemoryAction, MEMORY_ACTIONS, type MemoryAction } from "./memory.actions";
import { MemorySelect } from "./MemoryFields";

function recordActions(record?: PeerMemoryRecord | undefined): MemoryAction[] {
  if (record === undefined) return ["assertion", "context", "question", "decision"];
  const common: MemoryAction[] = ["attach", "link", "restore", "publish", "retract", "erase"];
  if (record.kind === "assertion") return ["correct", "attest", "dispute", "supersede", ...common];
  if (record.kind === "context") return ["update", "move", "merge", "split", "archive", ...common];
  if (record.kind === "decision") return ["approve", "reject", "replace", ...common];
  if (record.kind === "question") return ["answer", "close", ...common];
  if (record.kind === "relation")
    return [
      "end",
      ...(record.relation?.relation === "contradicts" ? ["resolve" as const] : []),
      "restore",
    ];
  if (record.kind === "knowledge") return ["rejectKnowledge", ...common];
  return common;
}

export function MemoryActionForm({
  record,
  busy,
  onExecute,
  onCancel,
}: {
  record?: PeerMemoryRecord | undefined;
  busy: boolean;
  onExecute: (command: PeerMemoryCommand) => Promise<boolean>;
  onCancel: () => void;
}) {
  const options = recordActions(record);
  const [action, setAction] = useState<MemoryAction>(options[0]!);
  const [error, setError] = useState<string | null>(null);
  const operationId = useRef<string | null>(null);
  const submit = async (form: HTMLFormElement) => {
    setError(null);
    try {
      const fields = Object.fromEntries(
        [...new FormData(form)].map(([key, value]) => [key, String(value)]),
      );
      operationId.current ??= randomUUID();
      const command = buildMemoryAction(action, fields, operationId.current, record);
      if (await onExecute(command)) {
        operationId.current = null;
        onCancel();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Check the fields and try again.");
    }
  };
  return (
    <section
      className="flex flex-col gap-4 rounded-md border border-border p-4"
      aria-label={record ? "Change memory" : "Add memory"}
    >
      {record ? (
        <h3 className="break-all text-sm font-medium">
          Change {record.id}@{record.version}
        </h3>
      ) : (
        <h2 className="text-sm font-medium">Add memory</h2>
      )}
      <MemorySelect
        disabled={busy}
        label="Action"
        name="action"
        value={action}
        options={options.map((value) => ({ value, label: MEMORY_ACTIONS[value] }))}
        onChange={(value) => {
          if (value in MEMORY_ACTIONS) {
            setAction(value as MemoryAction);
            setError(null);
            operationId.current = null;
          }
        }}
      />
      <form
        key={action}
        onChange={() => {
          operationId.current = null;
        }}
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(event.currentTarget);
        }}
      >
        <MemoryActionFields action={action} record={record} />
        {error ? (
          <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" className="max-w-full" disabled={busy}>
            <span className="truncate">{busy ? "Saving…" : MEMORY_ACTIONS[action]}</span>
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </section>
  );
}
