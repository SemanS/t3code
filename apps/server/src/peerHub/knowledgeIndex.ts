// @effect-diagnostics nodeBuiltinImport:off - reads a repository's reviewed knowledge files.
/**
 * knowledgeIndex — what a project's reviewed knowledge says it is, for the agents that work there.
 *
 * A project keeps what its people reviewed and committed (kontext, `.ai/` in its repository):
 * decisions, conventions, learnings, incidents, each with the paths it governs. An agent that does
 * not think of looking works against a decision it never saw, so Peer puts a small index of them
 * in the agent's context and lets the agent choose what it needs (`peer knowledge`). Peer does not
 * rank them against what the agent does: choosing is the model's work. The one thing it decides
 * itself is a fact, not a guess: an entry whose `paths` name a file the agent is about to change
 * says so, once, as a lock on a file says who has it.
 *
 * @module peerHub/knowledgeIndex
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { entryParts } from "./knowledge.ts";
import { block, plain, plural } from "./peerText.ts";

/** One entry of a project's knowledge. */
export interface KnowledgeEntry {
  readonly id: string;
  /** decision, convention, learning or incident. */
  readonly kind: string;
  readonly title: string;
  /** accepted, proposed, superseded; entries of the kinds without one have none. */
  readonly status: string | undefined;
  readonly date: string | undefined;
  readonly summary: string;
  readonly tags: ReadonlyArray<string>;
  /** The paths and globs it governs, relative to the repository. */
  readonly paths: ReadonlyArray<string>;
  /** Where the entry is, relative to the repository (`.ai/decisions/….md`). */
  readonly file: string;
  /** The start of its text. */
  readonly body: string;
}

/** An entry with the paths it governs compiled. */
export interface Known {
  readonly entry: KnowledgeEntry;
  readonly globs: ReadonlyArray<Glob>;
}

const KINDS = ["decision", "convention", "learning", "incident"] as const;

