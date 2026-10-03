import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { usePrimaryEnvironment } from "../../state/environments";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { usePeerHubStatus } from "./WorkspaceAccess";

/** What the sidebar lists: the team's work (Project → Area → Task → Threads) or this computer's threads. */
export type SidebarView = "work" | "threads";

const StoredView = Schema.NullOr(Schema.Literals(["work", "threads"]));

/** The chosen view; until someone chooses, Work for people in a workspace, Threads otherwise. */
export function useSidebarView(): readonly [SidebarView, (view: SidebarView) => void] {
  const primary = usePrimaryEnvironment();
  const status = usePeerHubStatus(
    primary !== null && primary.connection.phase === "connected" ? primary.environmentId : null,
  );
  const [stored, setStored] = useLocalStorage("peer:sidebar-view", null, StoredView);
  const fallback: SidebarView =
    status !== null && status.signedIn && status.workspaces.length > 0 ? "work" : "threads";
  return [stored ?? fallback, setStored];
}

export function SidebarViewSwitch({
  view,
  onChange,
}: {
  readonly view: SidebarView;
  readonly onChange: (view: SidebarView) => void;
}) {
  return (
    <ToggleGroup
      className="w-full"
      aria-label="Sidebar view"
      variant="segmented"
      value={[view]}
      onValueChange={(next) => {
        const value = next[0];
        if (value === "work" || value === "threads") onChange(value);
      }}
    >
      <Toggle className="flex-1" value="work">
        Work
      </Toggle>
      <Toggle className="flex-1" value="threads">
        Threads
      </Toggle>
    </ToggleGroup>
  );
}
