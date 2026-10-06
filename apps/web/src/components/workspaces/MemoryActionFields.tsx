import type { PeerMemoryRecord } from "@t3tools/contracts";
import type { MemoryAction } from "./memory.actions";
import { MemoryField, MemorySelect, MemoryEvidenceFields } from "./MemoryFields";

export function MemoryActionFields({
  action,
  record,
}: {
  action: MemoryAction;
  record?: PeerMemoryRecord | undefined;
}) {
  const newRecord = ["assertion", "context", "question", "decision"].includes(action);
  const text = [
    "assertion",
    "context",
    "question",
    "decision",
    "correct",
    "update",
    "answer",
    "publish",
  ].includes(action);
  const evidence = ["assertion", "correct", "attach", "attest", "dispute"].includes(action);
  const refs = ["supersede", "link", "merge", "answer"].includes(action);
  return (
    <>
      {["context", "update"].includes(action) ? (
        <>
          <MemoryField label="Topic title" name="title" required value={record?.title} />
          <MemoryField
            label="Aliases"
            name="aliases"
            value={record?.aliases.join(", ")}
            hint="Comma-separated."
          />
        </>
      ) : null}
      {text ? (
        <MemoryField
          label={
            action === "publish"
              ? "Generalized text for the target project"
              : action === "answer"
                ? "Answer"
                : "Text"
          }
          name="text"
          multiline
          required={action !== "context" && action !== "update"}
          value={record && ["correct", "update"].includes(action) ? record.text : undefined}
          hint={
            action === "publish"
              ? "Remove client-specific information. Publication does not expose private source references."
              : undefined
          }
        />
      ) : null}
      {action === "question" ? <MemoryField label="Question owner" name="owner" /> : null}
      {action === "decision" ? (
        <MemoryField
          label="Alternatives"
          name="alternatives"
          multiline
          hint="One alternative per line."
        />
      ) : null}
      {(newRecord && action !== "context") || action === "move" ? (
        <MemoryField
          label={action === "move" ? "Parent topic IDs" : "Relevant topic IDs"}
          name="contextIds"
          hint="Comma-separated IDs. References are checked against this scope."
        />
      ) : null}
      {refs ? (
        <MemoryField
          label={
            action === "merge"
              ? "Source topics"
              : action === "answer"
                ? "Supporting records"
                : "Target record"
          }
          name="references"
          required={action !== "answer"}
          hint="Exact references, such as assertion-id@3. Comma-separated for multiple records."
        />
      ) : null}
      {action === "link" ? (
        <MemorySelect
          label="Relation"
          name="relation"
          value="relates_to"
          options={[
            "contains",
            "relates_to",
            "relevant_to",
            "supports",
            "contradicts",
            "derived_from",
            "governed_by",
            "depends_on",
            "affects",
            "promoted_as",
          ].map((value) => ({ value, label: value.replaceAll("_", " ") }))}
        />
      ) : null}
      {action === "attest" ? (
        <>
          <MemoryField label="Verification method" name="method" required />
          <MemoryField
            label="Scope verified"
            name="attestationScope"
            required
            hint="State the checkout, test, or deployment covered."
          />
          <MemorySelect
            label="Grounding"
            name="grounding"
            value="corroborated"
            options={[
              { value: "corroborated", label: "Corroborated" },
              { value: "verified", label: "Verified by a human" },
            ]}
          />
        </>
      ) : null}
      {action === "split" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <MemoryField label="First topic title" name="firstTitle" required />
            <MemoryField
              label="First topic member IDs"
              name="firstMembers"
              multiline
              hint="Comma-separated. Each member must have an explicit destination."
            />
          </div>
          <div className="flex flex-col gap-3">
            <MemoryField label="Second topic title" name="secondTitle" required />
            <MemoryField label="Second topic member IDs" name="secondMembers" multiline />
          </div>
        </div>
      ) : null}
      {action === "restore" ? (
        <MemoryField
          label="Historical version to restore"
          name="version"
          type="number"
          required
          hint="Creates a new version. Original history remains available."
        />
      ) : null}
      {action === "publish" ? (
        <MemoryField label="Authorized target project ID" name="targetProjectId" required />
      ) : null}
      {!["assertion", "context", "question", "update", "attach", "attest", "answer"].includes(
        action,
      ) ? (
        <MemoryField label="Reason" name="reason" multiline required />
      ) : null}
      {evidence ? (
        <MemoryEvidenceFields
          repositoryId={record?.applicability.repositoryId}
          revision={record?.applicability.revision}
        />
      ) : null}
      {newRecord ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {!evidence ? (
              <>
                <MemoryField label="Repository ID" name="repositoryId" />
                <MemoryField label="Full commit" name="revision" />
              </>
            ) : null}
            <MemoryField label="Environment or checkout" name="environment" />
            <MemoryField label="Valid from" name="validFrom" type="datetime-local" />
            <MemoryField label="Valid until" name="validTo" type="datetime-local" />
          </div>
          <p className="text-xs text-muted-foreground">
            Times use your local timezone and are stored in UTC. Findings without evidence remain
            proposed.
          </p>
        </>
      ) : null}
      {action === "erase" ? (
        <>
          <p className="text-sm text-destructive">
            Erasure removes sensitive content from history and derived projections. It requires
            administrator permission and cannot be reversed.
          </p>
          <MemoryField label={`Type ${record?.id} to confirm`} name="confirmation" required />
        </>
      ) : null}
    </>
  );
}
