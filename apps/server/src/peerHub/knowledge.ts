// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - runs kontext in a project's checkout and reads its knowledge files.
/**
 * knowledge — a project's reviewed knowledge (kontext, `.ai/` in its
 * repository) as Peer uses it: where it is kept on this computer, writing a
 * kept candidate into it, reading a task's shared context for what to keep,
 * and the guidance a project gives its agents on what to mark for it.
 *
 * Everything goes through kontext's own capture and promote, so a kept
 * candidate lands staged in the repository and is reviewed with the commit
 * like any other knowledge. Wording an entry uses kontext's distill and its
 * llm adapter, on the computer of the person who asked for it.
 *
 * @module peerHub/knowledge
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface KontextRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * kontext's environment: Peer's own. The coordination lab keeps its Peers'
 * Claude Code settings apart (CLAUDE_CONFIG_DIR) and names, in
 * `PEER_KONTEXT_CLAUDE_CONFIG_DIR`, the person's own Claude Code that
 * kontext's llm adapter runs on; empty for Claude Code's default. Naming
 * ~/.claude is not the same: Claude Code then looks for another sign-in.
 */
function kontextEnv(): NodeJS.ProcessEnv {
  const own = process.env.PEER_KONTEXT_CLAUDE_CONFIG_DIR;
  if (own === undefined) return process.env;
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (own !== "") env.CLAUDE_CONFIG_DIR = own;
  return env;
}

/** Runs `kontext <args>` in `cwd`, with `stdin` when given. Never throws: a missing kontext is code -1. */
export function runKontext(
  args: ReadonlyArray<string>,
  cwd: string,
  stdin?: string,
  timeoutMs = 600_000,
): Promise<KontextRun> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("kontext", [...args], {
      cwd,
      env: kontextEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin ?? "");
  });
}

/** Whether a checkout keeps kontext knowledge: `kontext init` ran there. */
export function hasStore(root: string): boolean {
  return NodeFS.existsSync(NodePath.join(root, ".ai", "kontext.toml"));
}

/** kontext's `captured inbox:<id>`. */
export function capturedId(stdout: string): string | null {
  return /captured inbox:(\S+)/.exec(stdout)?.[1] ?? null;
}

