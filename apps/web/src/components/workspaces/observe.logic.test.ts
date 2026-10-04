import { describe, expect, it } from "vite-plus/test";

import { askPrompt } from "./observe.logic";

describe("askPrompt", () => {
  it("hands your agent the colleague's steps and your question, and nothing to do to theirs", () => {
    const prompt = askPrompt({
      thread: {
        person: "Vir",
        title: "Webhook retries",
        project: "vocabulift",
        task: "KRK-335 · DNS lookups",
        t3ProjectId: undefined,
      },
      view: {
        agentId: "peer:1",
        title: "Webhook retries",
        status: "working",
        gone: false,
        entries: [
          { id: "1", kind: "prompt", text: "Retry on empty AAAA answers" },
          {
            id: "2",
            kind: "tool",
            name: "Bash",
            summary: "$ cargo test",
            result: "test result: FAILED",
            failed: true,
          },
          { id: "3", kind: "text", text: "Cloudflare returns an empty AAAA answer." },
        ],
      },
      question: "Does this explain my DNS errors?",
    });
    expect(prompt).toContain(
      'Vir shares the work of their agent on KRK-335 · DNS lookups: "Webhook retries"',
    );
    expect(prompt).toContain("- Vir asked: Retry on empty AAAA answers");
    expect(prompt).toContain("- $ cargo test → test result: FAILED (failed)");
    expect(prompt).toContain("- The agent said: Cloudflare returns an empty AAAA answer.");
    expect(prompt.endsWith("do not change Vir's work. Does this explain my DNS errors?")).toBe(
      true,
    );
  });
});
