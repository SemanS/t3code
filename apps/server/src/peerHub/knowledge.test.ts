// @effect-diagnostics nodeBuiltinImport:off - knowledge files in a temporary repository.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  capturedId,
  directBody,
  distilledIds,
  distillMiss,
  dryRunEntries,
  entryParts,
  guidanceThread,
  keepThread,
  projectGuidance,
  promotedPath,
  relatedTitle,
  titleOf,
} from "./knowledge.ts";

describe("reading kontext's answers", () => {
  it("finds what capture, distill and promote did", () => {
    assert.strictEqual(
      capturedId("captured inbox:2026-10-04-prices-are-cents\n"),
      "2026-10-04-prices-are-cents",
    );
    assert.isNull(capturedId("kontext: not a repository"));
    assert.deepStrictEqual(
      distilledIds(
        "Distilling 1 thread(s)…\n\n## stdin\n\n[learning] Callers see url_not_public  (apps/server/src/net.rs)\n→ inbox:2026-10-04-callers-see\n\n1 entry in the inbox",
      ),
      ["2026-10-04-callers-see"],
    );
    assert.strictEqual(
      promotedPath("2026-10-04-callers-see → .ai/learnings/callers-see.md (staged)\n"),
      ".ai/learnings/callers-see.md",
    );
  });

  it("names the entry a search found in the knowledge, not in commits", () => {
    const json = JSON.stringify({
      hits: [
        { kind: "commit", title: "fix(net): map errors" },
        { kind: "learning", title: "checked_addr errors reach clients" },
      ],
    });
    assert.strictEqual(relatedTitle(json), "checked_addr errors reach clients");
    assert.isNull(relatedTitle("not json"));
  });

  it("says why distill wrote nothing: its model failed, or found nothing new", () => {
    assert.strictEqual(
      distillMiss({
        code: 0,
        stdout:
          "Distilling 1 thread(s)…\n  text:- · 1 part(s), 2s · 0 entries · part 1: adapter 'llm-claude': `env` exited with exit status: 1: Not logged in · Please run /login\n\nNothing durable found (or all of it is recorded already).\n",
        stderr: "",
      }),
      "kontext's model did not run (adapter 'llm-claude': `env` exited with exit status: 1: Not logged in · Please run /login)",
    );
    assert.strictEqual(
      distillMiss({
        code: 1,
        stdout: "",
        stderr: "Error: choose the model with --llm (llm-claude, llm-codex)\n",
      }),
      "kontext's model did not run (Error: choose the model with --llm (llm-claude, llm-codex))",
    );
    assert.strictEqual(
      distillMiss({
        code: 0,
        stdout:
          "Distilling 1 thread(s)…\n  text:- · 1 part(s), 6s · 0 entries\n\nNothing durable found (or all of it is recorded already).\n",
        stderr: "",
      }),
      "kontext's model found nothing new in it (it may be recorded already)",
    );
  });

  it("reads the entries a dry run printed, body and all", () => {
    const out = [
      "Distilling 1 thread(s) (dry run)…",
      "",
      "## stdin",
      "",
      "[learning] checked_addr errors reach API clients as url_not_public  (apps/server/src/net.rs, apps/server/src/api/webhooks.rs)",
      "Callers map every error of checked_addr to url_not_public.",
      "",
      "A new message there is visible to API clients.",
      "",
      "[convention] Mark [project] only for what outlives the task",
      "Progress and plans stay unmarked.",
      "",
      "2 entries found; nothing was captured (--dry-run).",
    ].join("\n");
    assert.deepStrictEqual(dryRunEntries(out), [
      {
        kind: "learning",
        title: "checked_addr errors reach API clients as url_not_public",
        paths: ["apps/server/src/net.rs", "apps/server/src/api/webhooks.rs"],
        body: "Callers map every error of checked_addr to url_not_public.\n\nA new message there is visible to API clients.",
      },
      {
        kind: "convention",
        title: "Mark [project] only for what outlives the task",
        paths: [],
        body: "Progress and plans stay unmarked.",
      },
    ]);
  });
});

describe("what kontext reads", () => {
  it("writes an entry without a model from what the agents said and where", () => {
    assert.strictEqual(
      directBody(
        {
          text: "Callers see url_not_public.",
          finders: 2,
          sources: [
            { text: "a", task: "krk-335", tagged: true },
            { text: "b", task: undefined, tagged: false },
          ],
        },
        (task) => task ?? "work outside tasks",
      ),
      "Callers see url_not_public.\n\n2 coding agents found it on their own, working on krk-335, work outside tasks; the team kept it in Peer.",
    );
  });

  it("titles knowledge by an agent's first sentence", () => {
    assert.strictEqual(
      titleOf("Callers map every error to url_not_public. So a new message reaches clients."),
      "Callers map every error to url_not_public",
    );
  });

  it("gives distill the agents' lines, where they were found and the work's shared context", () => {
    const thread = keepThread({
      project: "vocabulift",
      candidate: {
        text: "Callers map every `checked_addr` error to `url_not_public`.",
        finders: 2,
        sources: [
          {
            text: "Callers map every `checked_addr` error to `url_not_public`.",
            task: "krk-335",
            tagged: true,
          },
          {
            text: "API clients see url_not_public for any checked_addr failure.",
            task: undefined,
            tagged: false,
          },
        ],
      },
      where: (task) => (task === undefined ? "work outside tasks" : `task ${task}`),
      context: {
        subject: "KRK-335 · DNS errors",
        text: "## State\n- empty answers read as not public",
      },
    });
    assert.include(thread, "decided to keep this as the project's knowledge");
    assert.include(thread, "(2 found it on their own, on different work)");
    assert.include(
      thread,
      "- API clients see url_not_public for any checked_addr failure. (work outside tasks)",
    );
    assert.include(thread, "The shared context of KRK-335 · DNS errors");
    assert.include(
      guidanceThread({
        project: "vocabulift",
        current: null,
        kept: ["a"],
        dismissed: ["b"],
        missed: [],
      }),
      "Dismissed (marks the team did not want):\n- b",
    );
  });

  it("reads the project's guidance for its agents from its knowledge, newest and not superseded", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kx-"));
    try {
      const dir = NodePath.join(root, ".ai", "conventions");
      NodeFS.mkdirSync(dir, { recursive: true });
      const entry = (id: string, date: string, extra: string, body: string) =>
        `---\nid: ${id}\nkind: convention\ntitle: "Marks"\ndate: ${date}\ntags: [peer-skill]\n${extra}---\n\n${body}\n`;
      NodeFS.writeFileSync(
        NodePath.join(dir, "old.md"),
        entry("old", "2026-10-01", "status: superseded\n", "old rule"),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "new.md"),
        entry("new", "2026-10-04", "", "Mark how the code behaves."),
      );
      NodeFS.writeFileSync(
        NodePath.join(dir, "other.md"),
        "---\nid: other\ntags: [style]\n---\nnot this",
      );
      assert.deepStrictEqual(await projectGuidance(root), {
        id: "new",
        text: "Mark how the code behaves.",
      });
      assert.strictEqual(entryParts(entry("x", "d", "", "body")).fields.kind, "convention");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
