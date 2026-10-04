/**
 * coordination — agents on the same project staying out of each other's way
 * without reading each other's conversations.
 *
 * Every agent session reports which files of the project's repository it
 * changed. The hub finds pairs that share a file (overlaps) and keeps one
 * short thread of notes per overlap. An agent hears about another only when
 * it is about to touch something that agent changed, and then only a few
 * lines: who, what they work on, their latest note, and how to answer. It
 * reads more (`peer status`) or writes a note (`peer note`) when it decides
 * to. People see the same overlaps and notes in Peer.
 *
 * This module is the pure part: what a tool call edits, what to tell an
 * agent and when, and the hook settings Claude Code runs.
 *
 * @module peerHub/coordination
 */
import type { PeerCoordinationPolicy } from "@t3tools/contracts";

import type { HubCoordSession, HubFinding, HubOverlap } from "./hubApi.ts";

/** Claude Code tools that change a file. */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
]);

/** The file an editing tool call changes, as the agent named it. */
export function editedFile(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string" || !EDIT_TOOLS.has(toolName)) return null;
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const input = toolInput as Record<string, unknown>;
  const path = input.file_path ?? input.notebook_path;
  return typeof path === "string" && path !== "" ? path : null;
}

/** A path relative to the repository at `root`, or null when it lies outside. */
export function repositoryPath(root: string, path: string): string | null {
  const base = root.endsWith("/") ? root : `${root}/`;
  if (!path.startsWith(base)) return null;
  const relative = path.slice(base.length);
  return relative === "" || relative.split("/").includes("..") ? null : relative;
}

/** Two paths name the same thing, or one is a claimed directory holding the other. */
export function touches(a: string, b: string): boolean {
  return a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
}

/** What a session changed or claimed. */
function pathsOf(session: HubCoordSession): ReadonlyArray<string> {
  return [...session.files, ...session.claims];
}

/** The overlap's short id agents type: enough of it to be unique in practice. */
export const shortId = (overlapId: string) => overlapId.slice(0, 6);

/** What one session remembers about what it was told, so nothing is said twice. */
export interface SessionMemory {
  /** Overlaps (by id, or `with:<session>` before the hub named one) it answered or its person approved. */
  readonly acknowledged: Set<string>;
  /** Notes it was shown. */
  readonly seenNotes: Set<string>;
  /** Overlaps it was told about. */
  readonly announced: Set<string>;
}

export const emptyMemory = (): SessionMemory => ({
  acknowledged: new Set(),
  seenNotes: new Set(),
  announced: new Set(),
});

export interface CoordinationView {
  readonly sessions: ReadonlyArray<HubCoordSession>;
  readonly overlaps: ReadonlyArray<HubOverlap>;
}

/** The person behind an email, as the workspace names them. */
export type NameOf = (email: string) => string;

const TRUNKS: ReadonlySet<string> = new Set(["main", "master", "trunk", "develop"]);

/** How a session is described to another agent: whose, doing what, where. */
export function describe(session: HubCoordSession, nameOf: NameOf): string {
  // Everyone is on the trunk most of the time; only another branch says something.
  const branch =
    session.branch === undefined || TRUNKS.has(session.branch)
      ? undefined
      : `branch ${session.branch}`;
  const details = [session.agent, `"${session.label}"`, session.task, branch].filter(
    (part): part is string => part !== undefined && part !== "",
  );
  return `${nameOf(session.email)}'s agent (${details.join(", ")})`;
}

/**
 * Where another agent works, said once: on another computer its edits reach this one only
 * through git, which an agent cannot tell from the files it sees.
 */
export function whereFrom(me: HubCoordSession, other: HubCoordSession): string {
  return other.environment === me.environment
    ? "on this computer"
    : "on another computer, so its edits reach you only through git";
}

const between = (overlap: HubOverlap, me: string, other: string) =>
  overlap.sessions.includes(me) && overlap.sessions.includes(other);

/** The newest note on an overlap written by anyone but `me`. */
function latestOtherNote(overlap: HubOverlap | undefined, me: string) {
  return overlap?.notes.findLast((note) => note.session !== me);
}

