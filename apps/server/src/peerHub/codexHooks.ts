// @effect-diagnostics nodeBuiltinImport:off - hook settings belong to the person's selected Codex home.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  codexHookGroups,
  codexHookHash,
  codexHookTrust,
  codexRules,
  hasPeerHooks,
  settingsDiffer,
  withPeerHooks,
  type Settings,
} from "./coordination.ts";

export interface CodexPeerScripts {
  readonly hook: string;
  readonly wait: string;
}

export interface CodexPeerHook {
  readonly event: string;
  readonly key: string;
  readonly command: string;
  readonly hash: string;
  readonly matcher?: string;
  readonly timeout: number;
  readonly enabled: boolean;
  readonly trusted: boolean;
}

export interface CodexPeerHookReview {
  readonly home: string;
  readonly hooksPath: string;
  readonly present: boolean;
  readonly installed: boolean;
  readonly trusted: boolean;
  /** Identity of the commands, positions, normalized hashes and installed script contents being reviewed. */
  readonly reviewId: string;
  readonly hooks: ReadonlyArray<CodexPeerHook>;
}

const labels: Readonly<Record<string, string>> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  PreToolUse: "pre_tool_use",
  PostToolUse: "post_tool_use",
  PermissionRequest: "permission_request",
  PreCompact: "pre_compact",
  Stop: "stop",
  SessionEnd: "session_end",
};

