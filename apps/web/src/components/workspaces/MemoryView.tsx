import { PEER_MEMORY_AVAILABLE, type PeerMemoryRecordRef } from "@t3tools/contracts";
import { memorySelectionChanges, setMemorySelection } from "@t3tools/client-runtime/peer-memory";
import { useState } from "react";
import { DatabaseIcon } from "lucide-react";
import { isElectron } from "../../env";
import { usePrimaryEnvironment } from "../../state/environments";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { usePeerHubStatus } from "./WorkspaceAccess";
import { MemoryActionForm } from "./MemoryActionForm";
import { MemoryChangesNotice } from "./MemoryChangesNotice";
import { MemoryDetailPanel } from "./MemoryDetailPanel";
import { MEMORY_TABS, type MemoryTab } from "./MemoryRecords";
import { MemoryProjectionPanel } from "./MemoryProjection";
import { MemorySearchForm, type MemorySearchFilters } from "./MemorySearchForm";
import { MemoryStatus } from "./MemoryStatus";
import { MemoryQueue } from "./MemoryQueue";
import { MemoryImport } from "./MemoryImport";
import { MemoryResults } from "./MemoryResults";
import { useMemoryActions } from "./useMemoryActions";
import { useMemoryData } from "./useMemoryData";

export interface MemoryViewLocation extends MemorySearchFilters {
  id?: string;
  version?: number;
  tab?: MemoryTab;
  cursor?: number;
}

