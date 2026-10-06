import type { PeerMemoryRecordRef, PeerMemoryReceipt } from "@t3tools/contracts";
import { memoryDeliveryStates } from "@t3tools/client-runtime/peer-memory";

export function MemoryDelivery({
  record,
  receipts,
}: {
  record: PeerMemoryRecordRef;
  receipts: readonly PeerMemoryReceipt[];
}) {
  const delivery = memoryDeliveryStates(record, receipts);
  return (
    <section className="flex flex-col gap-3" aria-label="Runtime delivery">
      <h3 className="text-sm font-medium">
        Runtime delivery · {record.id}@{record.version}
      </h3>
      {delivery.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Available in shared memory. Runtime delivery is unverified.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {delivery.map((state) => (
            <li
              key={JSON.stringify([
                state.email,
                state.runtimeProjectId,
                state.environmentId,
                state.sessionId,
                state.runtimeGeneration,
              ])}
              className="rounded-md border border-border p-3"
            >
              <p className="text-sm font-medium">
                {state.state === "consumed"
                  ? "Used in an evidenced result"
                  : state.state === "acknowledged"
                    ? "Acknowledged by agent"
                    : state.state === "delivered"
                      ? "Delivered to runtime"
                      : "Requested · delivery unverified"}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {state.email}
                {state.runtimeProjectId ? ` · project ${state.runtimeProjectId}` : ""} · session{" "}
                {state.sessionId ?? "unrecorded"} · runtime{" "}
                {state.runtimeGeneration ?? "unrecorded"} ·{" "}
                {state.environmentId ?? "environment unrecorded"}
              </p>
              <p className="text-xs text-muted-foreground">
                <time dateTime={state.at}>{new Date(state.at).toLocaleString()}</time>
                {state.projectionId ? ` · projection ${state.projectionId}` : ""}
              </p>
              {state.outputRef ? (
                <p className="break-words text-xs">
                  Result evidence:{" "}
                  {state.outputRef.path ??
                    state.outputRef.command ??
                    state.outputRef.url ??
                    state.outputRef.kind}
                  {state.outputRef.revision ? ` @ ${state.outputRef.revision}` : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        A receipt records delivery or explicit use of this version. It does not establish that an
        agent understands it. A human preview creates no agent receipt.
      </p>
    </section>
  );
}
