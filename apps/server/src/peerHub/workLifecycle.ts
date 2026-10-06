/** Runtime leases and host evidence for durable work. No model calls or agent transcripts. */
import type {
  PeerWorkPullRequest,
  PeerWorkStatus,
  PeerWorkThread,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { gitHubRepository } from "./github.ts";
import type { ReportedThread } from "./hubApi.ts";

const HostPullRequest = Schema.Struct({
  url: Schema.String,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  headRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
});
const decode = Schema.decodeUnknownOption(HostPullRequest);
const FIELDS = "url,state,headRefName,isCrossRepository";

/** Recover known identity before replaying dormant work, including a temporary herdr alias. */
export function restoreWorkIdentity(
  thread: ReportedThread,
  previous: ReadonlyArray<PeerWorkThread>,
): ReportedThread {
  const known = previous.find(
    (old) =>
      (old.id === thread.id || old.previousId === thread.id) &&
      (thread.repository === undefined ||
        old.repository === undefined ||
        old.repository === thread.repository) &&
      (thread.branch === undefined || old.branch === undefined || old.branch === thread.branch),
  );
  if (known === undefined) return thread;
  const branch = thread.branch ?? known.branch;
  const repository = thread.repository ?? known.repository;
  const previousId = thread.previousId ?? known.previousId;
  return {
    ...thread,
    id: known.id,
    ...(branch === undefined ? {} : { branch }),
    ...(repository === undefined ? {} : { repository }),
    ...(previousId === undefined ? {} : { previousId }),
  };
}

/** Live runtimes get every heartbeat; rotate dormant evidence within the wire's 500-row bound. */
export function boundedWorkReport(
  threads: ReadonlyArray<ReportedThread>,
  round: number,
): ReadonlyArray<ReportedThread> {
  const live = threads.filter((thread) => thread.runtimePresent !== false);
  const dormant = threads.filter((thread) => thread.runtimePresent === false);
  const room = Math.max(0, 500 - live.length);
  const start = dormant.length === 0 ? 0 : (round * Math.max(1, room)) % dormant.length;
  return [...live.slice(0, 500), ...dormant.slice(start), ...dormant.slice(0, start)].slice(0, 500);
}

/** Register the full required set; only host reads are batched, with unfinished PRs first. */
export function pullRequestBatch(
  prs: ReadonlyArray<PeerWorkPullRequest>,
  branch: string | undefined,
): ReadonlyArray<PeerWorkPullRequest> {
  const anchor = prs.find((pr) => pr.headBranch === branch);
  return [
    ...(anchor === undefined ? [] : [anchor]),
    ...prs.filter((pr) => pr !== anchor && pr.state !== "merged"),
  ].slice(0, 20);
}

export function mergePullRequestEvidence(
  required: ReadonlyArray<PeerWorkPullRequest> | undefined,
  observed: ReadonlyArray<PeerWorkPullRequest> | undefined,
): ReadonlyArray<PeerWorkPullRequest> | undefined {
  if (observed === undefined) return required;
  const merged = new Map((required ?? []).map((pr) => [pr.url.toLowerCase(), pr]));
  for (const pr of observed) merged.set(pr.url.toLowerCase(), pr);
  return [...merged.values()];
}

/** A durable provider thread can outlive its actual runtime, including after app recovery. */
export function nativeRuntimePresent(
  provider: { readonly status: string; readonly providerSessionId: string | null } | undefined,
  sessions: ReadonlyArray<{ readonly id: string; readonly status: string }>,
): boolean {
  return (
    provider !== undefined &&
    (provider.status === "idle" || provider.status === "active") &&
    sessions.some(
      (session) =>
        session.id === provider.providerSessionId &&
        ["starting", "ready", "running", "waiting"].includes(session.status),
    )
  );
}

/** Unrelated native PR links must not poison an environment's entire heartbeat report. */
export function nativeWorkPullRequests(
  repositoryUrl: string,
  branch: string | null,
  links: ReadonlyArray<ThreadPullRequestLink>,
): ReadonlyArray<PeerWorkPullRequest> | undefined {
  const repo = gitHubRepository(repositoryUrl);
  const visible = links.filter((link) => link.source !== "stack-dismissed");
  if (repo === null || branch === null || visible.length === 0) return undefined;
  if (
    visible.some(
      (link) =>
        link.host !== "github.com" ||
        link.repository.toLowerCase() !== repo.nameWithOwner.toLowerCase(),
    )
  )
    return undefined;
  if (!visible.some((link) => link.snapshot?.headBranch === branch)) return undefined;
  return visible.map((link) => ({
    url: `https://github.com/${repo.nameWithOwner}/pull/${link.number}`,
    state: link.snapshot?.state ?? "unknown",
    headBranch: link.snapshot?.headBranch ?? branch,
  }));
}

/**
 * Discover only open PRs: a historical merge on a reused branch proves nothing about this work.
 * Once registered, refresh each exact URL, including while the runtime is absent. A partial or
 * failed read returns undefined so the hub keeps its last evidence and never infers completion.
 */
export async function readWorkPullRequests(
  input: {
    readonly repositoryUrl: string;
    readonly branch: string;
    readonly known: ReadonlyArray<PeerWorkPullRequest>;
  },
  run: (args: ReadonlyArray<string>) => Promise<string>,
): Promise<ReadonlyArray<PeerWorkPullRequest> | undefined> {
  const repo = gitHubRepository(input.repositoryUrl);
  if (repo === null || input.branch === "" || input.known.length > 20) return undefined;
  const prefix = `https://github.com/${repo.nameWithOwner.toLowerCase()}/pull/`;
  const belongs = (url: string) => {
    const lower = url.toLowerCase();
    return lower.startsWith(prefix) && /^[1-9][0-9]*$/.test(lower.slice(prefix.length));
  };
  if (input.known.some((pr) => !belongs(pr.url))) return undefined;
  try {
    let rows: unknown;
    if (input.known.length === 0) {
      rows = JSON.parse(
        await run([
          "pr",
          "list",
          "--repo",
          repo.nameWithOwner,
          "--head",
          input.branch,
          "--state",
          "open",
          "--limit",
          "21",
          "--json",
          FIELDS,
        ]),
      );
    } else {
      const snapshots: unknown[] = [];
      for (const pr of input.known)
        snapshots.push(JSON.parse(await run(["pr", "view", pr.url, "--json", FIELDS])));
      rows = snapshots;
    }
    if (!Array.isArray(rows) || rows.length > 20) return undefined;
    const result: PeerWorkPullRequest[] = [];
    for (const [index, row] of rows.entries()) {
      const decoded = decode(row);
      if (Option.isNone(decoded)) return undefined;
      const pr = decoded.value;
      const known = input.known[index];
      if (
        !belongs(pr.url) ||
        pr.isCrossRepository ||
        (known === undefined
          ? pr.state !== "OPEN" || pr.headRefName !== input.branch
          : pr.url.toLowerCase() !== known.url.toLowerCase() ||
            (known.state !== "unknown" && pr.headRefName !== known.headBranch))
      )
        return undefined;
      result.push({
        url: pr.url,
        state: pr.state.toLowerCase() as PeerWorkPullRequest["state"],
        headBranch: pr.headRefName,
      });
    }
    return result;
  } catch {
    return undefined;
  }
}

/** Hooks are a fallback lease. herdr's confirmed runtime survives quiet thinking or user waits. */
export function runtimeStillPresent(input: {
  readonly runtime: PeerWorkStatus | null | undefined;
  readonly lastActivity: number;
  readonly lastPresent?: number;
  readonly now: number;
}): boolean {
  if (input.runtime === null)
    return input.now - Math.max(input.lastPresent ?? 0, input.lastActivity) <= 180_000;
  return input.runtime !== undefined || input.now - input.lastActivity <= 30 * 60_000;
}

/** Host reads never delay heartbeats. At most four run together, once a minute per work. */
export class WorkDeliveryTracker {
  private readonly cache = new Map<
    string,
    { at: number; value: ReadonlyArray<PeerWorkPullRequest> | undefined }
  >();
  private readonly pending = new Set<string>();
  private readonly waiting = new Map<string, () => Promise<void>>();

  private drain(): void {
    while (this.pending.size < 4 && this.waiting.size > 0) {
      const [key, job] = this.waiting.entries().next().value!;
      this.waiting.delete(key);
      this.pending.add(key);
      void job().finally(() => {
        this.pending.delete(key);
        this.drain();
      });
    }
  }

  read(
    input: Parameters<typeof readWorkPullRequests>[0] & { readonly workId: string },
    run: Parameters<typeof readWorkPullRequests>[1],
    now: number,
  ): ReadonlyArray<PeerWorkPullRequest> | undefined {
    const key = JSON.stringify([
      input.workId,
      input.repositoryUrl,
      input.branch,
      input.known.map((pr) => pr.url).sort(),
    ]);
    const cached = this.cache.get(key);
    if (
      (cached === undefined || now - cached.at >= 60_000) &&
      !this.pending.has(key) &&
      !this.waiting.has(key) &&
      this.waiting.size < 500
    ) {
      this.waiting.set(key, async () => {
        const value = await readWorkPullRequests(input, run);
        this.cache.set(key, { at: now, value });
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
      });
      this.drain();
    }
    return cached?.value;
  }
}
