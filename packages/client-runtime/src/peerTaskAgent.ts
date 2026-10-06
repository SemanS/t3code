import type { PeerHubStatus, PeerLocalAgent } from "@t3tools/contracts";

/** Capability is established by the running session, never inferred from installed settings. */
export function peerCoordinationLabel(level: PeerLocalAgent["coordinationLevel"]): string {
  if (level === "A") return "A · action enforced";
  if (level === "B") return "B · hooks active";
  return "C · observed after work";
}

export function peerCoordinationDetail(level: PeerLocalAgent["coordinationLevel"]): string {
  if (level === "A")
    return "A live Claude Mod checks tracked edits with the hub before the action.";
  if (level === "B")
    return "The live session runs Peer hooks. Blocking guarantees depend on the hook deadline.";
  return "Peer observes uncommitted paths after completed work. It cannot prevent overlapping edits or attribute every change to this agent.";
}

export function peerAgentStartBlocker(status: PeerHubStatus): string | null {
  if (!status.signedIn) return "Sign in to a Peer workspace on this environment first.";
  if (status.agents.herdr !== "running")
    return "Install and start herdr on the selected environment, then try again.";
  return null;
}
