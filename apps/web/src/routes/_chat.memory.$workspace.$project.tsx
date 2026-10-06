import { createFileRoute } from "@tanstack/react-router";
import { MemoryView, type MemoryViewLocation } from "../components/workspaces/MemoryView";
import { MEMORY_TABS } from "../components/workspaces/MemoryRecords";

export const Route = createFileRoute("/_chat/memory/$workspace/$project")({
  validateSearch: (search: Record<string, unknown>): MemoryViewLocation => {
    const result: MemoryViewLocation = {};
    for (const field of ["query", "repositoryId", "commit", "environment", "id"] as const)
      if (typeof search[field] === "string" && search[field]) result[field] = search[field];
    for (const field of ["validAt", "knownAt"] as const)
      if (typeof search[field] === "string" && Number.isFinite(Date.parse(search[field])))
        result[field] = new Date(search[field]).toISOString();
    if (
      typeof search.version === "number" &&
      Number.isSafeInteger(search.version) &&
      search.version > 0
    )
      result.version = search.version;
    if (
      typeof search.cursor === "number" &&
      Number.isSafeInteger(search.cursor) &&
      search.cursor >= 0
    )
      result.cursor = search.cursor;
    const tab = MEMORY_TABS.find((item) => item.value === search.tab);
    if (tab) result.tab = tab.value;
    return result;
  },
  component: MemoryRoute,
});

function MemoryRoute() {
  const { workspace, project } = Route.useParams();
  const location = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <MemoryView
      workspace={workspace}
      project={project}
      location={location}
      onLocation={(search) => {
        void navigate({ search });
      }}
    />
  );
}
