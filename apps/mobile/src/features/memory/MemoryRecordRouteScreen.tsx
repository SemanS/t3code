import { EnvironmentId, type PeerMemoryRecordRef } from "@t3tools/contracts";
import { memoryDeliveryStates, memoryKnowledgeLabel } from "@t3tools/client-runtime/peer-memory";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialListRow } from "../../components/MaterialListRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { MemoryScreen } from "./MemoryScreen";
import { MemoryRecordSources } from "./MemoryRecordSources";
import { MemoryRecordSemantics } from "./MemoryRecordSemantics";

export function MemoryRecordRouteScreen({
  route,
}: StaticScreenProps<{
  environmentId: string;
  workspace: string;
  project: string;
  id: string;
  version: number;
}>) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { workspace, project, id, version } = route.params;
  const view = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryRead({
      environmentId,
      input: { workspace, project, id, version },
    }),
  );
  const receipts = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryReceipts({
      environmentId,
      input: { workspace, project, recordId: id },
    }),
  );
  const data = view.error === null && !view.isPending ? view.data : null;
  const record = data?.record;
  const delivery = record
    ? memoryDeliveryStates(
        record,
        receipts.error === null && !receipts.isPending ? (receipts.data?.receipts ?? []) : [],
      )
    : [];
  const open = (ref: PeerMemoryRecordRef) =>
    navigation.navigate("MemoryRecord", { ...route.params, ...ref });
  return (
    <MemoryScreen title="Memory detail">
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          view.refresh();
          receipts.refresh();
        }}
        className="min-h-12 justify-center rounded-xl bg-card px-4"
      >
        <AppText>Refresh</AppText>
      </Pressable>
      {view.error ? (
        <AppText accessibilityRole="alert">{view.error}</AppText>
      ) : !record || !data ? (
        <AppText accessibilityLiveRegion="polite">Loading record and history…</AppText>
      ) : (
        <>
          <AppText accessibilityRole="header" className="text-xl font-semibold">
            {record.title || record.id}
          </AppText>
          <AppText selectable className="text-xs text-foreground-muted">
            {record.id}@{record.version} · {record.kind} · {record.lifecycle} · {record.grounding}
            {memoryKnowledgeLabel(record) ? ` · ${memoryKnowledgeLabel(record)}` : ""}
          </AppText>
          <AppText selectable className="text-base">
            {record.text}
          </AppText>
          <MemoryRecordSources view={data} />
          <View className="gap-2">
            <AppText accessibilityRole="header" className="text-base font-semibold">
              Conflicts · {data.conflicts.length}
            </AppText>
            {data.conflicts.length === 0 ? (
              <AppText className="text-sm text-foreground-muted">
                No authorized unresolved conflict is recorded.
              </AppText>
            ) : (
              <>
                <AppText className="text-sm">
                  Review each claim's commit, valid time, and evidence before deciding.
                </AppText>
                {data.conflicts.map((conflict) => (
                  <MaterialListRow
                    key={conflict.id}
                    title={conflict.title}
                    subtitle={`${conflict.id}@${conflict.version} · ${conflict.applicability.revision ?? "commit unrecorded"}`}
                    onPress={() => open(conflict)}
                  />
                ))}
              </>
            )}
          </View>
          <MemoryRecordSemantics record={record} onOpen={open} />
          <View className="gap-2">
            <AppText accessibilityRole="header" className="text-base font-semibold">
              Runtime delivery · version {record.version}
            </AppText>
            {delivery.length === 0 ? (
              <AppText className="text-sm text-foreground-muted">
                Available in memory. Runtime delivery is unverified.
              </AppText>
            ) : (
              delivery.map((state) => (
                <View
                  key={JSON.stringify([
                    state.email,
                    state.runtimeProjectId,
                    state.environmentId,
                    state.sessionId,
                    state.runtimeGeneration,
                  ])}
                  className="gap-1 rounded-xl bg-card p-3"
                >
                  <AppText className="text-sm font-semibold">
                    {state.state === "consumed"
                      ? "Used in an evidenced result"
                      : state.state === "acknowledged"
                        ? "Acknowledged by agent"
                        : state.state === "delivered"
                          ? "Delivered to runtime"
                          : "Requested · delivery unverified"}
                  </AppText>
                  <AppText selectable className="text-xs text-foreground-muted">
                    {state.email}
                    {state.runtimeProjectId ? ` · project ${state.runtimeProjectId}` : ""} · session{" "}
                    {state.sessionId} · runtime {state.runtimeGeneration} · {state.at}
                  </AppText>
                  {state.outputRef ? (
                    <AppText selectable className="text-xs">
                      Result:{" "}
                      {state.outputRef.path ?? state.outputRef.command ?? state.outputRef.kind}
                    </AppText>
                  ) : null}
                </View>
              ))
            )}
            {receipts.error ? (
              <AppText accessibilityRole="alert">Receipts unavailable: {receipts.error}</AppText>
            ) : null}
            <AppText className="text-xs text-foreground-muted">
              Delivery evidence does not establish that an agent understands a finding. Human
              previews create no agent receipt.
            </AppText>
          </View>
          <View className="gap-2">
            <AppText accessibilityRole="header" className="text-base font-semibold">
              Related records
            </AppText>
            {data.related.map((related) => (
              <MaterialListRow
                key={related.id}
                title={related.title || related.id}
                subtitle={`${related.kind} · v${related.version}`}
                onPress={() => open(related)}
              />
            ))}
          </View>
          <View className="gap-2">
            <AppText accessibilityRole="header" className="text-base font-semibold">
              History
            </AppText>
            {data.history.map((historical) => (
              <MaterialListRow
                key={historical.version}
                title={`Version ${historical.version}`}
                subtitle={`${historical.lifecycle} · recorded ${historical.recordedAt}`}
                onPress={() => open(historical)}
              />
            ))}
            <AppText className="text-xs text-foreground-muted">
              Valid time describes the world; known time describes when this scope learned it.
              Earlier legacy history may be unavailable.
            </AppText>
          </View>
        </>
      )}
    </MemoryScreen>
  );
}