export interface EditAnswer {
  readonly decision?: "deny" | "ask";
  /** Why, for the agent (deny) or the person (ask). */
  readonly reason?: string;
  /** A heads-up the agent reads next to the tool result. */
  readonly context?: string;
  /** One per contested file and other session: what an answer (note, approval) settles. */
  readonly keys: ReadonlyArray<string>;
  /** The overlaps the hub already knows that this answer was about. */
  readonly overlaps: ReadonlyArray<string>;
  /** The sessions the file is contested with. */
  readonly with: ReadonlyArray<string>;
}

/** What settles a contest over one file with one other session, before or after the hub named it. */
export const contestKey = (overlapOrSession: string, file: string) => `${overlapOrSession}#${file}`;

/** An overlap is news again when files join it. */
export const announcementKey = (overlap: HubOverlap) => `${overlap.id}:${overlap.files.length}`;

/**
 * What to tell a session about to change `file`: nothing when nobody else at
 * work on the project changed or claimed it; otherwise, by policy, a
 * heads-up, a request to write the other agent a note first, or a question
 * for its person — once per overlap, until something new happens.
 */
export function decideEdit(input: {
  readonly policy: PeerCoordinationPolicy;
  readonly me: HubCoordSession;
  readonly file: string;
  readonly view: CoordinationView;
  readonly memory: SessionMemory;
  readonly nameOf: NameOf;
  readonly cli: string;
}): EditAnswer {
  const { me, file, view, memory } = input;
  const others = view.sessions.filter(
    (session) =>
      session.id !== me.id &&
      session.project === me.project &&
      pathsOf(session).some((path) => touches(path, file)),
  );
  const contests = others.flatMap((other) => {
    const overlap = view.overlaps.find(
      (o) => o.project === me.project && between(o, me.id, other.id),
    );
    // An agreement that covered this file settles it.
    if (overlap?.state === "resolved" && overlap.resolvedFiles?.includes(file)) return [];
    return [{ other, overlap, key: contestKey(overlap?.id ?? `with:${other.id}`, file) }];
  });
  if (contests.length === 0) return { keys: [], overlaps: [], with: [] };
  const fresh = contests.filter((contest) => !memory.acknowledged.has(contest.key));
  if (fresh.length === 0) return { keys: [], overlaps: [], with: contests.map((c) => c.other.id) };

  const lines = fresh.map(({ other, overlap }) => {
    const note = latestOtherNote(overlap, me.id);
    const said = note === undefined ? "" : ` Their note: "${note.text}"`;
    const intent = other.intent === undefined ? "" : ` They said they are: ${other.intent}.`;
    const id = overlap === undefined ? "" : ` [overlap ${shortId(overlap.id)}]`;
    return `${describe(other, input.nameOf)}, working ${whereFrom(me, other)}, also changed ${file}.${intent}${said}${id}`;
  });
  const heading = `Peer: ${lines.join(" ")}`;
  const keys = fresh.map((contest) => contest.key);
  const overlaps = fresh.flatMap((contest) =>
    contest.overlap === undefined ? [] : [contest.overlap.id],
  );
  const contested = contests.map((c) => c.other.id);
  switch (input.policy) {
    case "notify":
      return {
        context: `${heading} If your change interacts with theirs, tell them: ${input.cli} note "<what you change and why>".`,
        keys,
        overlaps,
        with: contested,
      };
    case "ask":
      return { decision: "ask", reason: heading, keys, overlaps, with: contested };
    case "coordinate":
      return {
        decision: "deny",
        reason: `${heading} Peer coordinates the agents on this project: before editing ${file}, tell them your plan with ${input.cli} note "<your plan for ${file}>" — it only posts a short note both agents and their people see, and changes no files. Then edit if the plans fit; if they clash, propose a split in the note and check replies with ${input.cli} status.`,
        keys,
        overlaps,
        with: contested,
      };
  }
}

/**
 * What happened on this session's overlaps since it last heard: overlaps it
 * was not told about and notes others wrote. One short block, or null.
 */
