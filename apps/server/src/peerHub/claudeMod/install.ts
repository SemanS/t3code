// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - packaged local plugin files and the agent's existing JSON settings boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { PEER_MOD_SOURCE } from "./source.ts";

export const CLAUDE_MOD_MIN_VERSION = "2.1.291";

/** Mods start at 2.1.287; this socket adapter is verified against the 2.1.291 API. */
export function supportsClaudeMod(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$|[+-])/.exec(version.trim());
  if (match === null) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return (
    (major ?? 0) > 2 || (major === 2 && ((minor ?? 0) > 1 || (minor === 1 && (patch ?? 0) >= 291)))
  );
}

export const peerClaudeModPath = (coordinationDir: string) =>
  NodePath.join(coordinationDir, "claude-mod");

type Settings = Record<string, unknown>;

/** Add/remove only Peer's own inline plugin directory; preserve every other setting and path. */
export function withClaudeMod(settings: Settings, pluginDir: string, install: boolean): Settings {
  const previous = settings.env;
  if (
    previous !== undefined &&
    (typeof previous !== "object" || previous === null || Array.isArray(previous))
  ) {
    throw new Error("Claude Code's env settings are not an object.");
  }
  const env = { ...((previous ?? {}) as Record<string, unknown>) };
  const current = env.CLAUDE_CODE_PLUGIN_DIRS;
  if (current !== undefined && typeof current !== "string") {
    throw new Error("CLAUDE_CODE_PLUGIN_DIRS must be a string.");
  }
  const dirs = (current ?? "")
    .split(NodePath.delimiter)
    .filter((dir) => dir !== "" && dir !== pluginDir);
  if (install) dirs.push(pluginDir);
  if (dirs.length > 0) env.CLAUDE_CODE_PLUGIN_DIRS = dirs.join(NodePath.delimiter);
  else delete env.CLAUDE_CODE_PLUGIN_DIRS;
  const { env: _previous, ...rest } = settings;
  return Object.keys(env).length === 0 ? rest : { ...rest, env };
}

function assertPrivateDirectory(directory: string) {
  if (!NodePath.isAbsolute(directory) || NodePath.basename(directory) !== "claude-mod") {
    throw new Error("Peer's plugin must live in its absolute claude-mod directory.");
  }
}

async function assertOwned(directory: string) {
  assertPrivateDirectory(directory);
  for (const relative of ["", ".claude-plugin", "hooks"]) {
    try {
      if ((await NodeFSP.lstat(NodePath.join(directory, relative))).isSymbolicLink()) {
        throw new Error("Peer's private plugin directory must not be a symlink.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  let text: string;
  try {
    text = await NodeFSP.readFile(
      NodePath.join(directory, ".claude-plugin", "plugin.json"),
      "utf8",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const manifest: unknown = JSON.parse(text);
  if (typeof manifest !== "object" || manifest === null || (manifest as Settings).name !== "peer") {
    throw new Error("This plugin directory does not belong to Peer.");
  }
}

export function claudeModFiles(input: {
  readonly socketPath: string;
  readonly peerScript: string;
}): Readonly<Record<string, string>> {
  if (!NodePath.isAbsolute(input.socketPath) || input.socketPath.includes("\0")) {
    throw new Error("Peer's broker socket must be an absolute path without NUL.");
  }
  if (!NodePath.isAbsolute(input.peerScript) || input.peerScript.includes("\0")) {
    throw new Error("Peer's command must be an absolute path without NUL.");
  }
  return {
    ".claude-plugin/plugin.json": `${JSON.stringify(
      {
        name: "peer",
        version: "0.1.0",
        author: { name: "Peer" },
        description: "Peer team coordination through the local broker.",
        userConfig: {
          socketPath: {
            type: "string",
            title: "Peer broker socket",
            description: "Peer broker's local Unix socket.",
            default: input.socketPath,
          },
        },
      },
      null,
      2,
    )}\n`,
    ".claude-plugin/marketplace.json": `${JSON.stringify(
      {
        name: "peer-local",
        description: "Local Peer coordination adapter.",
        owner: { name: "Peer" },
        plugins: [{ name: "peer", source: "./", description: "Local Peer coordination adapter." }],
      },
      null,
      2,
    )}\n`,
    "hooks/hooks.json": '{"modules":["./register.js"]}\n',
    "hooks/register.js": PEER_MOD_SOURCE.replace(
      "__PEER_SOCKET__",
      JSON.stringify(input.socketPath),
    ),
  };
}

/** Writes only the packaged plugin. Activation happens separately in settings / SDK options. */
export async function writeClaudeMod(input: {
  readonly directory: string;
  readonly socketPath: string;
  readonly peerScript: string;
}): Promise<void> {
  await assertOwned(input.directory);
  for (const [relative, text] of Object.entries(claudeModFiles(input))) {
    const path = NodePath.join(input.directory, relative);
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    try {
      if ((await NodeFSP.readFile(path, "utf8")) === text) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${path}.tmp`;
    await NodeFSP.writeFile(temporary, text, { mode: 0o600 });
    await NodeFSP.rename(temporary, path);
  }
}

/** Deactivation removes the env entry first; this removes only the private Peer package. */
export async function removeClaudeMod(directory: string): Promise<void> {
  await assertOwned(directory);
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
