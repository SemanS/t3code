import type { EnvironmentId, PeerHubMemoryReadInput } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { MemorySearchFilters } from "./MemorySearchForm";

export function useMemoryData(
  environmentId: EnvironmentId,
  workspace: string,
  project: string,
  filters: MemorySearchFilters,
  cursor: number,
  selected?: Pick<PeerHubMemoryReadInput, "id" | "version">,
) {
  const scope = { workspace, project };
  const searchFilters = {
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.repositoryId ? { repositoryId: filters.repositoryId } : {}),
    ...(filters.commit ? { commit: filters.commit } : {}),
    ...(filters.environment ? { environment: filters.environment } : {}),
    ...(filters.validAt ? { validAt: filters.validAt } : {}),
    ...(filters.knownAt ? { knownAt: filters.knownAt } : {}),
  };
  const state = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryState({ environmentId, input: scope }),
  );
  const search = useEnvironmentQuery(
    serverEnvironment.peerHubMemorySearch({
      environmentId,
      input: {
        ...scope,
        search: { ...searchFilters, contextIds: [], limit: 100, cursor, includeArchived: true },
      },
    }),
  );
  const read = useEnvironmentQuery(
    selected === undefined
      ? null
      : serverEnvironment.peerHubMemoryRead({
          environmentId,
          input: {
            ...scope,
            ...selected,
            ...(filters.knownAt ? { knownAt: filters.knownAt } : {}),
          },
        }),
  );
  const receipts = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryReceipts({
      environmentId,
      input: { ...scope, ...(selected ? { recordId: selected.id } : {}) },
    }),
  );
  const refresh = () => {
    state.refresh();
    search.refresh();
    read.refresh();
    receipts.refresh();
  };
  return { state, search, read, receipts, refresh };
}