export function newsFor(input: {
  readonly me: HubCoordSession;
  readonly view: CoordinationView;
  readonly memory: SessionMemory;
  readonly nameOf: NameOf;
  readonly cli: string;
}): { readonly text: string; readonly announced: string[]; readonly seen: string[] } | null {
  const { me, view, memory, nameOf } = input;
  const blocks: string[] = [];
  const announced: string[] = [];
  const seen: string[] = [];
  for (const overlap of view.overlaps) {
    if (!overlap.sessions.includes(me.id)) continue;
    const otherId = overlap.sessions.find((id) => id !== me.id);
    const other = view.sessions.find((session) => session.id === otherId);
    const fresh = overlap.state === "open" && !memory.announced.has(announcementKey(overlap));
    const notes = overlap.notes.filter(
      (note) => note.session !== me.id && !memory.seenNotes.has(note.id),
    );
    if (!fresh && notes.length === 0) continue;
    if (fresh) announced.push(announcementKey(overlap));
    seen.push(...notes.map((note) => note.id));
    const who =
      other === undefined
        ? "another agent"
        : fresh
          ? `${describe(other, nameOf)}, working ${whereFrom(me, other)},`
          : describe(other, nameOf);
    const said = notes.map((note) => {
      const author =
        note.session === undefined
          ? `${nameOf(note.email)} (person)`
          : `${nameOf(note.email)}'s agent`;
      return `${author}: "${note.text}"`;
    });
    // Whether they changed the shared files already or only said they are about to.
    const changed = other?.files.some((file) => overlap.files.includes(file)) ?? false;
    const state = fresh
      ? changed
        ? " (they changed it too)"
        : " (they are about to change it)"
      : "";
    blocks.push(
      `Overlap ${shortId(overlap.id)} with ${who} on ${overlap.files.join(", ")}${state}${said.length === 0 ? "." : ` — ${said.join(" ")}`}`,
    );
  }
  if (blocks.length === 0) return null;
  // Once notes go back and forth, say how the conversation ends.
  const settle =
    seen.length > 0 ? ` Once you agree, close it: ${input.cli} resolve "<agreement>".` : "";
  return {
    text: `Peer: ${blocks.join(" ")} Reply if it concerns your work: ${input.cli} note "<text>"; details: ${input.cli} status.${settle}`,
    announced,
    seen,
  };
}

/** What `peer status` prints: the project's agents at work and this session's overlaps. */
export function statusText(input: {
  readonly me: HubCoordSession;
  readonly view: CoordinationView;
  readonly nameOf: NameOf;
  readonly cli: string;
}): string {
  const { me, view, nameOf } = input;
  const lines = [`Peer · project ${me.project} · you: ${describe(me, nameOf)}`];
  const others = view.sessions.filter((s) => s.project === me.project && s.id !== me.id);
  lines.push(
    others.length === 0
      ? "No other agents at work on this project."
      : `Also at work: ${others
          .map((s) => `${describe(s, nameOf)} — ${s.status}, ${s.files.length} file(s) changed`)
          .join("; ")}`,
  );
  const mine = view.overlaps.filter((o) => o.sessions.includes(me.id));
  for (const overlap of mine) {
    lines.push(
      `Overlap ${shortId(overlap.id)} (${overlap.state}) on ${overlap.files.join(", ")}${overlap.resolution === undefined ? "" : ` — agreed: ${overlap.resolution}`}`,
    );
    for (const note of overlap.notes.slice(-5)) {
      const author =
        note.session === me.id
          ? "you"
          : note.session === undefined
            ? `${nameOf(note.email)} (person)`
            : `${nameOf(note.email)}'s agent`;
      lines.push(`  ${author}: "${note.text}"`);
    }
  }
  lines.push(
    `Commands: ${input.cli} note "<text>" · ${input.cli} resolve "<agreement>" · ${input.cli} claim <path>... [--intent "<why>"] · ${input.cli} release`,
  );
  return lines.join("\n");
}

