// @effect-diagnostics nodeBuiltinImport:off - reads exact Git objects and stages human-kept proposals.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  PeerHubMemoryImportKnowledgeInput,
  PeerMemoryCommand,
  PeerMemoryRecord,
  PeerMemoryApplicability,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isSafeGitRef } from "../gitSafety.ts";
import { parseEntry } from "../knowledgeIndex.ts";
import { MemoryError } from "./MemoryTransport.ts";

const hash = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const git = (root: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          ["-C", root, ...args],
          {
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
          (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
        );
      }),
    catch: (cause) =>
      new MemoryError({
        code: "invalid",
        detail: "The configured Git review source could not be verified.",
        cause,
      }),
  });
const knowledgePath = (path: string) =>
  /^\.ai\/(?:decisions|conventions|learnings|incidents)\/[\p{L}\p{N}_.-]{1,160}\.md$/u.test(path);
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));
export const approvedRevision = (root: string, branch: string) =>
  isSafeGitRef(branch)
    ? git(root, ["rev-parse", "--verify", `refs/remotes/origin/${branch}^{commit}`]).pipe(
        Effect.map((value) => value.trim()),
      )
    : Effect.fail(
        new MemoryError({
          code: "invalid",
          detail: "The repository's configured review branch is invalid.",
        }),
      );

export const importCommands = Effect.fn("MemoryKnowledge.importCommands")(function* (
  repository: { readonly root: string; readonly branch: string },
  input: PeerHubMemoryImportKnowledgeInput,
) {
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit) ||
    !isSafeGitRef(repository.branch) ||
    input.reviewRef !== repository.branch
  )
    return yield* new MemoryError({
      code: "invalid",
      detail:
        "Import needs a full committed revision and the repository's configured reviewed branch.",
    });
  const reviewed = `refs/remotes/origin/${repository.branch}`;
  const tip = (yield* git(repository.root, [
    "rev-parse",
    "--verify",
    `${reviewed}^{commit}`,
  ])).trim();
  if (tip !== input.commit)
    return yield* new MemoryError({
      code: "invalid",
      detail:
        "Import the current tip of the configured reviewed branch, so an older import cannot replace newer knowledge.",
    });
  yield* git(repository.root, ["merge-base", "--is-ancestor", input.commit, reviewed]);
  const listed =
    input.paths ??
    (yield* git(repository.root, ["ls-tree", "-r", "--name-only", input.commit, "--", ".ai"]))
      .split("\n")
      .filter(knowledgePath);
  if (listed.length > 200 || listed.some((path) => !knowledgePath(path)))
    return yield* new MemoryError({
      code: "invalid",
      detail: "Select up to 200 committed knowledge Markdown files under .ai.",
    });
  const commands: PeerMemoryCommand[] = [];
  for (const path of new Set(listed)) {
    const text = yield* git(repository.root, ["show", `${input.commit}:${path}`]);
    const entry = parseEntry(text, path);
    if (entry === undefined || text.length > 100_000)
      return yield* new MemoryError({
        code: "invalid",
        detail: "A committed knowledge source needs a knowledge ID, title, and a bounded body.",
      });
    if (
      (entry.status !== undefined && !["accepted", "active", "approved"].includes(entry.status)) ||
      (entry.kind === "decision" && entry.status !== "accepted")
    )
      continue;
    const blobHash = (yield* git(repository.root, ["rev-parse", `${input.commit}:${path}`])).trim();
    commands.push({
      schemaVersion: 1,
      operationId: `knowledge:${hash(`${input.workspace}/${input.project}/${input.repositoryId}/${input.commit}/${path}/${blobHash}`)}`,
      type: "knowledge.import",
      title: entry.title,
      text,
      knowledgeId: entry.id,
      reviewRef: input.reviewRef,
      source: {
        kind: "knowledge",
        repositoryId: input.repositoryId,
        revision: input.commit,
        path,
        blobHash,
        weak: false,
      },
    });
  }
  return commands;
});

