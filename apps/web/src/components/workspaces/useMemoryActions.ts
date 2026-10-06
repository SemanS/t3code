import type {
  EnvironmentId,
  PeerHubMemoryImportKnowledgeInput,
  PeerMemoryCommand,
  PeerMemoryMode,
  PeerMemoryProjection,
  PeerMemoryRecordRef,
  PeerMemoryScope,
} from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { reportFailure } from "./WorkPanel";
import type { MemorySearchFilters } from "./MemorySearchForm";

export function useMemoryActions(
  environmentId: EnvironmentId,
  scope: PeerMemoryScope,
  selected: readonly PeerMemoryRecordRef[],
  filters: MemorySearchFilters,
  refresh: () => void,
  record: PeerMemoryRecordRef | undefined,
) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [projection, setProjection] = useState<PeerMemoryProjection | null>(null);
  const executeCommand = useAtomCommand(serverEnvironment.peerHubMemoryExecute, {
    reportFailure: false,
  });
  const makeProjection = useAtomCommand(serverEnvironment.peerHubMemoryProject, {
    reportFailure: false,
  });
  const keepCommand = useAtomCommand(serverEnvironment.peerHubMemoryKeep, { reportFailure: false });
  const importKnowledge = useAtomCommand(serverEnvironment.peerHubMemoryImportKnowledge, {
    reportFailure: false,
  });
  const setMode = useAtomCommand(serverEnvironment.peerHubMemorySetMode, { reportFailure: false });

  const execute = async (command: PeerMemoryCommand) => {
    setBusy(true);
    try {
      const result = await executeCommand({ environmentId, input: { ...scope, command } });
      if (!reportFailure("Memory change failed", result) || result._tag !== "Success") return false;
      setNotice(
        result.value.status === "stored"
          ? `Stored in shared memory · operation ${result.value.operationId}`
          : `Pending locally · not shared · operation ${result.value.operationId}`,
      );
      refresh();
      return true;
    } finally {
      setBusy(false);
    }
  };
  const projectSelected = async (purpose: string, budget: number) => {
    if (!Number.isInteger(budget) || budget < 32 || budget > 32000) {
      setNotice("Choose a budget from 32 to 32,000 estimated tokens.");
      return;
    }
    setBusy(true);
    setProjection(null);
    try {
      const { query: _query, ...applicability } = filters;
      const result = await makeProjection({
        environmentId,
        input: { ...scope, projection: { ...applicability, include: selected, purpose, budget } },
      });
      if (reportFailure("Could not prepare this projection", result) && result._tag === "Success")
        setProjection(result.value);
    } finally {
      setBusy(false);
    }
  };
  const keep = async (repositoryId: string) => {
    if (!record || !repositoryId) return;
    setBusy(true);
    try {
      const result = await keepCommand({
        environmentId,
        input: { ...scope, id: record.id, expectedVersion: record.version, repositoryId },
      });
      if (
        reportFailure("Could not prepare the knowledge proposal", result) &&
        result._tag === "Success"
      ) {
        setNotice(
          `Kept as ${result.value.path} · pending Git review. ${result.value.operation.status === "pending_local" ? "Graph update is pending locally, not shared." : ""}`,
        );
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  const changeMode = async (mode: PeerMemoryMode) => {
    setBusy(true);
    try {
      const result = await setMode({ environmentId, input: { ...scope, mode } });
      if (reportFailure("Could not change memory mode", result)) refresh();
    } finally {
      setBusy(false);
    }
  };
  const importSources = async (
    source: Pick<PeerHubMemoryImportKnowledgeInput, "repositoryId" | "commit" | "reviewRef">,
  ) => {
    setBusy(true);
    try {
      const result = await importKnowledge({ environmentId, input: { ...scope, ...source } });
      if (reportFailure("Knowledge import failed", result) && result._tag === "Success") {
        setNotice(
          `Processed ${result.value.operations.length} reviewed sources. ${result.value.operations.some((operation) => operation.status === "pending_local") ? "Some updates are pending locally, not shared." : ""}`,
        );
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    notice,
    projection,
    setProjection,
    execute,
    projectSelected,
    keep,
    changeMode,
    importSources,
  };
}
