import { createFileRoute } from "@tanstack/react-router";

import { WorkspacesSettingsPanel } from "../components/settings/WorkspacesSettings";

export const Route = createFileRoute("/settings/workspaces")({
  component: WorkspacesSettingsPanel,
});
