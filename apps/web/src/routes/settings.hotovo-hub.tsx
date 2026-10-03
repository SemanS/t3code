import { createFileRoute } from "@tanstack/react-router";

import { HotovoHubSettingsPanel } from "../components/settings/HotovoHubSettings";

export const Route = createFileRoute("/settings/hotovo-hub")({
  component: HotovoHubSettingsPanel,
});
