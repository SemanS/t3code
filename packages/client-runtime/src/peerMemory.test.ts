import type { PeerMemoryRecord, PeerMemoryReceipt } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  coalesceMemoryCriticalChanges,
  memoryDeliveryStates,
  memoryEvidenceSources,
  memoryKnowledgeLabel,
  memoryReviewReasons,
  memorySelectionChanges,
  parseMemoryReferences,
  setMemorySelection,
} from "./peerMemory.ts";

const record: PeerMemoryRecord = {
  id: "assertion-one",
  schemaVersion: 1,
  version: 3,
  workspaceId: "team",
  projectId: "project",
  kind: "assertion",
  title: "Dates use the hotel timezone",
  text: "Dates use the hotel timezone",
  aliases: [],
  createdBy: { email: "person@example.com" },
  createdAt: "2026-10-06T10:00:00Z",
  knownAt: "2026-10-06T10:00:00Z",
  recordedAt: "2026-10-06T10:00:00Z",
  applicability: { repositoryId: "repo", revision: "feature-commit" },
  sourceRefs: [],
  derivedFrom: [],
  operationId: "op",
  contentHash: "hash",
  lifecycle: "active",
  grounding: "proposed",
  independence: "unknown",
  evidenceIds: [],
  evidenceMissing: true,
};

function receipt(
  state: PeerMemoryReceipt["state"],
  version: number,
  generation = "one",
): PeerMemoryReceipt {
  return {
    id: `${state}-${version}-${generation}`,
    state,
    at: "2026-10-06T10:01:00Z",
    createdBy: {
      email: "agent@example.com",
      sessionId: "session",
      environmentId: "environment",
      runtimeGeneration: generation,
    },
    records: [{ id: record.id, version }],
  };
}

describe("Peer Memory presentation", () => {
  it("keeps delivery separate for verified people and original runtime projects", () => {
    const first = { ...receipt("delivered", 3), runtimeProjectId: "first" };
    const second = {
      ...receipt("consumed", 3),
      runtimeProjectId: "first",
      createdBy: { ...first.createdBy, email: "another@example.com" },
    };
    const third = { ...receipt("requested", 3), runtimeProjectId: "second" };
    expect(
      memoryDeliveryStates({ id: record.id, version: 3 }, [first, second, third]),
    ).toHaveLength(3);
  });

  it("labels reviewed Git knowledge separately from the finding that proposed it", () => {
    const promoted: PeerMemoryRecord = {
      ...record,
      knowledge: {
        status: "approved",
        repositoryId: "repo",
        path: ".ai/decision.md",
        knowledgeId: "policy",
      },
    };
    expect(memoryKnowledgeLabel(promoted)).toBe("Linked Git knowledge approved");
    expect(memoryKnowledgeLabel({ ...promoted, kind: "knowledge" })).toBe("Approved knowledge");
    expect(promoted.grounding).toBe("proposed");
  });

  it("keeps delivery proof scoped to the exact version and runtime generation", () => {
    const states = memoryDeliveryStates({ id: record.id, version: 3 }, [
      receipt("consumed", 2),
      receipt("delivered", 3),
      receipt("requested", 3, "two"),
    ]);
    expect(states.map((state) => [state.runtimeGeneration, state.state])).toEqual([
      ["one", "delivered"],
      ["two", "requested"],
    ]);
  });

  it("does not invent delivery from availability or a receipt for a different record", () => {
    expect(
      memoryDeliveryStates({ id: record.id, version: 3 }, [
        { ...receipt("consumed", 3), records: [{ id: "other", version: 3 }] },
      ]),
    ).toEqual([]);
  });

  it("does not present one immutable source reached through two graph paths as two sources", () => {
    const source = {
      kind: "code" as const,
      path: "src/date.ts",
      revision: "commit",
      blobHash: "blob",
      weak: false,
    };
    expect(
      memoryEvidenceSources({ ...record, sourceRefs: [source] }, [
        {
          ...record,
          id: "evidence",
          kind: "evidence",
          sourceRefs: [
            {
              weak: false,
              blobHash: "blob",
              revision: "commit",
              path: "src/date.ts",
              kind: "code",
            },
          ],
        },
      ]),
    ).toEqual([source]);
  });

  it("retains the selected historical version until a person explicitly changes it", () => {
    const selected = [{ id: record.id, version: 2 }];
    expect(memorySelectionChanges(selected, [record])).toEqual([
      { selected: selected[0], current: record },
    ]);
    expect(selected).toEqual([{ id: record.id, version: 2 }]);
    expect(setMemorySelection(selected, { id: record.id, version: 3 }, true)).toEqual([
      { id: record.id, version: 3 },
    ]);
  });

  it("reports missing evidence, conflict, and pending Git review independently", () => {
    expect(
      memoryReviewReasons(
        {
          ...record,
          kind: "knowledge",
          knowledge: {
            status: "kept_pending_review",
            repositoryId: "repo",
            path: ".ai/decision.md",
            knowledgeId: "knowledge",
          },
        },
        [{ ...record, id: "counter-evidence", evidenceMissing: false }],
      ),
    ).toEqual(["Conflicting evidence", "Evidence missing", "Pending Git review"]);
    expect(
      memoryReviewReasons({ ...record, evidenceMissing: false, grounding: "verified" }, []),
    ).toEqual([]);
  });

  it("requires explicit versions and rejects ambiguous duplicate references", () => {
    expect(parseMemoryReferences("assertion-one@3, assertion-two@12")).toEqual([
      { id: "assertion-one", version: 3 },
      { id: "assertion-two", version: 12 },
    ]);
    expect(() => parseMemoryReferences("assertion-one")).toThrow("id@version");
    expect(() => parseMemoryReferences("assertion-one@0")).toThrow("id@version");
    expect(() => parseMemoryReferences("assertion-one@3, assertion-one@4")).toThrow(
      "Choose one version",
    );
  });

  it("keeps unresolved critical changes while coalescing duplicate and older versions", () => {
    const critical = {
      cursor: 3,
      id: "a",
      version: 3,
      type: "record.retracted",
      critical: true,
      at: "2026-10-06T10:00:00Z",
    };
    expect(
      coalesceMemoryCriticalChanges(
        [critical],
        [
          { ...critical, cursor: 2, version: 2 },
          { ...critical, cursor: 4, id: "b", critical: false },
          { ...critical, cursor: 5, id: "c" },
        ],
      ),
    ).toEqual([critical, { ...critical, cursor: 5, id: "c" }]);
  });
});
