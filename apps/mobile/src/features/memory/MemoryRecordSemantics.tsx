import type { PeerMemoryRecord, PeerMemoryRecordRef } from "@t3tools/contracts";
import { View } from "react-native";
import { AppText } from "../../components/AppText";
import { MaterialListRow } from "../../components/MaterialListRow";

export function MemoryRecordSemantics({
  record,
  onOpen,
}: {
  record: PeerMemoryRecord;
  onOpen: (ref: PeerMemoryRecordRef) => void;
}) {
  const open = onOpen;
  return (
    <>
      {record.question ? (
        <View className="gap-2">
          <AppText accessibilityRole="header" className="text-base font-semibold">
            Question · {record.question.closed ? "closed" : "open"}
          </AppText>
          <AppText>Owner: {record.question.owner ?? "Unassigned"}</AppText>
          {record.question.answers.map((answer) => (
            <View
              key={`${answer.at}:${answer.author.email}`}
              className="gap-1 rounded-xl bg-card p-3"
            >
              <AppText selectable>{answer.text}</AppText>
              <AppText className="text-xs text-foreground-muted">
                {answer.author.email} · {answer.at}
              </AppText>
              {answer.references.map((ref) => (
                <MaterialListRow
                  key={`${ref.id}@${ref.version}`}
                  title={`${ref.id}@${ref.version}`}
                  onPress={() => open(ref)}
                />
              ))}
            </View>
          ))}
        </View>
      ) : null}
      {record.decision ? (
        <View className="gap-2">
          <AppText accessibilityRole="header" className="text-base font-semibold">
            Decision · {record.decision.status}
          </AppText>
          <AppText selectable>{record.decision.reasons}</AppText>
          <AppText className="text-sm text-foreground-muted">
            Alternatives: {record.decision.alternatives.join("; ") || "None recorded"}
          </AppText>
        </View>
      ) : null}
      {record.knowledge ? (
        <View className="gap-2">
          <AppText accessibilityRole="header" className="text-base font-semibold">
            Git review
          </AppText>
          <AppText selectable className="text-sm">
            {record.knowledge.path} · commit {record.knowledge.commit ?? "not imported"} · review{" "}
            {record.knowledge.reviewRef ?? "not recorded"}
          </AppText>
          <AppText className="text-sm text-foreground-muted">
            Keep prepares a proposal. Approval requires a reviewed commit to be imported.
          </AppText>
        </View>
      ) : null}
    </>
  );
}
