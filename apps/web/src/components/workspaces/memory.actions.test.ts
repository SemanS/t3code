import { describe, expect, it } from "vite-plus/test";
import { buildMemoryAction } from "./memory.actions";

describe("human memory commands", () => {
  it("corrects an assertion atomically without changing its applicability", () => {
    const command = buildMemoryAction(
      "correct",
      {
        text: "Checkout dates use the hotel's timezone",
        reason: "A regression test proves the local date",
        revision: "new-checkout",
      },
      "correction",
      { id: "old-claim", version: 3 },
    );
    expect(command).toEqual({
      schemaVersion: 1,
      operationId: "correction",
      type: "assertion.correct",
      id: "old-claim",
      expectedVersion: 3,
      claim: "Checkout dates use the hotel's timezone",
      reason: "A regression test proves the local date",
      evidence: [],
    });
  });
  it("uses the viewed current version for compare-and-swap and explicit successor version", () => {
    const command = buildMemoryAction(
      "supersede",
      { reason: "New test disproves it", references: "new-claim@4" },
      "operation",
      { id: "old-claim", version: 3 },
    );
    expect(command).toMatchObject({
      type: "assertion.supersede",
      id: "old-claim",
      expectedVersion: 3,
      successor: { id: "new-claim", version: 4 },
    });
  });
  it("does not turn an unversioned link or empty correction into a mutation", () => {
    expect(() =>
      buildMemoryAction(
        "supersede",
        { reason: "Correction", references: "new-claim" },
        "operation",
        { id: "old-claim", version: 3 },
      ),
    ).toThrow();
    expect(() =>
      buildMemoryAction("correct", { text: "", reason: "Correction" }, "operation", {
        id: "old-claim",
        version: 3,
      }),
    ).toThrow();
  });
  it("marks a code location without an immutable source fingerprint as weak evidence", () => {
    const command = buildMemoryAction(
      "assertion",
      {
        text: "A date is local",
        evidencePath: "src/date.ts",
        evidenceKind: "code",
        revision: "main",
      },
      "operation",
    );
    expect(command).toMatchObject({
      type: "assertion.record",
      evidence: [{ path: "src/date.ts", weak: true }],
    });
  });
  it("splits a topic using explicit member ownership and leaves topology checks to the service", () => {
    const command = buildMemoryAction(
      "split",
      {
        firstTitle: "Checkout dates",
        firstMembers: "a,b",
        secondTitle: "Deployment dates",
        secondMembers: "c",
        reason: "Different applicability",
      },
      "operation",
      { id: "topic", version: 5 },
    );
    expect(command).toMatchObject({
      type: "context.split",
      expectedVersion: 5,
      contexts: [
        { title: "Checkout dates", memberIds: ["a", "b"] },
        { title: "Deployment dates", memberIds: ["c"] },
      ],
    });
  });
});
