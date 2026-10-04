/**
 * Observe: a colleague's shared thread, read-only. What Peer knows of it from
 * the work the hub reports, and the question Ask hands to your own agent.
 */
import type { PeerAgentEntry, PeerAgentView, PeerHubStatus, ProjectId } from "@t3tools/contracts";

import { taskLabel } from "./workTree.logic";

export interface ObservedThread {
  readonly person: string;
  readonly title: string;
  readonly project: string;
  readonly task: string | undefined;
  /** Your checkout of the project, where Ask starts its thread. */
  readonly t3ProjectId: ProjectId | undefined;
}

/** A thread the hub reported on `environment`, as the observe page names it. */
export function observedThread(
  status: PeerHubStatus | null,
  workspace: string,
  environment: string,
  thread: string,
): ObservedThread | null {
  const space = status?.workspaces.find((w) => w.slug === workspace);
  for (const state of space?.projects ?? []) {
    const found = state.work.threads.find((t) => t.environment === environment && t.id === thread);
    if (found === undefined) continue;
    const task = state.work.tasks.find((t) => t.id === found.task);
    return {
      person:
        state.project.members.find((m) => m.email === found.email)?.name ??
        found.email.split("@")[0] ??
        found.email,
      title: found.title,
      project: state.project.name,
      task: task === undefined ? undefined : taskLabel(task),
      t3ProjectId: state.repositories.find((repo) => repo.projectId !== undefined)?.projectId,
    };
  }
  return null;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function stepLine(entry: PeerAgentEntry, person: string): string {
  switch (entry.kind) {
    case "prompt":
      return `- ${person} asked: ${clip(entry.text, 600)}`;
    case "text":
      return `- The agent said: ${clip(entry.text, 600)}`;
    case "tool":
      return `- ${entry.summary}${entry.result === undefined ? "" : ` → ${entry.result}`}${entry.failed ? " (failed)" : ""}`;
  }
}

/**
 * What Ask sends your own agent: the colleague's work so far, read-only, and
 * your question. The colleague's agent hears nothing of it.
 */
export function askPrompt(input: {
  readonly thread: ObservedThread;
  readonly view: PeerAgentView;
  readonly question: string;
}): string {
  const { thread, view } = input;
  const steps =
    view.entries !== undefined
      ? view.entries.slice(-40).map((entry) => stepLine(entry, thread.person))
      : (view.terminal ?? "").split("\n").slice(-60);
  return [
    `${thread.person} shares the work of their agent on ${thread.task ?? thread.project}: "${thread.title}". What it has done so far, newest last (read-only, from their computer):`,
    "",
    ...(steps.length === 0 ? ["(nothing yet)"] : steps),
    "",
    `Answer from this and from the repository; do not change ${thread.person}'s work. ${input.question.trim()}`,
  ].join("\n");
}
