import { createFileRoute } from "@tanstack/react-router";

import { KnowledgeView } from "../components/workspaces/KnowledgeView";

export const Route = createFileRoute("/_chat/knowledge/$workspace/$project")({
  component: KnowledgeRouteView,
});

function KnowledgeRouteView() {
  const { workspace, project } = Route.useParams();
  return <KnowledgeView workspace={workspace} project={project} />;
}
