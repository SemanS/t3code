import type { PeerMemoryRecordView } from "@t3tools/contracts";
import { memoryEvidenceSources } from "@t3tools/client-runtime/peer-memory";
import { View } from "react-native";
import { AppText } from "../../components/AppText";

export function MemoryRecordSources({ view }: { view: PeerMemoryRecordView }) {
  const record = view.record;
  const data = view;
  return (
    <>
      <View className="gap-2">
        <AppText accessibilityRole="header" className="text-base font-semibold">
          Provenance and applicability
        </AppText>
        {[
          ["Scope", `${record.workspaceId} / ${record.projectId}`],
          ["Original author", record.createdBy.email],
          ["Version recorded by", record.recordedBy?.email],
          ["Session", record.createdBy.sessionId],
          ["Runtime generation", record.createdBy.runtimeGeneration],
          ["Repository", record.applicability.repositoryId],
          ["Commit", record.applicability.revision],
          ["Environment", record.applicability.environment],
          ["Deployment", record.applicability.deployment],
          ["Observed", record.observedAt],
          ["Known from", record.knownAt],
          ["Recorded", record.recordedAt],
          ["Valid from", record.validFrom ?? "Not specified"],
          ["Valid until", record.validTo ?? "Not specified"],
          ["Independence", record.independence],
          ["Aliases", record.aliases.join(", ")],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <AppText key={label} selectable className="text-sm text-foreground-muted">
              {label}: {value}
            </AppText>
          ))}
      </View>
      <View className="gap-3">
        <AppText accessibilityRole="header" className="text-base font-semibold">
          Evidence
        </AppText>
        {record.evidenceMissing ? (
          <AppText className="text-sm">
            Evidence is missing. This remains a proposed finding.
          </AppText>
        ) : null}
        {memoryEvidenceSources(record, data.related).map((source) => (
          <View key={JSON.stringify(source)} className="gap-1 rounded-xl bg-card p-3">
            <AppText className="text-sm font-semibold">
              {source.kind} · {source.weak ? "weak evidence" : "immutable source reference"}
            </AppText>
            <AppText selectable className="text-sm">
              {source.path ?? source.command ?? source.url ?? "Source"}
              {source.startLine ? `:${source.startLine}` : ""}
              {source.symbol ? ` · ${source.symbol}` : ""}
            </AppText>
            <AppText selectable className="text-xs text-foreground-muted">
              {[source.repositoryId, source.revision, source.blobHash, source.environment]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
            {source.result ? (
              <AppText selectable className="text-sm">
                {source.result}
              </AppText>
            ) : null}
          </View>
        ))}
      </View>
    </>
  );
}
