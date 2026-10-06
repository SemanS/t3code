import type { EnvironmentId } from "@t3tools/contracts";
import {
  peerCoordinationLabel,
  peerCoordinationDetail,
} from "@t3tools/client-runtime/peer-task-agent";
import {
  squashAtomCommandFailure,
  isAtomCommandInterrupted,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  SettingsEnvironmentFilterHeader,
  AndroidSettingsEnvironmentFilter,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { PeerCoordTimeline } from "./PeerCoordTimeline";
import { PeerTaskLaunch } from "./PeerTaskLaunch";

/** Remote launch uses the selected environment's runtime and filesystem. */
export function SettingsPeerHubRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Peer workspaces" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-5 px-5 pt-4 pb-10"
        >
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">
              Connect an environment to work with your team.
            </Text>
          ) : (
            selectedTargets.map((target) => (
              <PeerEnvironment
                key={target.environmentId}
                environmentId={target.environmentId}
                label={target.label}
              />
            ))
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function PeerEnvironment({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const query = useEnvironmentQuery(serverEnvironment.peerHubLive({ environmentId, input: {} }));
  const coordinate = useAtomCommand(serverEnvironment.peerHubSetCoordination, {
    reportFailure: false,
  });
  const [selection, setSelection] = useState<{
    workspace: string;
    projectId: string;
    taskId: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const status = query.data;
  const project = status?.workspaces
    .find((workspace) => workspace.slug === selection?.workspace)
    ?.projects.find((project) => project.project.id === selection?.projectId);
  const task = project?.work.tasks.find((task) => task.id === selection?.taskId);
  return (
    <View className="gap-4">
      <Text className="text-lg font-t3-semibold text-foreground">{label}</Text>
      {query.error !== null ? (
        <Text accessibilityRole="alert" className="text-destructive">
          {query.error}
        </Text>
      ) : null}
      {status === null ? (
        <Text className="text-foreground-muted">
          {query.error === null
            ? "Loading workspaces…"
            : "Reconnect the environment and try again."}
        </Text>
      ) : !status.signedIn ? (
        <Text className="text-foreground-muted">
          Sign in to Peer workspaces on this environment using web or desktop first.
        </Text>
      ) : (
        <>
          {status.workspaces.map((workspace) => (
            <SettingsSection key={workspace.slug} title={workspace.name}>
              {workspace.projects.flatMap((project) =>
                project.work.tasks
                  .filter((task) => task.status !== "done")
                  .map((task) => (
                    <Pressable
                      key={`${project.project.id}/${task.id}`}
                      accessibilityRole="button"
                      accessibilityState={{
                        selected:
                          selection?.taskId === task.id &&
                          selection?.projectId === project.project.id,
                        disabled: busy,
                      }}
                      disabled={busy}
                      className="gap-1 p-4"
                      onPress={() => {
                        setSelection({
                          workspace: workspace.slug,
                          projectId: project.project.id,
                          taskId: task.id,
                        });
                        setMessage(null);
                      }}
                    >
                      <Text className="font-t3-medium text-foreground">
                        {[task.key, task.title].filter(Boolean).join(" · ")}
                      </Text>
                      <Text className="text-sm text-foreground-muted">
                        {project.project.name} · {task.status}
                        {selection?.taskId === task.id &&
                        selection?.projectId === project.project.id
                          ? " · Selected"
                          : ""}
                      </Text>
                    </Pressable>
                  )),
              )}
              {workspace.projects.every((project) =>
                project.work.tasks.every((task) => task.status === "done"),
              ) ? (
                <Text className="p-4 text-foreground-muted">
                  No open tasks. Create a task in Peer on web or desktop.
                </Text>
              ) : null}
            </SettingsSection>
          ))}
          {task === undefined || project === undefined || selection === null ? null : (
            <PeerTaskLaunch
              key={`${selection.workspace}/${task.id}`}
              environmentId={environmentId}
              label={label}
              workspace={selection.workspace}
              project={project}
              task={task}
              status={status}
              onBusyChange={setBusy}
              disabled={busy}
            />
          )}
          {selection === null ? null : (
            <PeerCoordTimeline
              environmentId={environmentId}
              workspace={selection.workspace}
              project={selection.projectId}
              task={selection.taskId}
              revision={status.lastSyncAt ?? undefined}
            />
          )}
          <SettingsSection title="Claude Code coordination">
            <View className="gap-2 p-4">
              <Text className="text-foreground-muted">
                Peer Mod needs Claude Code 2.1.291 or newer on {label}. Each running session shows
                its verified coordination level.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                className="py-2"
                onPress={() => {
                  setBusy(true);
                  setMessage(null);
                  void coordinate({
                    environmentId,
                    input: { claudeMod: status.coordination.claudeMod !== true },
                  })
                    .then((result) => {
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        const error = squashAtomCommandFailure(result);
                        setMessage(error instanceof Error ? error.message : String(error));
                      }
                    })
                    .finally(() => setBusy(false));
                }}
              >
                <Text className="font-t3-medium text-primary-text">
                  {status.coordination.claudeMod ? "Disable Peer Mod" : "Enable Peer Mod"}
                </Text>
              </Pressable>
              {message === null ? null : (
                <Text accessibilityRole="alert" className="text-foreground">
                  {message}
                </Text>
              )}
            </View>
          </SettingsSection>
          <SettingsSection title="Agents on this environment">
            {(status.agents.postHocSkipped ?? 0) > 0 ? (
              <Text className="p-4 text-foreground-muted">
                {status.agents.postHocSkipped} agents' observations exceed the team's report limit.
              </Text>
            ) : null}
            {status.agents.list.length === 0 ? (
              <Text className="p-4 text-foreground-muted">No agents are running in herdr.</Text>
            ) : (
              status.agents.list.map((agent) => (
                <View key={agent.id} className="gap-1 p-4">
                  <Text className="font-t3-medium text-foreground">
                    {agent.title} · {agent.status}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {peerCoordinationLabel(agent.coordinationLevel)}
                  </Text>
                  <Text className="text-sm text-foreground-muted">
                    {peerCoordinationDetail(agent.coordinationLevel)}
                  </Text>
                  {agent.coordinationLevel === "C" && agent.postHocPaths !== undefined ? (
                    <Text className="text-sm text-foreground-muted">
                      {agent.postHocPaths.length} uncommitted paths observed after work.
                    </Text>
                  ) : null}
                  {(agent.postHocPathsTruncated ?? 0) > 0 ? (
                    <Text className="text-sm text-foreground-muted">
                      {agent.postHocPathsTruncated} additional paths remain local.
                    </Text>
                  ) : null}
                </View>
              ))
            )}
          </SettingsSection>
          {status.workspaces.length === 0 ? (
            <Text className="text-foreground-muted">
              Join a workspace on this environment to see its tasks.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}
