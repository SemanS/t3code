interface Sample {
  readonly event?: unknown;
  readonly session?: unknown;
  readonly runtimeGeneration?: unknown;
  readonly id?: unknown;
  readonly turnId?: unknown;
  readonly index?: unknown;
  readonly agentId?: unknown;
  readonly ms?: unknown;
  readonly chars?: unknown;
  readonly answer?: unknown;
  readonly usage?: unknown;
  readonly findings?: unknown;
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function percentile(values: number[], rank: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)]!;
}

/** Protocol evidence and estimates stay distinct; logs cannot prove that a model used a finding. */
export function coordinationMetrics(samples: readonly Sample[]) {
  const prepared = new Map<string, number>();
  const verified = new Set<string>();
  const usageRequests = new Set<string>();
  const noticeFindings = new Set<string>();
  const requestedFindings = new Set<string>();
  const latencies: number[] = [];
  let hookChars = 0;
  let fallbacks = 0;
  let handoffsBlocked = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSamples = 0;
  for (const sample of samples) {
    const identity = JSON.stringify([sample.session, sample.runtimeGeneration, sample.id]);
    if (sample.event === "delivery.prepared") prepared.set(identity, number(sample.chars));
    if (sample.event === "delivery.verified") verified.add(identity);
    if (
      (sample.event === "finding.prepared" || sample.event === "finding.requested") &&
      Array.isArray(sample.findings)
    ) {
      const findings = sample.event === "finding.prepared" ? noticeFindings : requestedFindings;
      for (const id of sample.findings) {
        if (typeof id === "string")
          findings.add(JSON.stringify([sample.session, sample.runtimeGeneration, id]));
      }
    }
    if (sample.event === "hook") hookChars += number(sample.chars);
    if (sample.event === "intent") latencies.push(number(sample.ms));
    if (sample.event === "intent.failed" || sample.event === "intent.unverified") fallbacks++;
    if (sample.event === "handoff.stale" || sample.event === "handoff.unverified")
      handoffsBlocked++;
    if (
      sample.event !== "provider.usage" ||
      typeof sample.usage !== "object" ||
      sample.usage === null
    )
      continue;
    const request = JSON.stringify([
      sample.session,
      sample.runtimeGeneration,
      sample.agentId,
      sample.turnId,
      sample.index,
    ]);
    if (sample.turnId !== undefined && usageRequests.has(request)) continue;
    usageRequests.add(request);
    const usage = sample.usage as Record<string, unknown>;
    inputTokens +=
      number(usage.input_tokens ?? usage.inputTokens) +
      number(usage.cache_read_input_tokens) +
      number(usage.cache_creation_input_tokens);
    outputTokens += number(usage.output_tokens ?? usage.outputTokens);
    usageSamples++;
  }
  const confirmedChars = [...prepared].reduce(
    (sum, [id, chars]) => sum + (verified.has(id) ? chars : 0),
    0,
  );
  return {
    hookContext: {
      chars: hookChars,
      tokenEstimate: Math.ceil(hookChars / 4),
      estimateMethod: "chars/4",
      receipt: "unknown for settings hooks",
    },
    modDelivery: {
      prepared: prepared.size,
      verified: [...verified].filter((id) => prepared.has(id)).length,
      pending: [...prepared.keys()].filter((id) => !verified.has(id)).length,
      confirmedChars,
    },
    intent: {
      count: latencies.length,
      p50Ms: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      fallbackEvents: fallbacks,
    },
    handoffsBlocked,
    findings: {
      noticePrepared: noticeFindings.size,
      explicitlyRequested: requestedFindings.size,
      evidence: "host preparation and explicit request; not proof of model use",
    },
    provider: {
      usageSamples,
      inputTokens,
      outputTokens,
      source: "provider-reported request usage; includes cache input",
    },
    findingUse: "unknown; task outcome evaluation required",
  };
}
