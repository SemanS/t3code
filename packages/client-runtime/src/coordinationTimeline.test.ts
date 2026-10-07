import { describe, expect, it } from "@effect/vitest";
import {
  coordinationEventLabel,
  coordinationTimeline,
  staleInputSummary,
  inputReadiness,
  coordinationScopeLabel,
} from "./coordinationTimeline.ts";

describe("coordination history", () => {
  it("does not present missing or empty receipts as current inputs", () => {
    expect(inputReadiness({ fresh: true, stale: [] })).toBe("unknown");
    expect(inputReadiness({ fresh: true, reads: [], stale: [] })).toBe("empty");
    expect(
      inputReadiness({
        fresh: true,
        reads: [
          {
            project: "app",
            scope: "project",
            session: "b",
            environment: "mac",
            version: 2,
            at: "",
          },
        ],
        stale: [],
      }),
    ).toBe("current");
  });
  it("keeps a deleted context visibly stale and names the task", () => {
    const inputs = {
      fresh: false,
      reads: [],
      stale: [
        {
          project: "app",
          scope: "task:123",
          readVersion: 2,
          currentVersion: null,
          at: "",
          updatedAt: null,
        },
      ],
    };
    expect(inputReadiness(inputs)).toBe("stale");
    expect(staleInputSummary(inputs)).toBe("123 v2 → removed");
    expect(
      coordinationScopeLabel("task:123", [{ id: "123", title: "Board filters", key: "LP-1" }]),
    ).toBe("LP-1 · Board filters");
    expect(coordinationScopeLabel("project", [])).toBe("Project context");
  });
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
