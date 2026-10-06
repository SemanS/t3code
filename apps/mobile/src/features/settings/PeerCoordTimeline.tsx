import type { EnvironmentId } from "@t3tools/contracts";
import {
  coordinationEventLabel,
  coordinationTimeline,
} from "@t3tools/client-runtime/coordinationTimeline";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function PeerCoordTimeline({
  environmentId,
  workspace,
  project,
  task,
  revision,
}: {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  task?: string;
  revision?: string;
}) {
  const history = useEnvironmentQuery(
    serverEnvironment.peerHubCoordEvents({
      environmentId,
      input: { workspace, project, ...(task === undefined ? {} : { task }), limit: 30, revision },
    }),
  );
  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-center justify-between gap-3">
        <Text accessibilityRole="header" className="font-t3-semibold text-foreground">
          Coordination history
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh coordination history"
          disabled={history.isPending}
          onPress={() => history.refresh()}
          className="p-2"
        >
          <Text className="text-foreground">Refresh</Text>
        </Pressable>
      </View>
      {history.error !== null ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {history.error}
        </Text>
      ) : history.data === null ? (
        <Text className="text-foreground-muted">Loading history…</Text>
      ) : history.data.length === 0 ? (
        <Text className="text-foreground-muted">No coordination events yet.</Text>
      ) : (
        coordinationTimeline(history.data).map((event) => (
          <View key={event.id} className="gap-1 border-l border-border pl-3">
            <Text className="font-t3-medium text-foreground">{coordinationEventLabel(event)}</Text>
            <Text className="text-sm text-foreground-muted">
              {[event.session ?? event.email, event.scope, event.paths.join(", ")]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {new Date(event.at).toLocaleString()}
            </Text>
          </View>
        ))
      )}
      <Text className="text-xs text-foreground-muted">
        Private working notes stay with each agent. History records shared versions and
        coordination.
      </Text>
    </View>
  );
}
