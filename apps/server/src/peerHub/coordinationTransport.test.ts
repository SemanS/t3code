// @effect-diagnostics nodeBuiltinImport:off - executes generated scripts against a synthetic Unix broker.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { coordinationScripts } from "./coordination.ts";

async function command(script: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    NodeChildProcess.execFile(
      "/bin/sh",
      ["-c", script, "peer", ...args],
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function broker(status: number, body: string, run: (script: string) => Promise<void>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-transport-"));
  const socket = NodePath.join(dir, "broker.sock");
  const server = NodeHttp.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(status);
      response.end(body);
    });
  });
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await run(coordinationScripts(socket, NodePath.join(dir, "bin")).peer);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFSP.rm(dir, { force: true, recursive: true });
  }
}

describe("generated Peer CLI transport", () => {
  it("exits nonzero and displays the broker's useful 409 body", async () => {
    await broker(
      409,
      "peer: this agent session is not registered. Start a fresh session.\n",
      async (script) => {
        const result = await command(script, ["note", "hello"]);
        assert.notStrictEqual(result.code, 0);
        assert.include(result.stderr, "this agent session is not registered");
        assert.strictEqual(result.stdout, "");
      },
    );
  });

  it("preserves successful output and exit status", async () => {
    await broker(200, "Note sent.\n", async (script) => {
      const result = await command(script, ["note", "hello"]);
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout, "Note sent.\n");
      assert.strictEqual(result.stderr, "");
    });
  });

  it("keeps the network failure message when Peer is not running", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-transport-"));
    try {
      const result = await command(
        coordinationScripts(NodePath.join(dir, "absent.sock"), dir).peer,
        [],
      );
      assert.notStrictEqual(result.code, 0);
      assert.include(result.stderr, "Peer is not running");
    } finally {
      await NodeFSP.rm(dir, { force: true, recursive: true });
    }
  });
});
