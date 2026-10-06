import type { PeerMemoryRecordView, PeerMemoryRecordRef } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { MemoryReferenceList } from "./MemoryReferenceList";

export function MemoryRecordSemantics({
  view,
  onOpen,
}: {
  view: PeerMemoryRecordView;
  onOpen: (ref: PeerMemoryRecordRef) => void;
}) {
  const record = view.record;
  return (
    <>
      {record.attestations?.length ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Attestations</h3>
          {record.attestations.map((attestation) => (
            <p
              key={`${attestation.at}:${attestation.author.email}:${attestation.method}`}
              className="text-xs"
            >
              {attestation.author.email} · {attestation.grounding} · {attestation.method} · scope:{" "}
              {attestation.scope} · {attestation.at}
            </p>
          ))}
        </section>
      ) : null}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Conflicts · {view.conflicts.length}</h3>
        {view.conflicts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No authorized unresolved conflict is recorded.
          </p>
        ) : (
          <>
            <p className="text-xs text-warning">
              Claims may differ by checkout, commit, environment, or valid time. Review both sources
              before deciding.
            </p>
            <MemoryReferenceList records={view.conflicts} onOpen={onOpen} />
          </>
        )}
      </section>
      {record.relation ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Relation</h3>
          <p className="break-all text-xs">
            {record.relation.from.kind} {record.relation.from.id} →{" "}
            {record.relation.relation.replaceAll("_", " ")} → {record.relation.to.kind}{" "}
            {record.relation.to.id} · {record.relation.resolved ? "resolved" : "open"}
          </p>
          <p className="text-sm">{record.relation.reason}</p>
        </section>
      ) : null}
      {record.decision ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Decision · {record.decision.status}</h3>
          <p className="whitespace-pre-wrap text-sm">{record.decision.reasons}</p>
          <p className="text-xs">
            Alternatives: {record.decision.alternatives.join("; ") || "None recorded"}
            {record.decision.approvedBy ? ` · approved by ${record.decision.approvedBy}` : ""}
          </p>
        </section>
      ) : null}
      {record.question ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            Question · {record.question.closed ? "closed" : "open"}
          </h3>
          <p className="text-xs">Owner: {record.question.owner ?? "Unassigned"}</p>
          {record.question.answers.map((answer) => (
            <div
              key={`${answer.at}:${answer.author.email}`}
              className="rounded-md border border-border p-3"
            >
              <p className="whitespace-pre-wrap text-sm">{answer.text}</p>
              <p className="text-xs text-muted-foreground">
                {answer.author.email} · {answer.at}
              </p>
              {answer.references.map((ref) => (
                <Button
                  key={`${ref.id}@${ref.version}`}
                  size="xs"
                  variant="ghost"
                  className="max-w-full"
                  onClick={() => onOpen(ref)}
                >
                  <span className="truncate">
                    {ref.id}@{ref.version}
                  </span>
                </Button>
              ))}
            </div>
          ))}
        </section>
      ) : null}
      {record.knowledge ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Knowledge review</h3>
          <p className="break-all text-xs">
            {record.knowledge.repositoryId} · {record.knowledge.path} ·{" "}
            {record.knowledge.knowledgeId}
          </p>
          <p className="break-all text-xs">
            Reviewed commit: {record.knowledge.commit ?? "Not imported"} · review:{" "}
            {record.knowledge.reviewRef ?? "Not recorded"}
          </p>
        </section>
      ) : null}
    </>
  );
}
