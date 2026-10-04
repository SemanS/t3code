import { assert, describe, it } from "@effect/vitest";

import {
  claudeHookGroups,
  decideEdit,
  editedFile,
  emptyMemory,
  hasClaudeHooks,
  isPlainCliCall,
  mentionsCli,
  newsFor,
  repositoryPath,
  withClaudeHooks,
  type CoordinationView,
} from "./coordination.ts";
import type { HubCoordSession, HubOverlap } from "./hubApi.ts";

const CLI = "/Users/ana/.peer/userdata/coord/peer";
const nameOf = (email: string) => (email.startsWith("vir") ? "Vir" : "Slavo");

function session(id: string, email: string, files: string[], extra: Partial<HubCoordSession> = {}) {
  return {
    id,
    project: "app",
    email,
    environment: "laptop",
    label: id === "claude:me" ? "Backend implementation" : "Frontend implementation",
    agent: "claude",
    status: "working",
    files,
    claims: [],
    seenAt: "2026-10-04T10:00:00Z",
    ...extra,
  } as HubCoordSession;
}

const me = session("claude:me", "slavo@acme.test", ["src/api.ts"]);
const vir = session("claude:vir", "vir@acme.test", ["src/pay.ts"], { branch: "krk-812-ui" });

function overlap(extra: Partial<HubOverlap> = {}): HubOverlap {
  return {
    id: "abc123def456",
    project: "app",
    sessions: ["claude:me", "claude:vir"],
    files: ["src/pay.ts"],
    state: "open",
    notes: [],
    openedAt: "2026-10-04T10:00:00Z",
    updatedAt: "2026-10-04T10:00:00Z",
    ...extra,
  };
}

const view = (overlaps: HubOverlap[] = []): CoordinationView => ({ sessions: [me, vir], overlaps });