/** The inbox ids `kontext distill` captured, from its `→ inbox:<id>` lines. */
export function distilledIds(stdout: string): string[] {
  return [...stdout.matchAll(/→ inbox:(\S+)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Why `kontext distill` captured nothing: its model failed on the thread (its
 * `part <n>: <error>` note), or found nothing it does not have already.
 */
export function distillMiss(run: KontextRun): string {
  const failed =
    run.code === 0
      ? /· part \d+: (.+)$/m.exec(run.stdout)?.[1]
      : `${run.stderr}\n${run.stdout}`.trim().split("\n").at(-1) || `exit ${run.code}`;
  return failed === undefined
    ? "kontext's model found nothing new in it (it may be recorded already)"
    : `kontext's model did not run (${failed.trim()})`;
}

/** Where `kontext promote` wrote an entry: `<id> → <path> (staged)`. */
export function promotedPath(stdout: string): string | null {
  return /→ (\S+\.md)(?: \(staged\))?/.exec(stdout)?.[1] ?? null;
}

export interface DistilledEntry {
  readonly kind: string;
  readonly title: string;
  readonly paths: ReadonlyArray<string>;
  readonly body: string;
}

const ENTRY_HEADER = /^\[(decision|convention|learning|incident)\] (.+?)(?: {2}\((.+)\))?$/;

/** The entries `kontext distill --dry-run` printed: `[kind] title  (paths)`, then the body. */
export function dryRunEntries(stdout: string): DistilledEntry[] {
  const entries: Array<{ kind: string; title: string; paths: string[]; body: string[] }> = [];
  for (const line of stdout.split("\n")) {
    const header = ENTRY_HEADER.exec(line);
    if (header !== null) {
      entries.push({
        kind: header[1] ?? "learning",
        title: (header[2] ?? "").trim(),
        paths: (header[3] ?? "")
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path !== ""),
        body: [],
      });
      continue;
    }
    const current = entries.at(-1);
    if (current === undefined) continue;
    if (/^\d+ entr(y|ies) found/.test(line) || line.startsWith("## ")) {
      entries.push({ kind: "", title: "", paths: [], body: [] });
      continue;
    }
    current.body.push(line);
  }
  return entries
    .filter((entry) => entry.kind !== "" && entry.title !== "")
    .map((entry) => ({ ...entry, body: entry.body.join("\n").trim() }));
}

/** A title for knowledge from a line an agent wrote: its first sentence, short. */
export function titleOf(text: string): string {
  const sentence = /^(.+?[.!?])(\s|$)/.exec(text.trim())?.[1] ?? text.trim();
  const plain = sentence.replace(/[.!?]$/, "");
  return plain.length > 90 ? `${plain.slice(0, 89).trimEnd()}…` : plain;
}

export interface CandidateForKnowledge {
  readonly text: string;
  readonly finders: number;
  readonly sources: ReadonlyArray<{
    readonly text: string;
    readonly task?: string | undefined;
    readonly tagged: boolean;
  }>;
}

/**
 * What kontext distill reads to word a kept candidate as one entry: what the
 * agents wrote, where, and the shared context of the work it came from.
 */
export function keepThread(input: {
  readonly project: string;
  readonly candidate: CandidateForKnowledge;
  readonly where: (task: string | undefined) => string;
  readonly context: { readonly subject: string; readonly text: string } | undefined;
}): string {
  const { candidate } = input;
  const parts = [
    `People on the project ${input.project} reviewed what their coding agents found while working, and decided to keep this as the project's knowledge:`,
    candidate.text,
    [
      `What the agents wrote${candidate.finders > 1 ? ` (${candidate.finders} found it on their own, on different work)` : ""}:`,
      ...candidate.sources.map((source) => `- ${source.text} (${input.where(source.task)})`),
    ].join("\n"),
  ];
  if (input.context !== undefined && input.context.text.trim() !== "") {
    parts.push(
      `The shared context of ${input.context.subject}, where it was found (for reference):\n\n${input.context.text.trim().slice(0, 6000)}`,
    );
  }
  parts.push(
    "Record it as one entry for the team: the point, why it holds, what follows from it, and the files it concerns.",
  );
  return parts.join("\n\n");
}

/** What kontext distill reads to find what a task's shared context holds for the project. */
export function harvestThread(input: {
  readonly project: string;
  readonly subject: string;
  readonly text: string;
}): string {
  return [
    `This is the shared context an agent kept for ${input.subject} in the project ${input.project}: where the work stands, findings, decisions, what failed. Its agents wrote it while working.`,
    input.text.trim().slice(0, 20_000),
    "Name only what the project should keep beyond this work.",
  ].join("\n\n");
}

/**
 * What kontext distill reads to propose the project's guidance for its agents
 * on what to mark `[project]`: the lines people kept and dismissed, and what
 * they kept that no agent had marked.
 */
export function guidanceThread(input: {
  readonly project: string;
  readonly current: string | null;
  readonly kept: ReadonlyArray<string>;
  readonly dismissed: ReadonlyArray<string>;
  readonly missed: ReadonlyArray<string>;
}): string {
  const list = (title: string, lines: ReadonlyArray<string>) =>
    lines.length === 0 ? [] : [`${title}\n${lines.map((line) => `- ${line}`).join("\n")}`];
  return [
    `The coding agents on the project ${input.project} mark a line [project] when they think it holds beyond their task and the project should keep it. People reviewed those marks.`,
    ...list("Kept (marks the team wanted):", input.kept),
    ...list("Dismissed (marks the team did not want):", input.dismissed),
    ...list(
      "Kept although no agent marked it (several agents found it on their own):",
      input.missed,
    ),
    ...(input.current === null ? [] : [`The guidance the agents had:\n${input.current}`]),
    "Write this project's convention for its agents: when to mark a line [project] and when not to, in a few sentences, with this project's own examples.",
  ].join("\n\n");
}

/** A kontext entry's frontmatter fields and body. */
export function entryParts(markdown: string): {
  readonly fields: Readonly<Record<string, string>>;
  readonly body: string;
} {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(markdown);
  if (match === null) return { fields: {}, body: markdown };
  const fields: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const field = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (field?.[1] !== undefined) fields[field[1]] = (field[2] ?? "").replace(/^"|"$/g, "");
  }
  return { fields, body: (match[2] ?? "").trim() };
}

/**
 * The project's own guidance for its agents on what to mark `[project]`: the
 * newest convention in its knowledge tagged `peer-skill`, unless superseded.
 */
export async function projectGuidance(
  root: string,
): Promise<{ readonly id: string; readonly text: string } | null> {
  const dir = NodePath.join(root, ".ai", "conventions");
  const files = await NodeFSP.readdir(dir).catch(() => [] as string[]);
  let best: { id: string; text: string; date: string } | null = null;
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const text = await NodeFSP.readFile(NodePath.join(dir, file), "utf8").catch(() => "");
    const { fields, body } = entryParts(text);
    if (!/\bpeer-skill\b/.test(fields.tags ?? "") || fields.status === "superseded") continue;
    const date = fields.date ?? "";
    if (best === null || date >= best.date) {
      best = { id: fields.id ?? file.replace(/\.md$/, ""), text: body.slice(0, 1500), date };
    }
  }
  return best === null ? null : { id: best.id, text: best.text };
}

const KNOWLEDGE_KINDS = new Set(["decision", "convention", "learning", "incident"]);

/** The title of the entry `kontext search --json` found first in the knowledge itself, if any. */
export function relatedTitle(searchJson: string): string | null {
  try {
    const parsed = JSON.parse(searchJson) as {
      readonly hits?: ReadonlyArray<{ readonly kind?: unknown; readonly title?: unknown }>;
    };
    const hit = (parsed.hits ?? []).find(
      (candidate) => typeof candidate.kind === "string" && KNOWLEDGE_KINDS.has(candidate.kind),
    );
    return typeof hit?.title === "string" ? hit.title : null;
  } catch {
    return null;
  }
}

/** An entry's body when no model words it: what was found, and how the team came by it. */
export function directBody(
  candidate: CandidateForKnowledge,
  where: (task: string | undefined) => string,
): string {
  const places = [...new Set(candidate.sources.map((source) => where(source.task)))];
  return [
    candidate.text,
    `${candidate.finders > 1 ? `${candidate.finders} coding agents found it on their own` : "A coding agent marked it for the project"}, working on ${places.join(", ")}; the team kept it in Peer.`,
  ].join("\n\n");
}
