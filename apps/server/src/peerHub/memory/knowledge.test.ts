// @effect-diagnostics nodeBuiltinImport:off - isolated committed Git objects and pending drafts.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import type { PeerMemoryRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Knowledge from "./knowledge.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});
const git = (root: string, ...args: string[]) =>
  new Promise<string>((resolve, reject) =>
    NodeChildProcess.execFile(
      "git",
      ["-C", root, ...args],
      { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" } },
      (error, output) => (error === null ? resolve(output.trim()) : reject(error)),
    ),
  );
const fixture = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-memory-git-"));
  directories.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Memory test");
  await git(root, "config", "user.email", "test@acme.test");
  await NodeFSP.mkdir(NodePath.join(root, ".ai", "decisions"), { recursive: true });
  const source =
    "---\nid: dates\nkind: decision\ntitle: Hotel-local dates\nstatus: accepted\n---\nUse the approved hotel timezone.\n";
  const path = ".ai/decisions/dates.md";
  await NodeFSP.writeFile(NodePath.join(root, path), source);
  await git(root, "add", "--", path);
  await git(root, "commit", "-m", "Approved decision fixture");
  const commit = await git(root, "rev-parse", "HEAD");
  await git(root, "update-ref", "refs/remotes/origin/main", commit);
  return {
    root,
    path,
    source,
    commit,
    input: { workspace: "acme", project: "app", repositoryId: "repo", commit, reviewRef: "main" },
  };
};

describe("Peer memory configured Git review", () => {
  it.effect("imports the exact reviewed full blob and ignores uncommitted changes", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(test.root, test.path),
          `${test.source}\nUnreviewed local change.\n`,
        ),
      );
      const first = yield* Knowledge.importCommands(
        { root: test.root, branch: "main" },
        test.input,
      );
      const second = yield* Knowledge.importCommands(
        { root: test.root, branch: "main" },
        test.input,
      );
      expect(first).toEqual(second);
      expect(first).toHaveLength(1);
      const command = first[0];
      expect(command?.type).toBe("knowledge.import");
      if (command?.type !== "knowledge.import") return;
      expect(command.text).toBe(test.source);
      expect(command.source.revision).toBe(test.commit);
      expect(command.source.blobHash).toBe(
        yield* Effect.promise(() => git(test.root, "rev-parse", `${test.commit}:${test.path}`)),
      );
      expect(command.text).not.toContain("Unreviewed local change");
    }),
  );

  it.effect("rejects stale branch tips and never imports committed proposed decisions", () =>
    Effect.gen(function* () {
      const test = yield* Effect.promise(() => fixture());
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(test.root, test.path),
          test.source.replace("status: accepted", "status: proposed"),
        ),
      );
      yield* Effect.promise(() => git(test.root, "add", "--", test.path));
      yield* Effect.promise(() => git(test.root, "commit", "-m", "Draft fixture"));
      const current = yield* Effect.promise(() => git(test.root, "rev-parse", "HEAD"));
      yield* Effect.promise(() =>
        git(test.root, "update-ref", "refs/remotes/origin/main", current),
      );
      const stale = yield* Knowledge.importCommands(
        { root: test.root, branch: "main" },
        test.input,
      ).pipe(Effect.result);
      expect(stale._tag).toBe("Failure");
      const drafted = yield* Knowledge.importCommands(
        { root: test.root, branch: "main" },
        { ...test.input, commit: current },
      );
      expect(drafted).toEqual([]);
    }),
  );

  it.effect(
    "stages Keep as a proposed draft without committing or granting approved authority",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.promise(() => fixture());
        const record: PeerMemoryRecord = {
          id: "assertion-dates",
          version: 2,
          schemaVersion: 1,
          workspaceId: "acme",
          projectId: "app",
          kind: "assertion",
          title: "Dates finding",
          text: "Date handling needs a timezone.",
          aliases: [],
          createdBy: { email: "ana@acme.test" },
          createdAt: "2026-10-06T09:00:00Z",
          knownAt: "2026-10-06T09:00:00Z",
          recordedAt: "2026-10-06T09:00:00Z",
          applicability: {},
          sourceRefs: [],
          derivedFrom: [],
          operationId: "test-op",
          contentHash: "test-hash",
          lifecycle: "active",
          grounding: "proposed",
          independence: "unknown",
          evidenceIds: [],
          evidenceMissing: true,
        };
        const draft = yield* Knowledge.keep(test.root, record);
        expect(yield* Effect.promise(() => git(test.root, "rev-parse", "HEAD"))).toBe(test.commit);
        const staged = yield* Effect.promise(() => git(test.root, "show", `:${draft.path}`));
        expect(staged).toContain("status: proposed");
        expect(staged).toContain("kind: learning");
        expect(staged).toContain("pending Git review");
        const imports = yield* Knowledge.importCommands(
          { root: test.root, branch: "main" },
          test.input,
        );
        expect(imports).toHaveLength(1);
        const outside = NodePath.join(test.root, "outside.md");
        yield* Effect.promise(() => NodeFSP.writeFile(outside, "Outside content"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(outside, NodePath.join(test.root, ".ai", "learnings", "linked.md")),
        );
        const linked = yield* Knowledge.keep(test.root, record, ".ai/learnings/linked.md").pipe(
          Effect.result,
        );
        expect(linked._tag).toBe("Failure");
        expect(yield* Effect.promise(() => NodeFSP.readFile(outside, "utf8"))).toBe(
          "Outside content",
        );
      }),
  );

  it.effect(
    "binds clean evidence to a Git blob and labels dirty observations as weak with a diff hash",
    () =>
      Effect.gen(function* () {
        const test = yield* Effect.promise(() => fixture());
        const session = { root: test.root, repositoryId: "repo" };
        const clean = yield* Knowledge.gitEvidence(session, `${test.path}:6`);
        expect(clean.weak).toBe(false);
        expect(clean.revision).toBe(test.commit);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(test.root, test.path),
            `${test.source}\nObserved dirty change\n`,
          ),
        );
        const dirty = yield* Knowledge.gitEvidence(session, `${test.path}:7`);
        expect(dirty.weak).toBe(true);
        expect(dirty.baseRevision).toBe(test.commit);
        expect(dirty.diffHash).toMatch(/^[a-f0-9]{64}$/);
        const applicability = yield* Knowledge.gitApplicability(session);
        expect(applicability.baseRevision).toBe(test.commit);
        expect(applicability.environment).toBe("dirty checkout");
      }),
  );
});
