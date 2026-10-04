// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - transcripts are JSON lines in a temporary Claude Code folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  findClaudeTranscript,
  readTranscriptTail,
  toolSummary,
  transcriptEntries,
} from "./agentTranscript.ts";

const line = (record: object) => JSON.stringify(record);
const assistant = (...content: object[]) => line({ type: "assistant", message: { content } });
const user = (content: unknown) => line({ type: "user", message: { content } });

const SESSION = [
  line({ type: "ai-title", aiTitle: "Webhook retries" }),
  user(
    "<command-name>/model</command-name>\n<command-args>sonnet</command-args>\n<command-message>model</command-message>",
  ),
  user(
    "Add retries to the webhook sender<system-reminder>the date is 2026-10-04</system-reminder>",
  ),
  assistant(
    { type: "thinking", thinking: "Let me look first." },
    { type: "text", text: "I'll inspect the sender first." },
    { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/app/src/webhooks.rs" } },
  ),
  user([
    { type: "tool_result", tool_use_id: "t1", content: "pub fn send() {}\n…", is_error: false },
  ]),
  assistant({
    type: "tool_use",
    id: "t2",
    name: "Bash",
    input: { command: "cargo test webhooks\n# and nothing else" },
  }),
  user([
    {
      type: "tool_result",
      tool_use_id: "t2",
      content: [{ type: "text", text: "running 4 tests\ntest result: FAILED. 3 passed; 1 failed" }],
      is_error: true,
    },
  ]),
  line({
    type: "assistant",
    isSidechain: true,
    message: { content: [{ type: "text", text: "a subagent's own words" }] },
  }),
  assistant({ type: "tool_use", id: "t3", name: "mcp__kontext__ctx_brief", input: {} }),
  "not json",
];

describe("transcriptEntries", () => {
  it("reads prompts, words and tools with their outcome, and leaves the rest out", () => {
    assert.deepStrictEqual(transcriptEntries(SESSION, { cwd: "/w/app" }), [
      { id: "line-1:0", kind: "prompt", text: "/model sonnet" },
      { id: "line-2:0", kind: "prompt", text: "Add retries to the webhook sender" },
      { id: "line-3:1", kind: "text", text: "I'll inspect the sender first." },
      {
        id: "line-3:2",
        kind: "tool",
        name: "Read",
        summary: "Read src/webhooks.rs",
        failed: false,
        result: "pub fn send() {}",
      },
      {
        id: "line-5:0",
        kind: "tool",
        name: "Bash",
        summary: "$ cargo test webhooks",
        failed: true,
        result: "test result: FAILED. 3 passed; 1 failed",
      },
      {
        id: "line-8:0",
        kind: "tool",
        name: "mcp__kontext__ctx_brief",
        summary: "kontext · ctx_brief",
        failed: false,
      },
    ]);
  });

  it("keeps the newest steps", () => {
    const many = Array.from({ length: 5 }, (_, i) => user(`prompt ${i}`));
    assert.deepStrictEqual(
      transcriptEntries(many, { limit: 2 }).map((entry) => entry.kind === "prompt" && entry.text),
      ["prompt 3", "prompt 4"],
    );
  });

  it("names a tool call the way a person would", () => {
    assert.strictEqual(toolSummary("Grep", { pattern: "retry" }), "Search retry");
    assert.strictEqual(
      toolSummary("Agent", { description: "Find callers" }),
      "Agent: Find callers",
    );
    assert.strictEqual(toolSummary("Mystery", {}), "Mystery");
  });
});

describe("finding a transcript", () => {
  it("finds a session by its id in any project folder, and reads its end as whole lines", async () => {
    const config = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-"));
    try {
      const folder = NodePath.join(config, "projects", "-w-app");
      NodeFS.mkdirSync(folder, { recursive: true });
      const id = "0f6c2a9e-1b2c-4d5e-8f90-123456789abc";
      const path = NodePath.join(folder, `${id}.jsonl`);
      NodeFS.writeFileSync(path, `${user("first")}\n${user("second")}\n${user("third")}\n`);
      assert.strictEqual(await findClaudeTranscript({ id, path: undefined }, config), path);
      assert.isNull(
        await findClaudeTranscript({ id: "../../etc/passwd", path: undefined }, config),
      );
      assert.isNull(
        await findClaudeTranscript(
          { id: "11111111-2222-3333-4444-555555555555", path: undefined },
          config,
        ),
      );
      const tail = await readTranscriptTail(path, user("third").length + 3);
      assert.deepStrictEqual(tail, [user("third")], "a line cut by the start is dropped");
    } finally {
      NodeFS.rmSync(config, { recursive: true, force: true });
    }
  });
});
