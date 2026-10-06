// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - an opt-in, model-free plugin test runner, outside the server runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

import { writeClaudeMod } from "./install.ts";
import { PEER_MOD_NATIVE_TESTS } from "./nativeTests.ts";

/** Claude's native test engine runs no model, tool, sign-in, or network request. */
export async function testClaudeMod(
  executable = "claude",
): Promise<{ readonly validation: string; readonly tests: string }> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-mod-native-"));
  try {
    const directory = NodePath.join(root, "claude-mod");
    await writeClaudeMod({
      directory,
      socketPath: NodePath.join(root, "broker.sock"),
      peerScript: NodePath.join(root, "peer"),
    });
    await NodeFSP.writeFile(
      NodePath.join(directory, "hooks", "peer.test.ts"),
      PEER_MOD_NATIVE_TESTS,
    );
    const run = NodeUtil.promisify(NodeChildProcess.execFile);
    const options = {
      env: { ...process.env, CLAUDE_CONFIG_DIR: NodePath.join(root, "config") },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    };
    const validation = await run(executable, ["plugin", "validate", directory], options);
    const tests = await run(executable, ["plugin", "test", directory], options);
    return {
      validation: validation.stdout + validation.stderr,
      tests: tests.stdout + tests.stderr,
    };
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(process.argv[1])
) {
  const result = await testClaudeMod(process.env.CLAUDE_BIN || "claude");
  process.stdout.write(result.validation + result.tests);
}
