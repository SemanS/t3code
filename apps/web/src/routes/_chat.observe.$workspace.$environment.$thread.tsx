import { createFileRoute } from "@tanstack/react-router";

import { ObserveView } from "../components/workspaces/ObserveView";

export const Route = createFileRoute("/_chat/observe/$workspace/$environment/$thread")({
  component: ObserveRouteView,
});

function ObserveRouteView() {
  const { workspace, environment, thread } = Route.useParams();
  return <ObserveView workspace={workspace} environment={environment} thread={thread} />;
}