/** A command that runs Peer's CLI and nothing else, so it may run without asking. */
export function isPlainCliCall(command: string, cli: string): boolean {
  // Agents like to trim what a command prints (`2>&1 | head -30`); that much may follow.
  const trimmed = command.trim().replace(/\s*2>&1\s*(\|\s*(head|tail)(\s+-n)?\s+-?\d+)?$/, "");
  if (!trimmed.startsWith(`${cli} `) && trimmed !== cli) return false;
  const rest = trimmed.slice(cli.length);
  // Words, and quoted text without anything a shell would expand or chain.
  return /^(\s+([A-Za-z0-9._/:@+=,-]+|'[^'\n]*'|"[^"$`\\\n]*"))*\s*$/.test(rest);
}

/** Whether a shell command runs `peer` anywhere in it, plain or not. */
export function mentionsCli(command: string, cli: string): boolean {
  const escaped = cli.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return new RegExp(`(^|[;&|(]\\s*|\\s)${escaped}(\\s|$)`).test(command.trim());
}

/** The scripts Peer writes for agents: the hook Claude Code runs, its wake-up wait, and `peer`. */
export function coordinationScripts(
  socket: string,
  binDir: string,
): {
  readonly hook: string;
  readonly wait: string;
  readonly peer: string;
} {
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  const quoted = quote(socket);
  const headers = `-H "X-Herdr-Pane: \${HERDR_PANE_ID:-}" -H "X-Peer-Session: \${PEER_SESSION:-}"`;
  return {
    hook: `#!/bin/sh
# Peer coordination: hands a Claude Code hook event to Peer and prints its answer.
# Prints nothing and lets the agent go on when Peer is not running.
input=$(cat)
# A session starting (the only time Claude Code gives hooks this file): \`peer\` goes on its
# PATH, and the session knows its id, so \`peer\` works in any command and says who calls.
if [ -n "\${CLAUDE_ENV_FILE:-}" ]; then
  sid=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)
  printf 'export PATH=%s:"$PATH"\\n' ${quote(quote(binDir))} >> "$CLAUDE_ENV_FILE"
  [ -n "$sid" ] && printf 'export PEER_SESSION=%s\\n' "$sid" >> "$CLAUDE_ENV_FILE"
fi
printf '%s' "$input" | curl -sf --max-time 4 --unix-socket ${quoted} ${headers} -H 'Content-Type: application/json' --data-binary @- http://peer/hook 2>/dev/null
exit 0
`,
    wait: `#!/bin/sh
# Peer coordination: while the agent is idle, waits for a note from another agent and wakes it.
out=$(curl -sf --max-time 1800 --unix-socket ${quoted} ${headers} -H 'Content-Type: application/json' --data-binary @- http://peer/hook/wait 2>/dev/null) || exit 0
[ -n "$out" ] || exit 0
printf '%s\\n' "$out" >&2
exit 2
`,
    peer: `#!/bin/sh
# peer: talk to the other agents on this project through Peer. "peer help" lists the commands.
cmd="\${1:-status}"
[ $# -gt 0 ] && shift
for arg in "$@"; do printf '%s\\0' "$arg"; done | curl -sS --max-time 15 --unix-socket ${quoted} ${headers} -H "X-Peer-Cwd: $PWD" --data-binary @- "http://peer/cli/$cmd" || { echo "peer: Peer is not running." >&2; exit 1; }
`,
  };
}

interface HookEntry {
  readonly [field: string]: unknown;
  readonly command?: unknown;
}
interface HookGroup {
  readonly matcher?: unknown;
  readonly hooks?: ReadonlyArray<HookEntry>;
}
type Settings = Record<string, unknown> & { hooks?: Record<string, ReadonlyArray<HookGroup>> };

/** The hook groups Claude Code needs for coordination, pointing at Peer's scripts. */
export function claudeHookGroups(scripts: {
  readonly hook: string;
  readonly wait: string;
}): Record<string, ReadonlyArray<HookGroup>> {
  const hook = { type: "command", command: scripts.hook, timeout: 5 };
  return {
    SessionStart: [{ hooks: [hook] }],
    UserPromptSubmit: [{ hooks: [hook] }],
    PreToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit|Bash", hooks: [hook] }],
    PostToolUse: [{ matcher: "Edit|Write|MultiEdit|NotebookEdit", hooks: [hook] }],
    Stop: [
      {
        hooks: [
          hook,
          {
            type: "command",
            command: scripts.wait,
            async: true,
            asyncRewake: true,
            timeout: 1800,
          },
        ],
      },
    ],
    SessionEnd: [{ hooks: [{ ...hook, timeout: 2 }] }],
  };
}

const isPeerEntry = (entry: HookEntry, marker: string) =>
  typeof entry.command === "string" && entry.command.includes(marker);

/**
 * Claude Code settings with Peer's coordination hooks added (`install`) or
 * taken out, leaving every other hook as it was. `marker` names Peer's
 * scripts' directory.
 */
export function withClaudeHooks(
  settings: Settings,
  groups: Record<string, ReadonlyArray<HookGroup>>,
  marker: string,
  install: boolean,
): Settings {
  const hooks: Record<string, ReadonlyArray<HookGroup>> = {};
  for (const [event, list] of Object.entries(settings.hooks ?? {})) {
    const kept = list
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((entry) => !isPeerEntry(entry, marker)),
      }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  if (install) {
    for (const [event, list] of Object.entries(groups)) {
      hooks[event] = [...(hooks[event] ?? []), ...list];
    }
  }
  const { hooks: _previous, ...rest } = settings;
  return Object.keys(hooks).length === 0 ? rest : { ...rest, hooks };
}

/** Whether Claude Code settings already run Peer's hooks. */
export function hasClaudeHooks(settings: Settings, marker: string): boolean {
  return Object.values(settings.hooks ?? {}).some((list) =>
    list.some((group) => (group.hooks ?? []).some((entry) => isPeerEntry(entry, marker))),
  );
}

// ---- working context (experimental, after Context Language Models, arXiv:2609.37725) ----
//
// Each agent session keeps a working context file it curates itself. After a compaction or a
// resume Peer puts it back into the session, so what carries over is what the agent chose, not
// the harness's summary. Its "For the team" lines are all that leaves the computer: they become
// the project's findings, which other agents hear when they concern their task or their files.
// The wording below is the experiment's skill; tune it from logged runs, not by guessing.

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How an agent keeps its working context, said at the start of each session. */
export function contextSkill(path: string): string {
  return [
    `Peer keeps your working context in ${path}. It is yours: keep it short (under about 60 lines) and current, and edit it with your usual tools whenever your goal, plan, findings or blockers change. It is not a log.`,
    "Keep: the goal; what you are doing now; findings with exact file names and symbols; decisions and why; hypotheses marked unconfirmed; approaches that failed; what you need from whom. Drop what no longer matters and sum up finished work in a line. After a compaction or a resume, this file is what you get back.",
    `Under "## For the team" keep 1-5 bullet lines (- ...) your teammates' agents should know: findings that hold beyond your session, what you change and will not change. Peer shares only those lines with agents on the same project. Never put secrets there.`,
  ].join("\n");
}

/** A new session's working context, before its agent makes it its own. */
export function contextTemplate(goal: string, task: string | undefined): string {
  return [
    "# Working context",
    "",
    `Goal: ${goal}${task === undefined ? "" : ` (${task})`}`,
    "",
    "## Now",
    "",
    "## Findings",
    "",
    "## Tried and failed",
    "",
    "## For the team",
    "",
  ].join("\n");
}

/** Whether the agent has written anything into its working context beyond Peer's template. */
export function contextWritten(markdown: string): boolean {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line !== "" && !line.startsWith("#") && !line.startsWith("Goal:"));
}

