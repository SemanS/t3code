import type {
  PeerMemoryCommand,
  PeerMemoryRecordRef,
  PeerMemoryRecordView,
  PeerMemoryReceipt,
} from "@t3tools/contracts";
import { memoryEvidenceSources, memoryKnowledgeLabel } from "@t3tools/client-runtime/peer-memory";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { MemoryActionForm } from "./MemoryActionForm";
import { MemoryDelivery } from "./MemoryDelivery";
import { MemoryEvidence } from "./MemoryEvidence";
import { MemoryRecordSemantics } from "./MemoryRecordSemantics";
import { MemoryReferenceList } from "./MemoryReferenceList";

export function MemoryRecordDetail({
  view,
  receipts,
  busy,
  onExecute,
  onOpen,
  onKeep,
  historicalQuery,
  onCurrent,
}: {
  view: PeerMemoryRecordView;
  receipts: readonly PeerMemoryReceipt[];
  busy: boolean;
  onExecute: (command: PeerMemoryCommand) => Promise<boolean>;
  onOpen: (ref: PeerMemoryRecordRef) => void;
  onKeep: (repositoryId: string) => Promise<void>;
  historicalQuery: boolean;
  onCurrent: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const record = view.record;
  const currentVersion = Math.max(record.version, ...view.history.map((item) => item.version));
  const historical = historicalQuery || currentVersion !== record.version;
  const evidence = memoryEvidenceSources(record, view.related);
  const metadata = [
    ["Scope", `${record.workspaceId} / ${record.projectId}`],
    ["Original author", record.createdBy.email],
    ["Version recorded by", record.recordedBy?.email],
    ["Session", record.createdBy.sessionId],
    ["Environment", record.createdBy.environmentId],
    ["Runtime generation", record.createdBy.runtimeGeneration],
    ["Created", record.createdAt],
    ["Known from", record.knownAt],
    ["Recorded", record.recordedAt],
    ["Observed", record.observedAt],
    ["Valid from", record.validFrom ?? "Not specified"],
    ["Valid until", record.validTo ?? "Not specified"],
    ["Repository", record.applicability.repositoryId],
    ["Commit", record.applicability.revision],
    ["Applies in", record.applicability.environment],
    ["Deployment", record.applicability.deployment],
    ["Base commit", record.applicability.baseRevision],
    ["Diff hash", record.applicability.diffHash],
    ["Evidence independence", record.independence],
    ["Content hash", record.contentHash],
  ];
  return (
    <article className="flex min-w-0 flex-col gap-6 rounded-md border border-border p-4 sm:p-5">
      <div className="flex flex-col gap-2">
        <h2 className="break-words text-base font-medium">{record.title || record.id}</h2>
        <p className="break-all text-xs text-muted-foreground">
          {record.id}@{record.version} · {record.kind} · {record.lifecycle} · {record.grounding}
        </p>
        {memoryKnowledgeLabel(record) ? (
          <p className="text-xs font-medium">{memoryKnowledgeLabel(record)}</p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{record.text}</p>
        {record.aliases.length ? (
          <p className="text-xs text-muted-foreground">Aliases: {record.aliases.join(", ")}</p>
        ) : null}
      </div>
      {historical ? (
        <p role="status" className="text-sm text-warning">
          Viewing historical version {record.version}.{" "}
          <Button size="xs" variant="outline" onClick={onCurrent}>
            Open current version
          </Button>
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(!editing)}>
            {editing ? "Close changes" : "Edit, review, or organize"}
          </Button>
        </div>
      )}
      {editing && !historical ? (
        <MemoryActionForm
          key={`${record.id}@${record.version}`}
          record={record}
          busy={busy}
          onExecute={onExecute}
          onCancel={() => setEditing(false)}
        />
      ) : null}
      {!historical && record.kind === "assertion" && record.lifecycle === "active" ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void onKeep(repositoryId.trim() || record.applicability.repositoryId || "");
          }}
        >
          <label className="text-xs font-medium" htmlFor={`keep-${record.id}`}>
            Repository ID for .ai proposal
          </label>
          <Input
            id={`keep-${record.id}`}
            value={repositoryId}
            placeholder={record.applicability.repositoryId ?? "Repository ID"}
            onChange={(event) => setRepositoryId(event.target.value)}
            required={!record.applicability.repositoryId}
          />
          <div>
            <Button type="submit" size="sm" variant="outline" disabled={busy}>
              Keep for Git review
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Keep prepares a proposal. It becomes approved knowledge only after a reviewed Git commit
            is imported.
          </p>
        </form>
      ) : null}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Provenance and applicability</h3>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-[8rem_1fr]">
          {metadata
            .filter(([, value]) => value !== undefined)
            .map(([label, value]) => (
              <div className="contents" key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
        </dl>
      </section>
      <MemoryEvidence sources={evidence} />
      <MemoryRecordSemantics view={view} onOpen={onOpen} />
      <MemoryDelivery record={record} receipts={receipts} />
      {view.related.length || record.derivedFrom.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Related records and derivation</h3>
          <MemoryReferenceList records={view.related} onOpen={onOpen} />
          {record.derivedFrom.map((ref) => (
            <Button
              key={`${ref.id}@${ref.version}`}
              size="xs"
              variant="ghost"
              className="max-w-full"
              onClick={() => onOpen(ref)}
            >
              <span className="truncate">
                Derived from {ref.id}@{ref.version}
              </span>
            </Button>
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">History</h3>
        <ul className="flex flex-col gap-2">
          {view.history.map((version) => (
            <li key={version.version}>
              <Button
                variant="ghost"
                size="xs"
                className="max-w-full"
                onClick={() => onOpen(version)}
              >
                <span className="truncate">
                  Version {version.version} · {version.lifecycle} · recorded {version.recordedAt}
                </span>
              </Button>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Valid time describes the world; known time describes when this scope learned it. Earlier
          history missing from a legacy import remains unavailable.
        </p>
      </section>
    </article>
  );
}