export const keep = Effect.fn("MemoryKnowledge.keep")(function* (
  root: string,
  record: PeerMemoryRecord,
  requestedPath?: string,
) {
  const path = requestedPath ?? `.ai/learnings/peer-memory-${hash(record.id).slice(0, 20)}.md`;
  if (!knowledgePath(path))
    return yield* new MemoryError({
      code: "invalid",
      detail: "Keep needs a Markdown filename in the project's .ai knowledge store.",
    });
  const text = [
    "---",
    `id: ${quote(`peer-memory-${record.id}`)}`,
    `title: ${quote(record.title)}`,
    `kind: ${path.includes("/decisions/") ? "decision" : path.includes("/conventions/") ? "convention" : path.includes("/incidents/") ? "incident" : "learning"}`,
    "status: proposed",
    `memory: ${quote(`${record.id}@${record.version}`)}`,
    "---",
    "",
    record.text,
    "",
    `Memory source: ${record.id}@${record.version} (${record.contentHash}).`,
    "",
    "Kept in Peer pending Git review. This draft is not approved project knowledge.",
    "",
  ].join("\n");
  yield* Effect.tryPromise({
    try: async () => {
      const realRoot = await NodeFSP.realpath(root);
      const directory = NodePath.join(root, NodePath.dirname(path));
      // A repository-provided symlink must not redirect Keep outside this checkout.
      for (const suffix of [".ai", NodePath.dirname(path)]) {
        const absolute = NodePath.join(root, suffix);
        const stat = await NodeFSP.lstat(absolute).catch(() => null);
        if (stat?.isSymbolicLink()) throw new Error("Knowledge directory is a symlink");
      }
      await NodeFSP.mkdir(directory, { recursive: true });
      const realDirectory = await NodeFSP.realpath(directory);
      if (!realDirectory.startsWith(`${realRoot}${NodePath.sep}`))
        throw new Error("Knowledge destination is outside checkout");
      const destination = NodePath.join(root, path);
      if ((await NodeFSP.lstat(destination).catch(() => null))?.isSymbolicLink())
        throw new Error("Knowledge draft is a symlink");
      const existing = await NodeFSP.readFile(destination, "utf8").catch(() => null);
      if (existing !== null && existing !== text)
        throw new Error("Knowledge path already contains another draft");
      if (existing === null) await NodeFSP.writeFile(destination, text, { flag: "wx" });
    },
    catch: (cause) =>
      new MemoryError({
        code: "local",
        detail:
          "The knowledge draft could not be safely staged; select an unused path inside this checkout.",
        cause,
      }),
  });
  yield* git(root, ["add", "--", path]);
  return { path };
});

export const gitEvidence = Effect.fn("MemoryKnowledge.gitEvidence")(function* (
  session: { readonly root: string; readonly repositoryId?: string },
  location: string,
) {
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(location);
  const path = match?.[1] ?? location;
  if (NodePath.isAbsolute(path) || path.split(/[\\/]/).includes("..") || /[\0\r\n]/.test(path))
    return yield* new MemoryError({
      code: "invalid",
      detail: "Evidence must identify a file inside this repository.",
    });
  const revision = yield* git(session.root, ["rev-parse", "--verify", "HEAD"]).pipe(Effect.option);
  const blob = Option.isSome(revision)
    ? yield* git(session.root, ["rev-parse", `${revision.value.trim()}:${path}`]).pipe(
        Effect.option,
      )
    : Option.none<string>();
  const diff = yield* git(session.root, ["diff", "HEAD", "--", path]).pipe(Effect.option);
  const dirty = Option.isSome(diff) && diff.value !== "";
  return {
    kind: "code" as const,
    path,
    ...(session.repositoryId === undefined ? {} : { repositoryId: session.repositoryId }),
    ...(Option.isSome(revision) ? { revision: revision.value.trim() } : {}),
    ...(Option.isSome(blob) ? { blobHash: blob.value.trim() } : {}),
    ...(match?.[2] === undefined ? {} : { startLine: Number(match[2]) }),
    ...(match?.[3] === undefined ? {} : { endLine: Number(match[3]) }),
    ...(dirty && Option.isSome(revision)
      ? {
          baseRevision: revision.value.trim(),
          diffHash: hash(diff.value),
          environment: "dirty checkout",
        }
      : {}),
    weak:
      Option.isNone(revision) || Option.isNone(blob) || session.repositoryId === undefined || dirty,
  };
});

/** Applicability identifies the exact clean commit or the observed dirty checkout. */
export const gitApplicability = Effect.fn("MemoryKnowledge.gitApplicability")(function* (session: {
  readonly root: string;
  readonly repositoryId?: string;
}) {
  const revision = yield* git(session.root, ["rev-parse", "--verify", "HEAD"]).pipe(Effect.option);
  const diff = yield* git(session.root, ["diff", "HEAD"]).pipe(Effect.option);
  const status = yield* git(session.root, ["status", "--porcelain=v1"]).pipe(Effect.option);
  const dirty = Option.isSome(status) && status.value !== "";
  const applicability: PeerMemoryApplicability = {
    ...(session.repositoryId === undefined ? {} : { repositoryId: session.repositoryId }),
    ...(Option.isNone(revision)
      ? {}
      : dirty
        ? {
            baseRevision: revision.value.trim(),
            diffHash: hash(`${Option.isSome(diff) ? diff.value : ""}\n${status.value}`),
            environment: "dirty checkout",
          }
        : { revision: revision.value.trim() }),
  };
  return applicability;
});