/** The bullet lines under "## For the team": what the agent shares with its project. */
export function teamLines(markdown: string): string[] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{2,3}\s+for the team\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line)?.[1]?.trim();
    if (bullet === undefined || bullet.startsWith("<!--") || found.includes(bullet)) continue;
    found.push(cut(bullet, 300));
    if (found.length === 5) break;
  }
  return found;
}

export interface ContextHolder {
  readonly id: string;
  readonly project: string;
  readonly task: string | undefined;
  readonly files: ReadonlyArray<string>;
  readonly claims: ReadonlyArray<string>;
}

function names(finding: HubFinding, paths: ReadonlyArray<string>): boolean {
  return paths.some((path) => {
    const clean = path.replace(/\/$/, "");
    const base = clean.split("/").at(-1) ?? clean;
    return (
      finding.text.includes(clean) ||
      (base.includes(".") && base.length >= 6 && finding.text.includes(base))
    );
  });
}

/**
 * What other agents found that this one should hear now: findings on its task,
 * or naming a file it changed or is about to change. Each is heard once.
 */
export function teamNews(input: {
  readonly me: ContextHolder;
  readonly findings: ReadonlyArray<HubFinding>;
  readonly heard: ReadonlySet<string>;
  readonly nameOf: (email: string) => string;
  readonly taskName: (task: string) => string;
}): { readonly text: string; readonly ids: ReadonlyArray<string> } | null {
  const { me } = input;
  const relevant = input.findings
    .filter(
      (finding) =>
        finding.session !== me.id &&
        finding.project === me.project &&
        !input.heard.has(finding.id) &&
        ((me.task !== undefined && finding.task === me.task) ||
          names(finding, [...me.files, ...me.claims])),
    )
    .slice(0, 5);
  if (relevant.length === 0) return null;
  return {
    text: [
      `Peer · your team's agents found${me.task === undefined ? "" : ` on ${input.taskName(me.task)}`}:`,
      ...relevant.map((finding) => `- ${input.nameOf(finding.email)}'s agent: ${finding.text}`),
    ].join("\n"),
    ids: relevant.map((finding) => finding.id),
  };
}

