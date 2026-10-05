// @effect-diagnostics nodeBuiltinImport:off - reads a repository's reviewed knowledge files.
/**
 * knowledgeRouter — which of a project's reviewed knowledge bears on what an agent does now.
 *
 * A project keeps what its people reviewed and committed (kontext, `.ai/` in its repository):
 * decisions, conventions, learnings, incidents, each with the paths it governs. Agents can ask for
 * it (kontext's tools), but an agent that does not think of asking works against a decision it
 * never saw. So Peer tells it, when it matters: when the agent works on files an entry governs,
 * and when what it was asked is what an entry is about. The same deterministic matching as for
 * related work (`relevance`), plus the paths each entry names. It tells; the agent decides.
 *
 * @module peerHub/knowledgeRouter
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { entryParts } from "./knowledge.ts";
import {
  plain,
  profileOf,
  relate,
  SPEAK_POINTS,
  type Focus,
  type WorkProfile,
} from "./relevance.ts";

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

/** An entry with how its words weigh, ready to match. */
export interface KnowledgeProfile {
  readonly entry: KnowledgeEntry;
  readonly profile: WorkProfile;
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

/** How many paths and tags an entry may name, and how long one may be. */
const MAX_LISTED = 12;
const MAX_PATTERN = 200;

/**
 * The entry a markdown file holds, or undefined when it has no id and title. What reaches an agent
 * (kind, status, date, title, summary) is made plain and short here: the entry is text somebody
 * committed, and it is read by every agent that works where it applies.
 */
export function parseEntry(markdown: string, file: string): KnowledgeEntry | undefined {
  const { fields, body } = entryParts(markdown);
  const id = fields.id;
  const title = plain(fields.title ?? "", 200);
  if (id === undefined || !/^[\w.:-]{1,160}$/.test(id) || title === "") return undefined;
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
    body: body.slice(0, 1500),
  };
}

// ---- the paths an entry governs ----

export interface Glob {
  readonly pattern: string;
  /** 3 a file in a directory, or a directory three deep or more; 2 two deep, or a file at the root (`README.md`: every change touches it); 1 one deep; 0 says nothing (`**`, `*.ts`). */
  readonly specificity: 0 | 1 | 2 | 3;
  readonly test: (path: string) => boolean;
}

const hasExtension = (name: string) => /\.[A-Za-z0-9]+$/.test(name);

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

// ---- matching ----

/** What a path an entry governs is worth towards speaking: a file says it alone, a broad directory needs words too. */
const GOVERNS_POINTS: Readonly<Record<number, number>> = { 3: 3, 2: 1.5, 1: 0.5 };
/**
 * What an entry needs to speak with only the agent's words behind it, no path: the words of a file's
 * own name share a lot ("peer", "hub") with entries about a project that is all about them, so
 * words alone must say more than they do with a governed path.
 */
const WORDS_ONLY_POINTS = 3.5;

export function profileEntry(entry: KnowledgeEntry): KnowledgeProfile {
  const modified = entry.date === undefined ? Number.NaN : Date.parse(entry.date);
  return {
    entry,
    globs: entry.paths.map(globOf),
    profile: profileOf({
      entry: {
        scope: `kx:${entry.id}`,
        handle: entry.id,
        name: entry.title,
        agents: [],
        version: 1,
        gist: entry.summary === "" ? undefined : entry.summary,
      },
      labels: [entry.kind, ...entry.tags],
      files: [],
      findings: [],
      text: entry.body === "" ? undefined : entry.body,
      updatedAt: Number.isFinite(modified) ? modified : undefined,
      // Knowledge does not age out with a week of quiet: it is what the project keeps.
      active: true,
    }),
  };
}

export interface KnowledgeMatch {
  readonly entry: KnowledgeEntry;
  readonly points: number;
  /** 2 it governs files the agent works on; 1 it is about what the agent does. */
  readonly level: 1 | 2;
  readonly source: "paths" | "words";
  readonly why: string;
}

const code = (text: string) => `\`${text}\``;

/**
 * The entries that bear on a focus, the closest first: those that govern a file the agent works on
 * or names, those that share what it was asked. Superseded entries say nothing any more.
 */
export function matchKnowledge(
  focus: Focus,
  profiles: ReadonlyArray<KnowledgeProfile>,
  now: number,
): KnowledgeMatch[] {
  const live = profiles.filter((p) => p.entry.status !== "superseded");
  const related = new Map(
    relate(
      focus,
      live.map((p) => p.profile),
      now,
      0.5,
    ).map((r) => [r.work.input.entry.scope, r] as const),
  );
  // What the agent works on, and what its person named by path.
  const paths = [
    ...focus.files,
    ...[...focus.refs].filter((ref) => ref.includes("/") || /\.[a-z0-9]+$/.test(ref)),
  ];
  const matches: KnowledgeMatch[] = [];
  for (const { entry, globs } of live) {
    const words = related.get(`kx:${entry.id}`);
    const hit = governs(globs, paths);
    const points =
      (words?.points ?? 0) + (hit === undefined ? 0 : (GOVERNS_POINTS[hit.glob.specificity] ?? 0));
    if (points < (hit === undefined ? WORDS_ONLY_POINTS : SPEAK_POINTS)) continue;
    const reasons: string[] = [];
    if (hit !== undefined) {
      reasons.push(
        `it governs ${code(plain(hit.glob.pattern, 120))}, and you work on ${code(plain(hit.path, 160))}`,
      );
    }
    if (words !== undefined && words.words.length > 0) {
      reasons.push(
        `it shares ${words.words
          .slice(0, 4)
          .map((word) => `"${word}"`)
          .join(", ")} with what you do`,
      );
    }
    matches.push({
      entry,
      points,
      level: hit === undefined ? 1 : 2,
      source:
        hit !== undefined && (words === undefined || words.points < SPEAK_POINTS)
          ? "paths"
          : "words",
      why: reasons.join("; "),
    });
  }
  return matches.toSorted(
    (a, b) => b.points - a.points || (b.entry.date ?? "").localeCompare(a.entry.date ?? ""),
  );
}

/** How many entries one telling names, how often, and how many in an hour. */
export const KNOWLEDGE_SHOWN = 2;
export const KNOWLEDGE_GAP_MS = 20_000;
export const KNOWLEDGE_PER_HOUR = 6;

/** What to tell an agent about the entries it has not heard of; null when there is nothing new. */
export function knowledgeNews(input: {
  readonly matches: ReadonlyArray<KnowledgeMatch>;
  readonly told: ReadonlySet<string>;
}): { readonly text: string; readonly told: ReadonlyArray<KnowledgeMatch> } | null {
  const fresh = input.matches
    .filter((match) => !input.told.has(match.entry.id))
    .slice(0, KNOWLEDGE_SHOWN);
  if (fresh.length === 0) return null;
  const lines = fresh.map(({ entry, why }) => {
    const state = [entry.status, entry.date].filter((part) => part !== undefined).join(", ");
    const summary = plain(entry.summary, 240);
    return `- ${entry.kind}${state === "" ? "" : ` (${state})`} "${plain(entry.title, 160)}"${summary === "" ? "" : ` — ${summary}`} Why now: ${why}. Read it in ${entry.file}.`;
  });
  return {
    text: [
      "Peer · what this project already knows (kept in its `.ai` by its people; check your change against it, and if it no longer holds, say so to your person):",
      ...lines,
    ].join("\n"),
    told: fresh,
  };
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
      if (!/^[\w.-]{1,160}\.md$/.test(name) || entries.length >= MAX_ENTRIES) continue;
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
