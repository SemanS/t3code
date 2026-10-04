import { createFileRoute } from "@tanstack/react-router";

import { WorkContextView } from "../components/workspaces/WorkContextView";

export const Route = createFileRoute("/_chat/context/$workspace/$project/$scope")({
  component: WorkContextRouteView,
});

function WorkContextRouteView() {
  const { workspace, project, scope } = Route.useParams();
  return <WorkContextView workspace={workspace} project={project} scope={scope} />;
}