/**
 * What a session hears when it starts, resumes or comes back from a compaction:
 * how to keep its working context, the context itself when it had one, and what
 * the team's agents found on its task (first) and its project.
 */
export function startContext(input: {
  readonly path: string;
  readonly saved: string | undefined;
  readonly me: ContextHolder;
  readonly findings: ReadonlyArray<HubFinding>;
  readonly nameOf: (email: string) => string;
  readonly taskName: (task: string) => string;
}): { readonly text: string; readonly ids: ReadonlyArray<string> } {
  const { me } = input;
  const team = input.findings
    .filter((finding) => finding.session !== me.id && finding.project === me.project)
    .toSorted(
      (a, b) =>
        Number(b.task !== undefined && b.task === me.task) -
        Number(a.task !== undefined && a.task === me.task),
    )
    .slice(0, 8);
  const parts = [contextSkill(input.path)];
  if (input.saved !== undefined && input.saved.trim() !== "") {
    parts.push(`Your working context as you left it:\n\n${cut(input.saved.trim(), 8_000)}`);
  }
  if (team.length > 0) {
    parts.push(
      [
        "What your team's agents found on this project (newest first; check before relying on it):",
        ...team.map(
          (finding) =>
            `- ${input.nameOf(finding.email)}'s agent${finding.task !== undefined && finding.task !== me.task ? ` (${input.taskName(finding.task)})` : ""}: ${finding.text}`,
        ),
      ].join("\n"),
    );
  }
  return { text: parts.join("\n\n"), ids: team.map((finding) => finding.id) };
}

/** The task a key names in a branch or label, when exactly one task's key appears as a whole token. */
export function taskNamed(
  tasks: ReadonlyArray<{ readonly id: string; readonly key?: string | undefined }>,
  texts: ReadonlyArray<string | undefined>,
): string | undefined {
  const haystacks = texts
    .filter((t): t is string => t !== undefined && t !== "")
    .map((t) => t.toLowerCase());
  const named = tasks.filter((task) => {
    if (task.key === undefined) return false;
    const key = task.key.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^a-z0-9])${key}($|[^a-z0-9])`);
    return haystacks.some((text) => pattern.test(text));
  });
  return named.length === 1 ? named[0]?.id : undefined;
}

/** Claude Code permission rules that let agents read and edit their working contexts, unasked. */
export function withContextAccess(settings: Settings, dir: string, install: boolean): Settings {
  const absolute = `/${dir.replace(/^\/+/, "")}`;
  const ours = [`Read(/${absolute}/**)`, `Edit(/${absolute}/**)`];
  const permissions = (settings.permissions ?? {}) as Record<string, unknown>;
  const allow = Array.isArray(permissions.allow)
    ? (permissions.allow as unknown[]).filter((rule) => !ours.includes(String(rule)))
    : [];
  const next = install ? [...allow, ...ours] : allow;
  const { allow: _previous, ...restPermissions } = permissions;
  const merged = next.length > 0 ? { ...restPermissions, allow: next } : restPermissions;
  const { permissions: _old, ...rest } = settings;
  return Object.keys(merged).length > 0 ? { ...rest, permissions: merged } : rest;
}

/** Whether Claude Code settings already let agents read and edit their working contexts. */
export function hasContextAccess(settings: Settings, dir: string): boolean {
  const absolute = `/${dir.replace(/^\/+/, "")}`;
  const allow = (settings.permissions as { allow?: unknown } | undefined)?.allow;
  return (
    Array.isArray(allow) &&
    allow.includes(`Read(/${absolute}/**)`) &&
    allow.includes(`Edit(/${absolute}/**)`)
  );
}