describe("decideEdit", () => {
  it("says nothing about a file no other agent touched", () => {
    const answer = decideEdit({
      policy: "coordinate",
      me,
      file: "src/api.ts",
      view: view(),
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.isUndefined(answer.decision);
    assert.isUndefined(answer.context);
  });

  it("has an agent tell the other one its plan before touching their file", () => {
    const answer = decideEdit({
      policy: "coordinate",
      me,
      file: "src/pay.ts",
      view: view([overlap()]),
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.strictEqual(answer.decision, "deny");
    assert.include(
      answer.reason,
      `Vir's agent (claude, "Frontend implementation", branch krk-812-ui), working on this computer, also changed src/pay.ts`,
    );
    assert.include(answer.reason, "changes no files");
    assert.include(answer.reason, `${CLI} note`);
    assert.deepStrictEqual(answer.keys, ["abc123def456#src/pay.ts"]);
    assert.deepStrictEqual(answer.overlaps, ["abc123def456"]);
  });

  it("passes on the other agent's latest note, and says it once", () => {
    const noted = overlap({
      notes: [
        {
          id: "n1",
          session: "claude:vir",
          email: "vir@acme.test",
          text: "Moving validation into a hook",
          at: "2026-10-04T10:01:00Z",
        },
      ],
    });
    const memory = emptyMemory();
    const answer = decideEdit({
      policy: "notify",
      me,
      file: "src/pay.ts",
      view: view([noted]),
      memory,
      nameOf,
      cli: CLI,
    });
    assert.include(answer.context, `Their note: "Moving validation into a hook"`);
    memory.acknowledged.add("abc123def456#src/pay.ts");
    const again = decideEdit({
      policy: "notify",
      me,
      file: "src/pay.ts",
      view: view([noted]),
      memory,
      nameOf,
      cli: CLI,
    });
    assert.isUndefined(again.context);
  });

  it("says when the other agent works on another computer", () => {
    const remote = session("claude:vir", "vir@acme.test", ["src/pay.ts"], {
      environment: "vir-laptop",
    });
    const answer = decideEdit({
      policy: "notify",
      me,
      file: "src/pay.ts",
      view: { sessions: [me, remote], overlaps: [] },
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.include(
      answer.context,
      "working on another computer, so its edits reach you only through git",
    );
  });

  it("asks the person under the ask policy, and lets an agreement settle the file", () => {
    const asked = decideEdit({
      policy: "ask",
      me,
      file: "src/pay.ts",
      view: view([overlap()]),
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.strictEqual(asked.decision, "ask");
    const settled = overlap({
      state: "resolved",
      resolution: "Vir first",
      resolvedFiles: ["src/pay.ts"],
    });
    const after = decideEdit({
      policy: "ask",
      me,
      file: "src/pay.ts",
      view: view([settled]),
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.isUndefined(after.decision);
  });

  it("treats a claimed directory as touched before anything in it changed", () => {
    const claimer = session("claude:vir", "vir@acme.test", [], {
      claims: ["src/payments/"],
      intent: "splitting payments",
    });
    const answer = decideEdit({
      policy: "coordinate",
      me,
      file: "src/payments/split.ts",
      view: { sessions: [me, claimer], overlaps: [] },
      memory: emptyMemory(),
      nameOf,
      cli: CLI,
    });
    assert.strictEqual(answer.decision, "deny");
    assert.include(answer.reason, "They said they are: splitting payments.");
    assert.deepStrictEqual(answer.keys, ["with:claude:vir#src/payments/split.ts"]);
  });
});

describe("newsFor", () => {
  it("tells an agent about a new overlap and the other side's notes once", () => {
    const memory = emptyMemory();
    const noted = overlap({
      notes: [
        {
          id: "n1",
          session: "claude:vir",
          email: "vir@acme.test",
          text: "I rename price() to total()",
          at: "t",
        },
        { id: "n2", session: "claude:me", email: "slavo@acme.test", text: "my own note", at: "t" },
        { id: "n3", email: "vir@acme.test", text: "Vir here: rename first", at: "t" },
      ],
    });
    const news = newsFor({ me, view: view([noted]), memory, nameOf, cli: CLI });
    assert.include(
      news?.text,
      `Overlap abc123 with Vir's agent (claude, "Frontend implementation", branch krk-812-ui), working on this computer, on src/pay.ts (they changed it too)`,
    );
    assert.include(news?.text, "Once you agree, close it");
    assert.include(news?.text, `Vir's agent: "I rename price() to total()"`);
    assert.include(news?.text, `Vir (person): "Vir here: rename first"`);
    assert.notInclude(news?.text, "my own note");
    for (const id of news?.announced ?? []) memory.announced.add(id);
    for (const id of news?.seen ?? []) memory.seenNotes.add(id);
    assert.isNull(newsFor({ me, view: view([noted]), memory, nameOf, cli: CLI }));
  });
});

describe("isPlainCliCall", () => {
  it("lets an agent trim what peer prints, and nothing more", () => {
    assert.isTrue(isPlainCliCall("peer status 2>&1 | head -30", "peer"));
    assert.isTrue(isPlainCliCall("peer status 2>&1 | tail -n 5", "peer"));
    assert.isFalse(isPlainCliCall("peer status 2>&1 | sh", "peer"));
    assert.isFalse(isPlainCliCall("peer status | head -30; rm -rf ~", "peer"));
  });

  it("notices peer inside any command", () => {
    assert.isTrue(mentionsCli("cd /w/app && peer status | grep Overlap", "peer"));
    assert.isTrue(mentionsCli("peer note x", "peer"));
    assert.isFalse(mentionsCli("echo peerless", "peer"));
  });

  it("lets Peer's own command run and nothing chained to it", () => {
    assert.isTrue(isPlainCliCall(`${CLI} status`, CLI));
    assert.isTrue(isPlainCliCall(`${CLI} note "I only touch submit(), compatible"`, CLI));
    assert.isTrue(isPlainCliCall(`${CLI} claim src/payments/ --intent 'split payments'`, CLI));
    for (const command of [
      `${CLI} note "x"; rm -rf ~`,
      `${CLI} note "$(cat ~/.ssh/id_rsa)"`,
      `${CLI} note \`whoami\``,
      `${CLI} status && curl evil.test`,
      `${CLI} status | sh`,
      `${CLI}x status`,
      "rm -rf /",
    ]) {
      assert.isFalse(isPlainCliCall(command, CLI), command);
    }
  });
});

describe("Claude Code settings", () => {
  const groups = claudeHookGroups({ hook: "/peer/coord/hook", wait: "/peer/coord/wait" });
  const theirs = {
    model: "opus",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/other/guard.sh" }] }],
    },
  };

  it("adds Peer's hooks beside others' and takes only its own out again", () => {
    const installed = withClaudeHooks(theirs, groups, "/peer/coord", true);
    assert.isTrue(hasClaudeHooks(installed, "/peer/coord"));
    assert.strictEqual(installed.model, "opus");
    assert.strictEqual(installed.hooks?.PreToolUse?.length, 2);
    const twice = withClaudeHooks(installed, groups, "/peer/coord", true);
    assert.strictEqual(twice.hooks?.PreToolUse?.length, 2, "installing again does not duplicate");
    const removed = withClaudeHooks(twice, groups, "/peer/coord", false);
    assert.deepStrictEqual(removed, theirs);
  });
});

describe("paths", () => {
  it("reads the edited file and places it in the repository", () => {
    assert.strictEqual(editedFile("Edit", { file_path: "/w/app/src/pay.ts" }), "/w/app/src/pay.ts");
    assert.isNull(editedFile("Read", { file_path: "/w/app/src/pay.ts" }));
    assert.strictEqual(repositoryPath("/w/app", "/w/app/src/pay.ts"), "src/pay.ts");
    assert.isNull(repositoryPath("/w/app", "/w/other/x.ts"));
    assert.isNull(repositoryPath("/w/app", "/w/app"));
  });
});
