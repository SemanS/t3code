import { PEER_MEMORY_AVAILABLE, type EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialListRow } from "../../components/MaterialListRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { MemoryScreen } from "./MemoryScreen";

export function MemoryProjectsRouteScreen() {
  return PEER_MEMORY_AVAILABLE ? (
    <MemoryProjectsContent />
  ) : (
    <MemoryScreen title="Memory">
      <AppText>Peer Memory is currently unavailable.</AppText>
    </MemoryScreen>
  );
}

function MemoryProjectsContent() {
  const environments = useWorkspaceEnvironments().filter(
    (environment) => environment.connectionState === "connected",
  );
  return (
    <MemoryScreen title="Memory">
      <AppText className="text-sm text-foreground-muted">
        Shared findings, topics, questions, and evidence remain available after an agent's session
        ends.
      </AppText>
      {environments.length === 0 ? (
        <AppText accessibilityRole="alert">
          Connect to an environment to read workspace memory.
        </AppText>
      ) : (
        environments.map((environment) => (
          <EnvironmentMemoryProjects
            key={environment.environmentId}
            environmentId={environment.environmentId}
          />
        ))
      )}
    </MemoryScreen>
  );
}

function EnvironmentMemoryProjects({ environmentId }: { environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const status = useEnvironmentQuery(serverEnvironment.peerHubLive({ environmentId, input: {} }));
  const data = status.error === null && !status.isPending ? status.data : null;
  return (
    <View className="gap-3">
      <AppText accessibilityRole="header" className="text-sm font-semibold">
        Environment {environmentId}
      </AppText>
      {status.error ? (
        <AppText accessibilityRole="alert">{status.error}</AppText>
      ) : data === null ? (
        <AppText accessibilityLiveRegion="polite">Checking workspace access…</AppText>
      ) : !data.signedIn ? (
        <AppText className="text-sm text-foreground-muted">
          Sign in to a Peer workspace on this environment first.
        </AppText>
      ) : (
        data.workspaces.map((workspace) => (
          <View key={workspace.slug} className="gap-2">
            <AppText accessibilityRole="header" className="text-base font-semibold">
              {workspace.name}
            </AppText>
            <View className="overflow-hidden rounded-xl">
              {workspace.projects.map(({ project }) => (
                <MaterialListRow
                  key={project.id}
                  title={project.name}
                  subtitle="Open shared memory"
                  onPress={() =>
                    navigation.navigate("Memory", {
                      environmentId: String(environmentId),
                      workspace: workspace.slug,
                      project: project.id,
                    })
                  }
                />
              ))}
              <MaterialListRow
                title="Company knowledge"
                subtitle="Explicit workspace scope"
                onPress={() =>
                  navigation.navigate("Memory", {
                    environmentId: String(environmentId),
                    workspace: workspace.slug,
                    project: "company",
                  })
                }
              />
            </View>
          </View>
        ))
      )}
    </View>
  );
}
