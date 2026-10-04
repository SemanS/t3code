import { createFileRoute } from "@tanstack/react-router";

import { AgentView } from "../components/workspaces/AgentView";

export const Route = createFileRoute("/_chat/agent/$agentId")({
  component: AgentRouteView,
});

function AgentRouteView() {
  const { agentId } = Route.useParams();
  return <AgentView agentId={agentId} />;
}
