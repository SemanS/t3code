import { PEER_MEMORY_AVAILABLE, EnvironmentId, type PeerMemoryRecord } from "@t3tools/contracts";
import { memoryKnowledgeLabel, memoryReviewReasons } from "@t3tools/client-runtime/peer-memory";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText, AppTextInput } from "../../components/AppText";
import { MaterialListRow } from "../../components/MaterialListRow";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { MemoryScreen } from "./MemoryScreen";
import { MemoryQueue } from "./MemoryQueue";

type MemoryTab = "all" | "topics" | "assertions" | "questions" | "review";
const TABS: readonly MemoryTab[] = ["all", "topics", "assertions", "questions", "review"];
const includes = (
  tab: MemoryTab,
  record: PeerMemoryRecord,
  conflicts: readonly PeerMemoryRecord[],
) =>
  tab === "all" ||
  (tab === "topics" && record.kind === "context") ||
  (tab === "assertions" && record.kind === "assertion") ||
  (tab === "questions" && record.kind === "question" && !record.question?.closed) ||
  (tab === "review" && memoryReviewReasons(record, conflicts).length > 0);

export function MemoryRouteScreen(props: Parameters<typeof MemoryRouteContent>[0]) {
  return PEER_MEMORY_AVAILABLE ? (
    <MemoryRouteContent {...props} />
  ) : (
    <MemoryScreen title="Memory">
      <AppText>Peer Memory is currently unavailable.</AppText>
    </MemoryScreen>
  );
}

function MemoryRouteContent({
  route,
}: StaticScreenProps<{ environmentId: string; workspace: string; project: string }>) {
  const navigation = useNavigation();
  const { workspace, project } = route.params;
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const [query, setQuery] = useState("");
  const [searchText, setSearchText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [tab, setTab] = useState<MemoryTab>("all");
  const memory = useEnvironmentQuery(
    serverEnvironment.peerHubMemorySearch({
      environmentId,
      input: {
        workspace,
        project,
        search: { contextIds: [], query, limit: 100, cursor, includeArchived: true },
      },
    }),
  );
  const state = useEnvironmentQuery(
    serverEnvironment.peerHubMemoryState({ environmentId, input: { workspace, project } }),
  );
  const data = memory.error === null && !memory.isPending ? memory.data : null;
  const rows =
    data?.records.filter(({ record, conflicts }) => includes(tab, record, conflicts)) ?? [];
  return (
    <MemoryScreen title={`Memory · ${project}`}>
      <AppText className="text-sm text-foreground-muted">
        {workspace} / {project}
      </AppText>
      {state.error ? (
        <AppText accessibilityRole="alert">{state.error}</AppText>
      ) : state.data && !state.isPending ? (
        <AppText accessibilityLiveRegion="polite" className="text-sm text-foreground-muted">
          {state.data.available ? "Shared memory available" : "Memory unavailable"} ·{" "}
          {state.data.pendingLocal} pending locally · {state.data.blockedLocal} blocked ·{" "}
          {state.data.mode}
        </AppText>
      ) : null}
      <MemoryQueue
        environmentId={environmentId}
        scope={{ workspace, project }}
        onChange={() => {
          memory.refresh();
          state.refresh();
        }}
      />
      <AppTextInput
        accessibilityLabel="Search shared memory"
        value={searchText}
        onChangeText={setSearchText}
        returnKeyType="search"
        onSubmitEditing={() => {
          setQuery(searchText.trim());
          setCursor(0);
        }}
      />
      <View className="flex-row flex-wrap gap-2">
        {TABS.map((value) => (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === value }}
            accessibilityLabel={value}
            onPress={() => setTab(value)}
            className={
              tab === value
                ? "min-h-12 justify-center rounded-xl bg-accent px-3"
                : "min-h-12 justify-center rounded-xl bg-card px-3"
            }
          >
            <AppText className="text-sm capitalize">{value}</AppText>
          </Pressable>
        ))}
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Refresh shared memory"
        onPress={() => {
          memory.refresh();
          state.refresh();
        }}
        className="min-h-12 justify-center rounded-xl bg-card px-4"
      >
        <AppText>Refresh</AppText>
      </Pressable>
      {memory.error ? (
        <AppText accessibilityRole="alert">{memory.error}</AppText>
      ) : data === null ? (
        <AppText accessibilityLiveRegion="polite">Loading memory…</AppText>
      ) : rows.length === 0 ? (
        <AppText accessibilityLiveRegion="polite">
          No {tab === "all" ? "memory" : tab} matches on this page.
        </AppText>
      ) : (
        <View className="overflow-hidden rounded-xl">
          {rows.map(({ record, conflicts }) => (
            <MaterialListRow
              key={`${record.id}@${record.version}`}
              title={record.title || record.id}
              subtitle={[
                `${record.kind} · v${record.version}`,
                record.lifecycle,
                record.grounding,
                memoryKnowledgeLabel(record),
                ...memoryReviewReasons(record, conflicts),
              ]
                .filter(Boolean)
                .join(" · ")}
              onPress={() =>
                navigation.navigate("MemoryRecord", {
                  ...route.params,
                  id: record.id,
                  version: record.version,
                })
              }
            />
          ))}
        </View>
      )}
      {data ? (
        <>
          {data.traversalIncomplete ? (
            <AppText accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              Related records exceed the search traversal limit. These results may omit related
              context.
            </AppText>
          ) : null}
          <AppText className="text-xs text-foreground-muted">
            {data.records.length} records on this page · watermark {data.memoryWatermark}
            {tab === "review" ? " · review covers this page" : ""}
          </AppText>
        </>
      ) : null}
      <View className="flex-row gap-2">
        {cursor > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCursor(0)}
            className="min-h-12 justify-center rounded-xl bg-card px-4"
          >
            <AppText>First page</AppText>
          </Pressable>
        ) : null}
        {data?.hasMore ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setCursor(data.cursor)}
            className="min-h-12 justify-center rounded-xl bg-card px-4"
          >
            <AppText>Next page</AppText>
          </Pressable>
        ) : null}
      </View>
    </MemoryScreen>
  );
}