export function MemoryView(props: {
  workspace: string;
  project: string;
  location: MemoryViewLocation;
  onLocation: (location: MemoryViewLocation) => void;
}) {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.connection.phase === "connected" ? primary.environmentId : null;
  const status = usePeerHubStatus(environmentId);
  const accessible =
    status?.signedIn &&
    status.workspaces.some(
      (workspace) =>
        workspace.slug === props.workspace &&
        (props.project === "company" ||
          workspace.projects.some((project) => project.project.id === props.project)),
    );
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <DatabaseIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <h1 className="truncate text-sm font-medium">Memory · {props.project}</h1>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 sm:px-6">
            {PEER_MEMORY_AVAILABLE && environmentId !== null && accessible ? (
              <MemoryContent
                key={`${environmentId}:${status.email}:${props.workspace}:${props.project}`}
                {...props}
                environmentId={environmentId}
              />
            ) : (
              <p role="status" className="text-sm text-muted-foreground">
                {!PEER_MEMORY_AVAILABLE
                  ? "Peer Memory is currently unavailable."
                  : environmentId === null
                    ? "Connect to an environment to read shared memory."
                    : status === null
                      ? "Checking workspace access…"
                      : "Sign in to a workspace with access to this project."}
              </p>
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function MemoryContent({
  environmentId,
  workspace,
  project,
  location,
  onLocation,
}: Parameters<typeof MemoryView>[0] & {
  environmentId: NonNullable<ReturnType<typeof usePrimaryEnvironment>>["environmentId"];
}) {
  const scope = { workspace, project };
  const selectedRecord = location.id
    ? { id: location.id, ...(location.version ? { version: location.version } : {}) }
    : undefined;
  const data = useMemoryData(
    environmentId,
    workspace,
    project,
    location,
    location.cursor ?? 0,
    selectedRecord,
  );
  const [selected, setSelected] = useState<readonly PeerMemoryRecordRef[]>([]);
  const [creating, setCreating] = useState(false);
  const tab = location.tab ?? "all";
  // Query atoms can retain a previous success while refreshing. Never render it after access failure.
  const records = data.search.error === null && !data.search.isPending ? data.search.data : null;
  const view = data.read.error === null && !data.read.isPending ? data.read.data : null;
  const receipts =
    data.receipts.error === null && !data.receipts.isPending
      ? (data.receipts.data?.receipts ?? [])
      : [];
  const state = data.state.error === null && !data.state.isPending ? data.state.data : null;
  const open = (ref: PeerMemoryRecordRef) =>
    onLocation({ ...location, id: ref.id, version: ref.version });
  const filters = {
    ...(location.query ? { query: location.query } : {}),
    ...(location.repositoryId ? { repositoryId: location.repositoryId } : {}),
    ...(location.commit ? { commit: location.commit } : {}),
    ...(location.environment ? { environment: location.environment } : {}),
    ...(location.validAt ? { validAt: location.validAt } : {}),
    ...(location.knownAt ? { knownAt: location.knownAt } : {}),
  };
  const {
    busy,
    notice,
    projection,
    setProjection,
    execute,
    projectSelected,
    keep,
    changeMode,
    importSources,
  } = useMemoryActions(environmentId, scope, selected, filters, data.refresh, view?.record);
  const changed = memorySelectionChanges(
    selected,
    records?.records.map((item) => item.record) ?? [],
  );
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-xs text-muted-foreground">
          Shared findings survive sessions and completed work. Every claim keeps its scope,
          evidence, and exact versions.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setProjection(null);
            data.refresh();
          }}
        >
          Refresh
        </Button>
        <Button size="sm" disabled={busy} onClick={() => setCreating(!creating)}>
          Add memory
        </Button>
      </div>
      <MemoryStatus state={state} error={data.state.error} busy={busy} onMode={changeMode} />
      <MemoryQueue environmentId={environmentId} scope={scope} onChange={data.refresh} />
      {notice ? (
        <p role="status" className="break-words text-sm">
          {notice}
        </p>
      ) : null}
      {creating ? (
        <MemoryActionForm busy={busy} onExecute={execute} onCancel={() => setCreating(false)} />
      ) : null}
      <MemorySearchForm
        key={JSON.stringify([
          location.query,
          location.repositoryId,
          location.commit,
          location.environment,
          location.validAt,
          location.knownAt,
        ])}
        filters={location}
        onSearch={(filters) => onLocation({ ...filters, tab })}
      />
      <div className="overflow-x-auto">
        <ToggleGroup
          aria-label="Memory view"
          value={[tab]}
          onValueChange={(next) => {
            const value = MEMORY_TABS.find((item) => item.value === next[0]);
            if (value) onLocation({ ...location, tab: value.value });
          }}
        >
          {MEMORY_TABS.map((item) => (
            <Toggle key={item.value} value={item.value}>
              {item.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      {changed.length ? (
        <p role="status" className="break-words text-xs text-warning">
          Selected versions have changed:{" "}
          {changed
            .map(
              ({ selected: ref, current }) =>
                `${ref.id}@${ref.version} → ${current.version} (${current.lifecycle})`,
            )
            .join(", ")}
          . Your selection still refers to the original versions.
        </p>
      ) : null}
      {data.search.data ? (
        <MemoryChangesNotice
          environmentId={environmentId}
          workspace={workspace}
          project={project}
          watermark={data.search.data.memoryWatermark}
          onRefresh={data.refresh}
          onOpen={open}
        />
      ) : null}
      <MemoryProjectionPanel
        selected={selected}
        projection={data.search.error === null ? projection : null}
        busy={busy}
        onProject={projectSelected}
        onRemove={(ref) => setSelected(setMemorySelection(selected, ref, false))}
      />
      <div
        className={
          selectedRecord
            ? "grid min-w-0 gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
            : "min-w-0"
        }
      >
        <MemoryResults
          records={records}
          error={data.search.error}
          tab={tab}
          cursor={location.cursor ?? 0}
          selected={selected}
          onSelect={(ref, checked) => setSelected(setMemorySelection(selected, ref, checked))}
          onOpen={open}
          onCursor={(cursor) => onLocation({ ...location, cursor })}
        />
        {selectedRecord ? (
          <MemoryDetailPanel
            view={view}
            error={data.read.error}
            receiptsError={data.receipts.error}
            receipts={receipts}
            busy={busy}
            onExecute={execute}
            onOpen={open}
            onKeep={keep}
            historicalQuery={location.knownAt !== undefined}
            onCurrent={() => {
              const { knownAt: _knownAt, version: _version, ...rest } = location;
              onLocation(rest);
            }}
            onClose={() => {
              const { id: _id, version: _version, ...rest } = location;
              onLocation(rest);
            }}
          />
        ) : null}
      </div>
      <MemoryImport busy={busy} onImport={importSources} />
    </>
  );
}
