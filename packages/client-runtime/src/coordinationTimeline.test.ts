import { describe, expect, it } from "@effect/vitest";
import {
  coordinationEventLabel,
  coordinationTimeline,
  staleInputSummary,
} from "./coordinationTimeline.ts";

describe("coordination history", () => {
  it("preserves one event and its participants when updates arrive out of order", () => {
    const one = {
      id: "a",
      kind: "context-write",
      project: "app",
      at: "2026-10-06T10:00:00Z",
      version: 3,
      paths: [],
      participants: ["claude:a", "codex:b"],
    };
    const two = { ...one, id: "b", at: "2026-10-06T10:01:00Z" };
    expect(coordinationTimeline([two, one, two])).toEqual([two, one]);
    expect(coordinationEventLabel(one)).toBe("Shared context updated · v3");
  });
  it("shows exact stale versions and preserves unknown event kinds", () => {
    expect(
      staleInputSummary({
        fresh: false,
        stale: [
          {
            project: "app",
            scope: "task:build",
            readVersion: 2,
            currentVersion: 4,
            at: "",
            updatedAt: "",
          },
        ],
      }),
    ).toBe("build v2 → v4");
    expect(
      coordinationEventLabel({
        id: "a",
        kind: "future",
        project: "app",
        at: "",
        paths: [],
        participants: [],
      }),
    ).toBe("future");
  });
});
