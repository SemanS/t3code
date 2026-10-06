import { describe, expect, it } from "@effect/vitest";

import {
  boundedWorkReport,
  mergePullRequestEvidence,
  nativeRuntimePresent,
  nativeWorkPullRequests,
  pullRequestBatch,
  readWorkPullRequests,
  restoreWorkIdentity,
  runtimeStillPresent,
  WorkDeliveryTracker,
} from "./workLifecycle.ts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";

const url = "https://github.com/acme/service/pull/7";
const input = {
  repositoryUrl: "git@github.com:acme/service.git",
  branch: "fix/lifecycle",
  known: [],
};
const snapshot = { url, state: "OPEN", headRefName: "fix/lifecycle", isCrossRepository: false };

describe("work delivery evidence", () => {
  it("discovers open pull requests, never a historical merge on a reused branch", async () => {
    let args: readonly string[] = [];
    const found = await readWorkPullRequests(input, async (command) => {
      args = command;
      return JSON.stringify([snapshot]);
    });
    expect(args).toContain("open");
    expect(found).toEqual([{ url, state: "open", headBranch: "fix/lifecycle" }]);
    expect(
      await readWorkPullRequests(input, async () =>
        JSON.stringify([{ ...snapshot, state: "MERGED" }]),
      ),
    ).toBeUndefined();
  });

  it("refreshes the exact registered pull request even after its agent disappears", async () => {
    const found = await readWorkPullRequests(
      { ...input, known: [{ url, state: "open", headBranch: input.branch }] },
      async (args) => {
        expect(args.slice(0, 3)).toEqual(["pr", "view", url]);
        return JSON.stringify({ ...snapshot, state: "MERGED" });
      },
    );
    expect(found?.[0]?.state).toBe("merged");
  });

  it("leaves existing evidence alone on network failure or an incomplete stack", async () => {
    expect(
      await readWorkPullRequests(input, async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
    expect(await readWorkPullRequests(input, async () => "not JSON")).toBeUndefined();
    const known = [7, 8].map((n) => ({
      url: url.replace("/7", `/${n}`),
      state: "open" as const,
      headBranch: input.branch,
    }));
    expect(
      await readWorkPullRequests({ ...input, known }, async (args) => {
        if (args.includes(known[1]!.url)) throw new Error("offline");
        return JSON.stringify({ ...snapshot, state: "MERGED" });
      }),
    ).toBeUndefined();
  });

  it("does not accept another repository, a fork's matching branch, or a malformed reply", async () => {
    for (const bad of [
      { ...snapshot, url: "https://github.com/other/service/pull/7" },
      { ...snapshot, headRefName: "fix/other" },
      { ...snapshot, isCrossRepository: true },
      { ...snapshot, state: "wat" },
    ])
      expect(await readWorkPullRequests(input, async () => JSON.stringify([bad]))).toBeUndefined();
  });

  it("learns the head of an unresolved stack link from its exact URL", async () => {
    const known = [{ url, state: "unknown" as const, headBranch: input.branch }];
    expect(
      await readWorkPullRequests({ ...input, known }, async () =>
        JSON.stringify({
          ...snapshot,
          url: url.replace("acme", "Acme"),
          headRefName: "fix/stack-base",
          state: "MERGED",
        }),
      ),
    ).toEqual([
      { url: url.replace("acme", "Acme"), headBranch: "fix/stack-base", state: "merged" },
    ]);
  });

  it("registers a full native stack while batching only host reads", () => {
    const links = Array.from({ length: 21 }, (_, index) => ({
      host: "github.com",
      repository: "acme/service",
      number: index + 1,
      source: "manual",
      snapshot: { headBranch: input.branch, state: "open" },
    })) as unknown as ThreadPullRequestLink[];
    const required = nativeWorkPullRequests(input.repositoryUrl, input.branch, links)!;
    expect(required).toHaveLength(21);
    const observed = pullRequestBatch(required, input.branch).map((pr) => ({
      ...pr,
      state: "merged" as const,
    }));
    const merged = mergePullRequestEvidence(required, observed)!;
    expect(merged).toHaveLength(21);
    expect(merged.filter((pr) => pr.state === "open")).toHaveLength(1);
    expect(pullRequestBatch(merged, input.branch).some((pr) => pr.state === "open")).toBe(true);
    expect(
      nativeWorkPullRequests("https://github.com/elsewhere/repo", input.branch, links),
    ).toBeUndefined();
  });

  it("runs every queued work with at most four host reads, even beyond eight works", async () => {
    const tracker = new WorkDeliveryTracker();
    const gate = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    let completed = 0;
    for (let index = 0; index < 12; index++) {
      const workId = `work:${index}`;
      tracker.read(
        { ...input, workId },
        async () => {
          started.push(workId);
          maximum = Math.max(maximum, ++active);
          await gate.promise;
          active--;
          if (++completed === 12) finished.resolve();
          return "[]";
        },
        0,
      );
    }
    expect(started).toHaveLength(4);
    gate.resolve();
    await finished.promise;
    expect(new Set(started).size).toBe(12);
    expect(maximum).toBe(4);
  });

  it("does not reuse another work's merge evidence on the same branch", async () => {
    const tracker = new WorkDeliveryTracker();
    const finished = Promise.withResolvers<void>();
    const known = [{ url, state: "open" as const, headBranch: input.branch }];
    const lookup = async () => JSON.stringify({ ...snapshot, state: "MERGED" });
    for (let index = 0; index < 4; index++)
      tracker.read({ ...input, known, workId: `${index}` }, lookup, 0);
    tracker.read(
      { ...input, workId: "sentinel" },
      async () => {
        try {
          // This FIFO entry starts after work 0 has completed and populated its cache.
          expect(tracker.read({ ...input, known, workId: "0" }, lookup, 1)?.[0]?.state).toBe(
            "merged",
          );
          expect(tracker.read({ ...input, known, workId: "new-work" }, lookup, 1)).toBeUndefined();
          finished.resolve();
        } catch (error) {
          finished.reject(error);
        }
        return "[]";
      },
      0,
    );
    await finished.promise;
  });
});

describe("runtime presence", () => {
  it("keeps a confirmed idle runtime without pretending it recently did work", () => {
    expect(runtimeStillPresent({ lastActivity: 0, runtime: "idle", now: 60 * 60_000 })).toBe(true);
    expect(runtimeStillPresent({ lastActivity: 0, runtime: "working", now: 60 * 60_000 })).toBe(
      true,
    );
    expect(runtimeStillPresent({ lastActivity: 0, runtime: undefined, now: 60 * 60_000 })).toBe(
      false,
    );
    expect(runtimeStillPresent({ lastActivity: 0, runtime: undefined, now: 60_000 })).toBe(true);
  });

  it("expires confirmed absent runtimes from their last presence, not their last tool call", () => {
    expect(
      runtimeStillPresent({
        lastActivity: 0,
        lastPresent: 3_600_000,
        runtime: null,
        now: 3_700_000,
      }),
    ).toBe(true);
    expect(
      runtimeStillPresent({
        lastActivity: 0,
        lastPresent: 3_600_000,
        runtime: null,
        now: 3_800_000,
      }),
    ).toBe(false);
    expect(
      nativeRuntimePresent({ status: "idle", providerSessionId: "p1" }, [
        { id: "p1", status: "stopped" },
      ]),
    ).toBe(false);
    expect(
      nativeRuntimePresent({ status: "idle", providerSessionId: "p1" }, [
        { id: "p1", status: "ready" },
      ]),
    ).toBe(true);
    expect(
      nativeRuntimePresent({ status: "active", providerSessionId: "p1" }, [
        { id: "old", status: "running" },
      ]),
    ).toBe(false);
  });

  it("restores a temporary alias and a missing branch before replaying dormant records", () => {
    const report = {
      id: "herdr:terminal",
      project: "app",
      title: "Build",
      source: "herdr" as const,
      status: "idle" as const,
    };
    const previous = {
      ...report,
      id: "herdr:codex:session",
      previousId: report.id,
      branch: input.branch,
      repository: "api",
      email: "ana@acme.test",
      environment: "laptop",
      seenAt: "2026-10-06T00:00:00Z",
    };
    expect(restoreWorkIdentity(report, [previous])).toMatchObject({
      id: previous.id,
      branch: input.branch,
      repository: "api",
      previousId: report.id,
    });
    expect(restoreWorkIdentity({ ...report, repository: "other" }, [previous]).id).toBe(report.id);
  });

  it("keeps live reports and rotates every dormant work within the 500-row limit", () => {
    const thread = {
      id: "herdr:live",
      project: "app",
      title: "Build",
      source: "herdr" as const,
      status: "idle" as const,
    };
    const reports = [
      thread,
      ...Array.from({ length: 1000 }, (_, i) => ({
        ...thread,
        id: `retained:${i}`,
        runtimePresent: false,
      })),
    ];
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const batch = boundedWorkReport(reports, round);
      expect(batch).toHaveLength(500);
      expect(batch[0]?.id).toBe(thread.id);
      batch.forEach((row) => seen.add(row.id));
    }
    expect(seen.size).toBe(1001);
  });
});