async function readText(file: string): Promise<string> {
  try {
    return await NodeFSP.readFile(file, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return "";
    throw error;
  }
}

function decodeHooks(text: string): Settings {
  const value: unknown = JSON.parse(text || "{}");
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Codex hooks must be a JSON object.");
  const hooks = (value as Settings).hooks;
  if (hooks !== undefined) {
    if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
      throw new Error("Codex hooks must contain an event map.");
    for (const groups of Object.values(hooks)) {
      if (
        !Array.isArray(groups) ||
        groups.some(
          (group) =>
            typeof group !== "object" ||
            group === null ||
            !Array.isArray(group.hooks) ||
            group.hooks.some((hook: unknown) => typeof hook !== "object" || hook === null),
        )
      )
        throw new Error("Codex hook groups are invalid.");
    }
  }
  return value as Settings;
}

function digest(text: string): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(text).digest("hex")}`;
}

/** Read the exact runtime home: a shadow home has its own trust keys even when files are symlinks. */
export async function readCodexPeerHookReview(
  home: string,
  scripts: CodexPeerScripts,
): Promise<CodexPeerHookReview> {
  home = NodePath.resolve(home);
  const hooksPath = NodePath.join(home, "hooks.json");
  const [hooksText, config, scriptText] = await Promise.all([
    readText(hooksPath),
    readText(NodePath.join(home, "config.toml")),
    readText(scripts.hook),
  ]);
  const settings = decodeHooks(hooksText);
  const trust = codexHookTrust(config);
  const hooks: CodexPeerHook[] = [];
  let installed = scriptText.length > 0;
  const expectedGroups = codexHookGroups(scripts);
  for (const [event, expected] of Object.entries(expectedGroups)) {
    const handler = expected[0]?.hooks?.[0];
    if (handler === undefined) continue;
    const expectedHash = codexHookHash(event, expected[0]?.matcher, handler);
    let found = 0;
    for (const [g, group] of (settings.hooks?.[event] ?? []).entries()) {
      for (const [h, actual] of (group.hooks ?? []).entries()) {
        if (actual.command !== handler.command) continue;
        const hash = codexHookHash(event, group.matcher, actual);
        const exact =
          Object.keys(actual).length === Object.keys(handler).length &&
          Object.entries(handler).every(([key, value]) => actual[key] === value) &&
          group.matcher === expected[0]?.matcher;
        if (!exact || hash !== expectedHash || hash === null) {
          installed = false;
          continue;
        }
        found += 1;
        const key = `${hooksPath}:${labels[event]}:${g}:${h}`;
        const state = trust.get(key);
        hooks.push({
          event,
          key,
          command: String(handler.command),
          hash,
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
          timeout: Number(handler.timeout),
          enabled: state?.enabled !== false,
          trusted: state?.enabled !== false && state?.hash === hash,
        });
      }
    }
    if (found !== 1) installed = false;
  }
  const reviewId = digest(
    JSON.stringify({
      home,
      hooksPath,
      installed,
      scriptHash: digest(scriptText),
      hooks: hooks.map(({ enabled: _enabled, trusted: _trusted, ...hook }) => hook),
    }),
  );
  return {
    home,
    hooksPath,
    present: hasPeerHooks(settings, NodePath.dirname(scripts.hook)),
    installed,
    trusted: installed && hooks.every((hook) => hook.trusted),
    reviewId,
    hooks,
  };
}

async function writePreservingLink(file: string, contents: string): Promise<void> {
  const target = await NodeFSP.realpath(file).catch(async (error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      const entry = await NodeFSP.lstat(file).catch((failure: unknown) => {
        if (
          typeof failure === "object" &&
          failure !== null &&
          "code" in failure &&
          failure.code === "ENOENT"
        )
          return undefined;
        throw failure;
      });
      if (entry?.isSymbolicLink())
        throw new Error(
          "The Codex settings symlink target is missing; restore it before reviewing hooks.",
        );
      return file;
    }
    throw error;
  });
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  const temporary = `${target}.peer-${NodeCrypto.randomUUID()}.tmp`;
  try {
    const mode = await NodeFSP.stat(target)
      .then((stat) => stat.mode & 0o777)
      .catch(() => 0o600);
    await NodeFSP.writeFile(temporary, contents, { mode });
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

/** Installation never grants trust. Preserve the person's other hooks and hook-state records. */
export async function installCodexPeerHooks(
  home: string,
  scripts: CodexPeerScripts,
  install: boolean,
): Promise<void> {
  const hooksPath = NodePath.join(NodePath.resolve(home), "hooks.json");
  const previous = decodeHooks(await readText(hooksPath));
  const next = withPeerHooks(
    previous,
    codexHookGroups(scripts),
    NodePath.dirname(scripts.hook),
    install,
  );
  if (settingsDiffer(previous, next))
    await writePreservingLink(hooksPath, `${JSON.stringify(next, null, 2)}\n`);
  const rulesPath = NodePath.join(home, "rules", "peer.rules");
  if (install)
    await writePreservingLink(
      rulesPath,
      codexRules(NodePath.join(NodePath.dirname(scripts.hook), "bin", "peer")),
    );
  else await NodeFSP.rm(rulesPath, { force: true });
}

const hookStateHeader = /^\s*\[\s*hooks\.state\."((?:[^"\\]|\\.)*)"\s*\]\s*(?:#[^\n]*)?(?:\r?\n|$)/;

/** Only the native quoted state-table representation is safe for the narrow edit below. */
function assertSupportedHookState(config: string): void {
  let scope: "parent" | "entry" | undefined;
  for (const sourceLine of config.split("\n")) {
    const line = sourceLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const entry = hookStateHeader.test(line);
      const parent = /^\[\s*hooks\.state\s*\]\s*(?:#.*)?$/.test(line);
      if (!entry && !parent && /^\[\[?\s*(?:hooks\s*\.\s*(?:state\b|["'])|["'])/.test(line)) {
        throw new Error("This Codex hook state format needs review in Codex's /hooks screen.");
      }
      scope = entry ? "entry" : parent ? "parent" : undefined;
      continue;
    }
    const alternate =
      /^(?:hooks|state|["'](?:hooks|state)["'])(?:\s*\.\s*[^=]+)?\s*=/.test(line) ||
      /^"(?:[^"\\]|\\.)*\\[uU]/.test(line);
    const nativeField =
      /^(?:enabled\s*=\s*(?:true|false)|trusted_hash\s*=\s*"[^"\n]*")\s*(?:#.*)?$/.test(line);
    if (alternate || scope === "parent" || (scope === "entry" && !nativeField)) {
      throw new Error("This Codex hook state format needs review in Codex's /hooks screen.");
    }
  }
}

/** A deliberately narrow edit: unfamiliar TOML trust representations require review in Codex. */
function withReviewedTrust(config: string, hooks: ReadonlyArray<CodexPeerHook>): string {
  if (/'''|"""/.test(config))
    throw new Error("This Codex config uses multiline TOML; review the Peer hooks in Codex.");
  assertSupportedHookState(config);
  const pending = new Map(hooks.map((hook) => [hook.key, hook]));
  const sections = config.split(/(?=^\s*\[)/m);
  const seen = new Set<string>();
  const next = sections
    .map((section) => {
      const header = hookStateHeader.exec(section);
      if (header === null) {
        return section;
      }
      const key = JSON.parse(`"${header[1]}"`) as string;
      if (seen.has(key)) throw new Error("Codex config contains duplicate hook trust tables.");
      seen.add(key);
      const hook = pending.get(key);
      if (hook === undefined) return section;
      pending.delete(key);
      const body = section.slice(header[0].length);
      const prefix = header[0].endsWith("\n") ? header[0] : `${header[0]}\n`;
      // Keep enabled=false and every unrelated field/comment exactly as the person wrote it.
      const hashLine = /^([\t ]*)trusted_hash\s*=\s*"[^"\n]*"([^\n]*)/m;
      if (hashLine.test(body))
        return prefix + body.replace(hashLine, `$1trusted_hash = ${JSON.stringify(hook.hash)}$2`);
      if (/^\s*trusted_hash\s*=/m.test(body))
        throw new Error("This Codex trusted hash format needs review in Codex.");
      return `${prefix}trusted_hash = ${JSON.stringify(hook.hash)}\n${body}`;
    })
    .join("");
  let result = next;
  for (const hook of pending.values()) {
    result += `${result.endsWith("\n") || result.length === 0 ? "" : "\n"}\n[hooks.state.${JSON.stringify(hook.key)}]\ntrusted_hash = ${JSON.stringify(hook.hash)}\nenabled = true\n`;
  }
  return result;
}

/** Call only for a person's explicit approval of this displayed review, never as part of installation. */
export async function trustCodexPeerHooks(
  home: string,
  scripts: CodexPeerScripts,
  reviewId: string,
): Promise<CodexPeerHookReview> {
  const review = await readCodexPeerHookReview(home, scripts);
  if (!review.installed || review.reviewId !== reviewId)
    throw new Error(
      "Peer hooks changed or are not completely installed. Review the current commands before trusting them.",
    );
  const configPath = NodePath.join(review.home, "config.toml");
  const config = await readText(configPath);
  const next = withReviewedTrust(config, review.hooks);
  const current = await readCodexPeerHookReview(home, scripts);
  if (current.reviewId !== reviewId || (await readText(configPath)) !== config)
    throw new Error("Codex settings changed during hook review. Review them again.");
  if (next !== config) await writePreservingLink(configPath, next);
  return readCodexPeerHookReview(home, scripts);
}

/** Server actions accept only homes selected by the current provider configuration. */
export async function trustConfiguredCodexPeerHooks(
  homes: ReadonlyArray<string>,
  approval: { readonly home: string; readonly reviewId: string },
  scripts: CodexPeerScripts,
): Promise<CodexPeerHookReview> {
  if (!homes.includes(approval.home))
    throw new Error(
      "This Codex home is no longer configured on this environment. Refresh its hook review.",
    );
  return trustCodexPeerHooks(approval.home, scripts, approval.reviewId);
}
