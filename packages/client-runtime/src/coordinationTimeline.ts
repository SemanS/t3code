import type { PeerCoordEvent, PeerCoordSession, PeerStaleReads } from "@t3tools/contracts";

export interface CoordinationTaskName {
  readonly id: string;
  readonly title: string;
  readonly key?: string | undefined;
}

export function coordinationScopeLabel(
  scope: string,
  tasks: readonly CoordinationTaskName[],
): string {
  if (scope === "project") return "Project context";
  const id = scope.replace(/^task:/, "");
  const task = tasks.find((task) => task.id === id);
  return task === undefined ? id : [task.key, task.title].filter(Boolean).join(" · ");
}

export function coordinationActorLabel(
  event: PeerCoordEvent,
  sessions: readonly PeerCoordSession[],
): string {
  const session = sessions.find(
    (session) => session.id === event.session && session.environment === event.environment,
  );
  return session?.label || event.email || "Agent";
}

export function inputReadiness(reads: PeerStaleReads): "stale" | "current" | "empty" | "unknown" {
  if (reads.stale.length > 0) return "stale";
  if (!reads.fresh || reads.reads === undefined) return "unknown";
  return reads.reads.length === 0 ? "empty" : "current";
}

export const inputReadinessLabels = {
  stale: "Update required",
  current: "Up to date",
  empty: "No recorded reads",
  unknown: "Reads unavailable",
} as const;

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
  if (reads.stale.length === 0) return inputReadinessLabels[inputReadiness(reads)];
  return (
    reads.stale
      .map(
        (read) =>
          `${read.scope.replace(/^task:/, "")} v${read.readVersion} → ${read.currentVersion === null ? "removed" : `v${read.currentVersion}`}`,
      )
      .join("; ") || "Shared inputs need checking"
  );
}
