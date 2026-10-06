import type { PeerHubMemoryImportKnowledgeInput } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { MemoryField } from "./MemoryFields";

export function MemoryImport({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: (
    input: Pick<PeerHubMemoryImportKnowledgeInput, "repositoryId" | "commit" | "reviewRef">,
  ) => Promise<void>;
}) {
  return (
    <details>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Import reviewed .ai knowledge
      </summary>
      <form
        className="flex flex-col gap-3 pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          const values = new FormData(event.currentTarget);
          void onImport({
            repositoryId: String(values.get("repositoryId")),
            commit: String(values.get("commit")),
            reviewRef: String(values.get("reviewRef")),
          });
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <MemoryField label="Repository ID" name="repositoryId" required />
          <MemoryField label="Reviewed commit" name="commit" required />
          <MemoryField label="Git review reference" name="reviewRef" required />
        </div>
        <div>
          <Button size="sm" variant="outline" type="submit" disabled={busy}>
            Import reviewed knowledge
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The service verifies the configured Git review proof. A staged file or an agent-written
          approval is insufficient.
        </p>
      </form>
    </details>
  );
}