/** A frontmatter list: `[a, b]` or `a, b`. */
export function parseList(value: string | undefined): string[] {
  const inner = (value ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter((item) => item !== "");
}

/** How many paths and tags an entry may name, how long one may be, how much of its text is kept. */
const MAX_LISTED = 12;
const MAX_PATTERN = 200;
const MAX_BODY = 6000;

/**
 * The entry a markdown file holds, or undefined when it has no id and title. What reaches an agent
 * (kind, status, date, title, summary) is made plain and short here: the entry is text somebody
 * committed, and it is read by every agent that works where it applies.
 */
export function parseEntry(markdown: string, file: string): KnowledgeEntry | undefined {
  const { fields, body } = entryParts(markdown);
  const id = fields.id;
  const title = plain(fields.title ?? "", 200);
  if (id === undefined || !/^[\p{L}\p{N}_.:-]{1,160}$/u.test(id) || title === "") return undefined;
  const folder = file.split("/").at(-2) ?? "";
  const named = KINDS.find((candidate) => candidate === fields.kind);
  const kind = named ?? KINDS.find((candidate) => `${candidate}s` === folder) ?? "learning";
  const status = /^[a-z][a-z-]{0,19}$/i.test(fields.status ?? "") ? fields.status : undefined;
  const date = /^\d{4}-\d{2}-\d{2}/.exec(fields.date ?? "")?.[0];
  return {
    id,
    kind,
    title,
    status,
    date,
    summary: plain(fields.summary ?? "", 400),
    tags: parseList(fields.tags)
      .slice(0, MAX_LISTED)
      .map((tag) => plain(tag, 40)),
    paths: parseList(fields.paths)
      .slice(0, MAX_LISTED)
      .filter((pattern) => pattern.length <= MAX_PATTERN),
    file,
    body: block(body, MAX_BODY),
  };
}

export const known = (entry: KnowledgeEntry): Known => ({
  entry,
  globs: entry.paths.map(globOf),
});

// ---- the paths an entry governs ----

export interface Glob {
  readonly pattern: string;
  /** 3 a file in a directory, or a directory three deep or more; 2 two deep, or a file at the root (`README.md`: every change touches it); 1 one deep; 0 says nothing (`**`, `*.ts`). */
  readonly specificity: 0 | 1 | 2 | 3;
  readonly test: (path: string) => boolean;
}

const hasExtension = (name: string) => /\.[\p{L}\p{N}]+$/u.test(name);

/** What a path may be to be matched at all: a longer one is nobody's file. */
const MAX_PATH = 512;
const MAX_SEGMENTS = 16;

/** One segment against one pattern segment: `*` any run of characters, `?` one. Two pointers, no backtracking blow-up. */
function segmentMatches(pattern: string, text: string): boolean {
  let at = 0;
  let from = 0;
  let star = -1;
  let mark = 0;
  while (from < text.length) {
    const char = pattern[at];
    if (char === "?" || (char !== undefined && char !== "*" && char === text[from])) {
      at += 1;
      from += 1;
    } else if (char === "*") {
      star = at;
      at += 1;
      mark = from;
    } else if (star >= 0) {
      at = star + 1;
      mark += 1;
      from = mark;
    } else return false;
  }
  while (pattern[at] === "*") at += 1;
  return at === pattern.length;
}

/** A pattern's segments against a path's: `**` is any number of whole segments, none included. */
function segmentsMatch(
  pattern: ReadonlyArray<string>,
  path: ReadonlyArray<string>,
  i = 0,
  j = 0,
  dead = new Set<number>(),
): boolean {
  const key = i * 1000 + j;
  if (dead.has(key)) return false;
  const here = pattern[i];
  const ok =
    here === undefined
      ? j === path.length
      : here === "**"
        ? segmentsMatch(pattern, path, i + 1, j, dead) ||
          (j < path.length && segmentsMatch(pattern, path, i, j + 1, dead))
        : j < path.length &&
          segmentMatches(here, path[j] ?? "") &&
          segmentsMatch(pattern, path, i + 1, j + 1, dead);
  if (!ok) dead.add(key);
  return ok;
}

/**
 * A path pattern as a matcher: `**` crosses directories, `*` and `?` do not; a bare directory holds
 * its files. A pattern or a path longer than any real one matches nothing.
 */
export function globOf(pattern: string): Glob {
  const clean = pattern.trim().replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
  const segments = clean.split("/").filter((segment) => segment !== "");
  const wildcard = segments.findIndex((segment) => /[*?]/.test(segment));
  const literal = wildcard < 0 ? segments.length : wildcard;
  const specificity =
    wildcard < 0 && hasExtension(segments.at(-1) ?? "")
      ? segments.length === 1
        ? 2
        : 3
      : literal >= 3
        ? 3
        : literal === 2
          ? 2
          : literal === 1
            ? 1
            : 0;
  const absurd = clean.length > MAX_PATTERN || segments.length > MAX_SEGMENTS;
  // A directory without a wildcard holds everything under it.
  const holding =
    wildcard < 0 && !hasExtension(segments.at(-1) ?? "") ? [...segments, "**"] : segments;
  return {
    pattern,
    specificity: segments.length === 0 || absurd ? 0 : specificity,
    test: (path) => {
      if (absurd || path.length > MAX_PATH) return false;
      const parts = path
        .toLowerCase()
        .replace(/^\.\//, "")
        .split("/")
        .filter((part) => part !== "");
      return parts.length <= 64 && segmentsMatch(holding, parts);
    },
  };
}

/** The most specific glob of an entry that one of the paths falls under. */
export function governs(
  globs: ReadonlyArray<Glob>,
  paths: Iterable<string>,
): { readonly glob: Glob; readonly path: string } | undefined {
  let best: { glob: Glob; path: string } | undefined;
  for (const path of paths) {
    for (const glob of globs) {
      if (glob.specificity === 0 || !glob.test(path)) continue;
      if (best === undefined || glob.specificity > best.glob.specificity) best = { glob, path };
    }
  }
  return best;
}

// ---- what governs a file ----

/** An entry that names a file the agent changes, and the pattern and the file that say so. */
export interface Governing {
  readonly entry: KnowledgeEntry;
  readonly pattern: string;
  readonly path: string;
}

/**
 * The entries whose paths name a file the agent changes: a file, or a directory three deep or more
 * (a broad directory says nothing about one file in it). Superseded entries and those the agent was
 * told of already are left out. Newest first.
 */
export function governing(
  book: ReadonlyArray<Known>,
  files: Iterable<string>,
  told: ReadonlySet<string>,
): Governing[] {
  const paths = [...files];
  const found: Governing[] = [];
  for (const { entry, globs } of book) {
    if (entry.status === "superseded" || told.has(entry.id)) continue;
    const hit = governs(
      globs.filter((glob) => glob.specificity === 3),
      paths,
    );
    if (hit !== undefined) found.push({ entry, pattern: hit.glob.pattern, path: hit.path });
  }
  return found.toSorted((a, b) => (b.entry.date ?? "").localeCompare(a.entry.date ?? ""));
}

// ---- telling ----

const code = (text: string) => `\`${text}\``;

/** `decision (accepted, 2026-10-04)`: what kind it is and where it stands. */
function kindText(entry: KnowledgeEntry): string {
  const state = [entry.status, entry.date].filter((part) => part !== undefined).join(", ");
  return `${entry.kind}${state === "" ? "" : ` (${state})`}`;
}

/** How many entries of a kind Peer names at once when a file is governed. */
const GOVERNING_SHOWN = 3;

/** What to say when the files an agent changes are governed by entries: which, and how to read them. */
export function governingText(found: ReadonlyArray<Governing>, cli: string): string | null {
  if (found.length === 0) return null;
  const shown = found.slice(0, GOVERNING_SHOWN);
  return [
    `Peer · the project's \`.ai\` has ${shown.length === 1 ? "an entry that governs" : "entries that govern"} what you change (kept there by its people; check your change against ${shown.length === 1 ? "it" : "them"}, and if ${shown.length === 1 ? "it no longer holds" : "one no longer holds"}, say so to your person):`,
    ...shown.map(({ entry, pattern, path }) => {
      const summary = entry.summary === "" ? "" : ` — ${plain(entry.summary, 240)}`;
      return `- ${kindText(entry)} "${entry.title}"${summary} It governs ${code(plain(pattern, 120))}, and you change ${code(plain(path, 160))}. Read it: ${cli} knowledge ${entry.id}`;
    }),
  ].join("\n");
}

/** One entry in the index: what it is, what it governs, and the id that reads it. */
export function knowledgeLine(entry: KnowledgeEntry): string {
  const paths =
    entry.paths.length === 0
      ? ""
      : ` · governs ${entry.paths
          .slice(0, 3)
          .map((path) => plain(path, 80))
          .join(", ")}${entry.paths.length > 3 ? ", …" : ""}`;
  return `${kindText(entry)} ${entry.title}${paths} · ${entry.id}`;
}

/**
 * One entry as a start names it: what it is and what it says, and the files it governs; what the
 * agent reads on request (its id, its date, its summary) stays out. `peer knowledge <words>` finds
 * it by the words of its title.
 */
export function knowledgeTitleLine(entry: KnowledgeEntry): string {
  const proposed = entry.status === "proposed" ? " (proposed)" : "";
  const paths =
    entry.paths.length === 0
      ? ""
      : ` · governs ${entry.paths
          .slice(0, 2)
          .map((path) => plain(path, 60))
          .join(", ")}${entry.paths.length > 2 ? ", …" : ""}`;
  return `${entry.kind}${proposed}: ${entry.title}${paths}`;
}

/** The entries that stand, newest first. */
export function standing(book: ReadonlyArray<Known>): KnowledgeEntry[] {
  return book
    .map(({ entry }) => entry)
    .filter((entry) => entry.status !== "superseded")
    .toSorted((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.id.localeCompare(b.id));
}

/**
 * The index of a project's knowledge, newest first. A start names the entries by title (`titles`):
 * what is cheap to name and costs a command to read. `peer knowledge` lists them whole.
 */
export function knowledgeIndexText(
  book: ReadonlyArray<Known>,
  options: { readonly cli: string; readonly shown: number; readonly titles?: boolean },
): string | null {
  const entries = standing(book);
  if (entries.length === 0) return null;
  const { cli, shown } = options;
  const titles = options.titles === true;
  return [
    titles
      ? `Project knowledge, kept in \`.ai\` by its people (${plural(entries.length, "entry", "entries")}; \`${cli} knowledge <words>\` reads or searches them):`
      : `Project knowledge, kept in \`.ai\` by its people (${plural(entries.length, "entry", "entries")}; \`${cli} knowledge <id>\` reads one, \`${cli} knowledge <words>\` searches them):`,
    ...entries
      .slice(0, shown)
      .map((entry) => `- ${titles ? knowledgeTitleLine(entry) : knowledgeLine(entry)}`),
    ...(entries.length > shown
      ? [`(${entries.length - shown} more: \`${cli} knowledge <words>\` finds them)`]
      : []),
  ].join("\n");
}

/**
 * Text as it is compared when somebody searches: capitals and accents set aside, in any script.
 * Nothing about a language is known here; a word is whatever stands between spaces.
 */
const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The entries whose id starts with `query`, or else those that have every one of its words. */
export function searchKnowledge(book: ReadonlyArray<Known>, query: string): KnowledgeEntry[] {
  const wanted = fold(query.trim());
  if (wanted === "") return [];
  const exact = book.filter(({ entry }) => fold(entry.id) === wanted);
  if (exact.length > 0) return exact.map(({ entry }) => entry);
  const prefixed = book.filter(({ entry }) => fold(entry.id).startsWith(wanted));
  if (prefixed.length === 1) return prefixed.map(({ entry }) => entry);
  const asked = wanted.split(/\s+/).filter((word) => word !== "");
  // "superseded" asks for what stands no more; it is not a word the entries have.
  const withSuperseded = asked.includes("superseded");
  const words = asked.filter((word) => word !== "superseded");
  if (words.length === 0) return [];
  return book
    .map(({ entry }) => entry)
    .filter((entry) => withSuperseded || entry.status !== "superseded")
    .filter((entry) => {
      const text = fold(
        `${entry.id} ${entry.kind} ${entry.title} ${entry.summary} ${entry.tags.join(" ")} ${entry.paths.join(" ")}`,
      );
      return words.every((word) => text.includes(word));
    })
    .toSorted((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, 15);
}

/** An entry as `peer knowledge <id>` prints it. */
export function entryText(entry: KnowledgeEntry): string {
  return [
    `${kindText(entry)} · ${entry.title}`,
    `id ${entry.id} · ${entry.file}${entry.paths.length === 0 ? "" : ` · governs ${entry.paths.join(", ")}`}`,
    ...(entry.summary === "" ? [] : ["", entry.summary]),
    ...(entry.body === "" ? [] : ["", entry.body]),
  ].join("\n");
}

// ---- reading a repository's knowledge ----

const FOLDERS = ["decisions", "conventions", "learnings", "incidents"] as const;
const MAX_ENTRIES = 400;
const MAX_FILE_BYTES = 64 * 1024;

/** The entries of a repository's `.ai` store, in no order; none when it has no store. */
export async function readKnowledge(root: string): Promise<KnowledgeEntry[]> {
  const entries: KnowledgeEntry[] = [];
  for (const folder of FOLDERS) {
    const dir = NodePath.join(root, ".ai", folder);
    const names = await NodeFSP.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      // A name that is not a plain file name is not an entry Peer points an agent to.
      if (!/^[\p{L}\p{N}_.-]{1,160}\.md$/u.test(name) || entries.length >= MAX_ENTRIES) continue;
      const path = NodePath.join(dir, name);
      const stat = await NodeFSP.stat(path).catch(() => null);
      if (stat === null || !stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
      const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
      const entry = text === null ? undefined : parseEntry(text, `.ai/${folder}/${name}`);
      if (entry !== undefined) entries.push(entry);
    }
  }
  return entries;
}
