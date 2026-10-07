import type { EnvironmentId, PeerCoordSession } from "@t3tools/contracts";
import {
  coordinationEventLabel,
  coordinationActorLabel,
  coordinationScopeLabel,
  inputReadiness,
  inputReadinessLabels,
  type CoordinationTaskName,
  coordinationTimeline,
} from "@t3tools/client-runtime/coordinationTimeline";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const NO_SESSIONS: readonly PeerCoordSession[] = [];
const NO_TASKS: readonly CoordinationTaskName[] = [];

export function PeerCoordTimeline({
  environmentId,
  workspace,
  project,
  task,
  revision,
  sessions = NO_SESSIONS,
  tasks = NO_TASKS,
}: {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  task?: string;
  revision?: string;
  sessions?: readonly PeerCoordSession[];
  tasks?: readonly CoordinationTaskName[];
}) {
  const [open, setOpen] = useState(false);
  const history = useEnvironmentQuery(
    open
      ? serverEnvironment.peerHubCoordEvents({
          environmentId,
          input: {
            workspace,
            project,
            ...(task === undefined ? {} : { task }),
            limit: 30,
            revision,
          },
        })
      : null,
  );
  return (
    <View className="gap-3 p-4">
      {sessions
        .filter((session) => session.environment !== undefined)
        .map((session) => (
          <AgentInputs
            key={`${session.environment}:${session.id}`}
            {...{ environmentId, workspace, project, session, revision, tasks }}
          />
        ))}
      <View className="flex-row items-center justify-between gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen(!open)}
          className="py-2"
        >
          <Text className="font-t3-semibold text-foreground">
            {open ? "Hide activity" : "Coordination history"}
          </Text>
        </Pressable>
        {open ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Refresh coordination history"
            disabled={history.isPending}
            onPress={() => history.refresh()}
            className="p-2"
          >
            <Text className="text-foreground">Refresh</Text>
          </Pressable>
        ) : null}
      </View>
      {!open ? null : history.error !== null ? (
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
              {[
                coordinationActorLabel(event, sessions),
                event.scope === undefined ? undefined : coordinationScopeLabel(event.scope, tasks),
                event.paths.join(", "),
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
            <Text className="text-xs text-foreground-muted">
              {new Date(event.at).toLocaleString()}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

function AgentInputs({
  environmentId,
  workspace,
  project,
  session,
  revision,
  tasks,
}: {
  environmentId: EnvironmentId;
  workspace: string;
  project: string;
  session: PeerCoordSession;
  revision?: string | undefined;
  tasks: readonly CoordinationTaskName[];
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.peerHubStaleReads({
      environmentId,
      input: {
        workspace,
        project,
        session: session.id,
        environment: session.environment!,
        revision,
      },
    }),
  );
  const data = query.error === null ? query.data : null;
  return (
    <View className="gap-2 rounded-lg border border-border p-3">
      <Text className="font-t3-semibold text-foreground">{session.label}</Text>
      <Text className="text-sm text-foreground-muted">
        {session.id.startsWith("codex:")
          ? "Codex"
          : session.id.startsWith("claude:")
            ? "Claude"
            : "Agent"}{" "}
        · {session.local ? "This computer" : "Other computer"}
      </Text>
      <Text accessibilityLiveRegion="polite" className="font-t3-medium text-foreground">
        {data === null
          ? query.error === null
            ? "Checking inputs…"
            : "Input check unavailable"
          : inputReadinessLabels[inputReadiness(data)]}
      </Text>
      {data?.stale.length ? (
        <Text className="text-sm text-foreground-muted">
          Agent must update these inputs before handoff.
        </Text>
      ) : null}
      {data?.stale.map((read) => (
        <View key={read.scope} className="gap-1">
          <Text className="text-foreground">{coordinationScopeLabel(read.scope, tasks)}</Text>
          <Text className="text-sm text-foreground-muted">
            Read v{read.readVersion} →{" "}
            {read.currentVersion === null ? "Context removed" : `Latest v${read.currentVersion}`}
          </Text>
        </View>
      ))}
      {data?.stale.length === 0
        ? data.reads?.map((read) => (
            <Text key={read.scope} className="text-sm text-foreground-muted">
              {coordinationScopeLabel(read.scope, tasks)} · v{read.version}
            </Text>
          ))
        : null}
    </View>
  );
}
