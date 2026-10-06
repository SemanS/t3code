import { describe, expect, it } from "@effect/vitest";
import { coordinationMetrics } from "./coordinationMetrics.ts";
describe("coordination measurement", () => {
  it("requires exact runtime receipts and deduplicates provider requests", () => {
    const base = { session: "claude:a", runtimeGeneration: "one", id: "delivery" };
    const usage = {
      ...base,
      event: "provider.usage",
      turnId: "t",
      index: 1,
      usage: { input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 3 },
    };
    const result = coordinationMetrics([
      { ...base, event: "delivery.prepared", chars: 80 },
      { ...base, runtimeGeneration: "two", event: "delivery.verified" },
      { ...base, event: "delivery.verified" },
      { ...base, event: "delivery.verified" },
      usage,
      usage,
      { event: "hook", chars: 80 },
      { event: "intent", ms: 50 },
      { event: "intent", ms: 100 },
    ]);
    expect(result.modDelivery).toEqual({
      prepared: 1,
      verified: 1,
      pending: 0,
      confirmedChars: 80,
    });
    expect(result.provider).toMatchObject({ usageSamples: 1, inputTokens: 15, outputTokens: 3 });
    expect(result.intent).toMatchObject({ p50Ms: 50, p95Ms: 100 });
    expect(result.findingUse).toContain("unknown");
  });
  it("does not invent latency or delivery when no evidence exists", () => {
    expect(coordinationMetrics([]).intent.p95Ms).toBeNull();
    expect(coordinationMetrics([{ event: "hook", chars: 100 }]).modDelivery.verified).toBe(0);
  });
  it("counts distinct subagent requests that share a parent turn and index", () => {
    const sample = {
      event: "provider.usage",
      session: "claude:a",
      runtimeGeneration: "one",
      turnId: "t",
      index: 1,
      usage: { input_tokens: 5, output_tokens: 2 },
    };
    const result = coordinationMetrics([
      sample,
      { ...sample, agentId: "child" },
      { ...sample, agentId: "child" },
    ]);
    expect(result.provider).toMatchObject({ usageSamples: 2, inputTokens: 10, outputTokens: 4 });
  });
  it("distinguishes repeated notices from explicit requests by each session", () => {
    const base = { session: "a", runtimeGeneration: "one", findings: ["f", "f", 42] };
    const result = coordinationMetrics([
      { ...base, event: "finding.prepared" },
      { ...base, event: "finding.prepared" },
      { ...base, event: "finding.requested" },
      { ...base, event: "finding.requested" },
      { ...base, session: "b", event: "finding.requested" },
    ]);
    expect(result.findings).toMatchObject({ noticePrepared: 1, explicitlyRequested: 2 });
    expect(result.findingUse).toContain("unknown");
  });
});
