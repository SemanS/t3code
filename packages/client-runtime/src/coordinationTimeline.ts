import type { PeerCoordEvent, PeerStaleReads } from "@t3tools/contracts";

const labels: Record<string, string> = {
  claim: "Claimed files",
  "claim-release": "Released files",
  overlap: "Overlap detected",
  note: "Coordination note",
  resolve: "Overlap resolved",
  ack: "Overlap acknowledged",
  keeper: "Context keeper changed",
  "context-write": "Shared context updated",
  "context-read": "Shared context read",
  question: "Question opened",
  handoff: "Work handed off",
};

export function coordinationEventLabel(event: PeerCoordEvent): string {
  const version = event.version === undefined ? "" : ` · v${event.version}`;
  return `${labels[event.kind] ?? event.kind}${version}`;
}

/** Duplicate subscription responses do not duplicate an event in the displayed history. */
export function coordinationTimeline(events: readonly PeerCoordEvent[]): PeerCoordEvent[] {
  return [...new Map(events.map((event) => [event.id, event])).values()].sort(
    (left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id),
  );
}

export function staleInputSummary(reads: PeerStaleReads): string {
  if (reads.fresh && reads.stale.length === 0) return "Shared inputs are current";
  return (
    reads.stale
      .map(
        (read) =>
          `${read.scope.replace(/^task:/, "")} v${read.readVersion} → v${read.currentVersion}`,
      )
      .join("; ") || "Shared inputs need checking"
  );
}
