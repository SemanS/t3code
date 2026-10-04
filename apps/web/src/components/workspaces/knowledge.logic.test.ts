import { describe, expect, it } from "vite-plus/test";

import { decisionStats, kontextCaptureCommand } from "./knowledge.logic";

describe("kontextCaptureCommand", () => {
  it("titles a candidate by its first sentence and quotes it for the shell", () => {
    expect(
      kontextCaptureCommand({
        text: "Callers map every error to url_not_public. So a new message reaches API clients.",
        finders: 2,
      }),
    ).toBe(
      "kontext capture --kind learning --title 'Callers map every error to url_not_public.' --body 'Callers map every error to url_not_public. So a new message reaches API clients.\n\n2 agents found it on their own, on different work. Proposed in Peer.'",
    );
    expect(kontextCaptureCommand({ text: "worker.rs isn't guarded", finders: 1 })).toContain(
      "--title 'worker.rs isn'\\''t guarded'",
    );
  });
});

describe("decisionStats", () => {
  it("counts what people kept, and how many of the agents' own marks", () => {
    const mark = { tagged: true };
    const harvest = { tagged: true, origin: "context:task:krk-335@v4" };
    const found = { tagged: false };
    expect(
      decisionStats([
        { status: "promoted", sources: [mark] },
        { status: "dismissed", sources: [mark] },
        { status: "promoted", sources: [found, found] },
        { status: "promoted", sources: [harvest] },
        { status: "proposed", sources: [mark] },
      ]),
    ).toEqual({ decided: 4, kept: 3, marked: 2, markedKept: 1 });
  });
});
