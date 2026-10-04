// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - reads the transcripts Claude Code keeps on this computer, line by line.
/**
 * agentTranscript — what a Claude Code session has done, read from the
 * transcript it keeps (`<config>/projects/<project>/<session>.jsonl`): the
 * person's prompts, the agent's words and the tools it used. Peer reads it
 * only on the computer the session runs on, to show the session in its agent
 * view.
 *
 * @module peerHub/agentTranscript
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { PeerAgentEntry } from "@t3tools/contracts";

/** Claude Code's configuration directory: CLAUDE_CONFIG_DIR, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude");
}

/**
 * A Claude Code session's transcript: the file the session named, when it
 * exists, else `<session id>.jsonl` in one of Claude Code's project folders.
 */
export async function findClaudeTranscript(
  session: { readonly id: string | undefined; readonly path: string | undefined },
  configDir: string = claudeConfigDir(),
): Promise<string | null> {
  if (session.path !== undefined && NodeFS.existsSync(session.path)) return session.path;
  if (session.id === undefined || !/^[A-Za-z0-9-]{8,80}$/.test(session.id)) return null;
  const projects = NodePath.join(configDir, "projects");
  const folders = await NodeFSP.readdir(projects).catch(() => [] as string[]);
  for (const folder of folders) {
    const candidate = NodePath.join(projects, folder, `${session.id}.jsonl`);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

/** The last `maxBytes` of a transcript as whole lines; a long session's start is not needed. */
export async function readTranscriptTail(path: string, maxBytes = 512 * 1024): Promise<string[]> {
  const file = await NodeFSP.open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    // Reading from the middle cuts the first line.
    if (start > 0) lines.shift();
    return lines.filter((line) => line.trim() !== "");
  } finally {
    await file.close();
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function relative(path: unknown, cwd: string | undefined): string {
  if (typeof path !== "string") return "";
  return cwd !== undefined && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

/** A tool call in a few words, the way a person would say what the agent did. */
export function toolSummary(name: string, input: unknown, cwd?: string): string {
  const field = (key: string) => {
    const value = (input as Record<string, unknown> | null)?.[key];
    return typeof value === "string" ? value : "";
  };
  switch (name) {
    case "Read":
      return `Read ${relative(field("file_path"), cwd)}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${relative(field("file_path"), cwd)}`;
    case "Write":
      return `Write ${relative(field("file_path"), cwd)}`;
    case "NotebookEdit":
      return `Edit ${relative(field("notebook_path"), cwd)}`;
    case "Bash":
      return `$ ${clip(lines(field("command"))[0] ?? "", 200)}`;
    case "Grep":
      return `Search ${clip(field("pattern"), 120)}`;
    case "Glob":
      return `Find ${clip(field("pattern"), 120)}`;
    case "WebFetch":
      return `Fetch ${clip(field("url"), 160)}`;
    case "WebSearch":
      return `Search the web for ${clip(field("query"), 120)}`;
    case "Task":
    case "Agent":
      return `Agent: ${clip(field("description"), 120)}`;
    case "TodoWrite":
      return "Update the plan";
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
      return mcp === null ? name : `${mcp[1]} · ${mcp[2]}`;
    }
  }
}

/** A tool's result in a line: the end of a command's output, the start of anything else. */
function resultLine(name: string, content: unknown): string | undefined {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              typeof part === "object" && part !== null && typeof part.text === "string"
                ? part.text
                : "",
            )
            .join("\n")
        : "";
  const shown = lines(text);
  const line = name === "Bash" ? shown.at(-1) : shown[0];
  return line === undefined ? undefined : clip(line, 200);
}

/** What a person typed, without the reminders and wrappers Claude Code adds around it. */
function promptText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const command = /<command-name>([^<]+)<\/command-name>/.exec(raw);
  if (command !== null) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(raw)?.[1]?.trim();
    return [command[1]?.trim(), args].filter(Boolean).join(" ");
  }
  if (/^\s*<(local-command-|bash-|system-reminder)/.test(raw) || raw.startsWith("Caveat:")) {
    return null;
  }
  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return text === "" ? null : clip(text, 2_000);
}

/**
 * A transcript's lines as the steps a person follows: their prompts, the
 * agent's words, and each tool it used with the gist of what came back.
 * Thinking, subagents' own transcripts and Claude Code's bookkeeping are left
 * out. Newest last, at most `limit`.
 */
export function transcriptEntries(
  transcript: ReadonlyArray<string>,
  options: { readonly limit?: number; readonly cwd?: string } = {},
): PeerAgentEntry[] {
  const entries: PeerAgentEntry[] = [];
  const tools = new Map<string, number>();
  for (const [at, line] of transcript.entries()) {
    let record: {
      type?: unknown;
      uuid?: unknown;
      isSidechain?: unknown;
      isMeta?: unknown;
      message?: { content?: unknown };
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.isSidechain === true || record.isMeta === true) continue;
    // Stable across reads, so a view that scrolls keeps its rows.
    const idOf = (block: number) =>
      `${typeof record.uuid === "string" ? record.uuid : `line-${at}`}:${block}`;
    const content = record.message?.content;
    if (record.type === "user") {
      if (!Array.isArray(content)) {
        const text = promptText(content);
        if (text !== null) entries.push({ id: idOf(0), kind: "prompt", text });
        continue;
      }
      for (const [index, block] of content.entries()) {
        if (block?.type === "tool_result") {
          const at = tools.get(block.tool_use_id);
          const entry = at === undefined ? undefined : entries[at];
          if (at === undefined || entry?.kind !== "tool") continue;
          const result = resultLine(entry.name, block.content);
          entries[at] = {
            ...entry,
            failed: block.is_error === true,
            ...(result === undefined ? {} : { result }),
          };
        } else if (block?.type === "text") {
          const text = promptText(block.text);
          if (text !== null) entries.push({ id: idOf(index), kind: "prompt", text });
        }
      }
    } else if (record.type === "assistant" && Array.isArray(content)) {
      for (const [index, block] of content.entries()) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
          entries.push({ id: idOf(index), kind: "text", text: clip(block.text.trim(), 4_000) });
        } else if (block?.type === "tool_use" && typeof block.name === "string") {
          if (typeof block.id === "string") tools.set(block.id, entries.length);
          entries.push({
            id: idOf(index),
            kind: "tool",
            name: block.name,
            summary: toolSummary(block.name, block.input, options.cwd),
            failed: false,
          });
        }
      }
    }
  }
  return entries.slice(-(options.limit ?? 80));
}
