// @effect-diagnostics nodeBuiltinImport:off - synthetic Codex homes exercise the real filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, describe, it, expect } from "@effect/vitest";
import {
  installCodexPeerHooks,
  readCodexPeerHookReview,
  trustCodexPeerHooks,
  trustConfiguredCodexPeerHooks,
} from "./codexHooks.ts";

async function fixture(
  run: (home: string, scripts: { hook: string; wait: string }) => Promise<void>,
) {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "peer-codex-hooks-"));
  try {
    const scripts = {
      hook: NodePath.join(home, "coord", "hook"),
      wait: NodePath.join(home, "coord", "wait"),
    };
    await NodeFSP.mkdir(NodePath.dirname(scripts.hook));
    await NodeFSP.writeFile(scripts.hook, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await run(home, scripts);
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
}

describe("Codex Peer hook review", () => {
  it.each([
    '[hooks.state]\n"KEY" = { trusted_hash = "sha256:old", enabled = false }\n',
    'hooks = { state = { "KEY" = { trusted_hash = "sha256:old", enabled = false } } }\n',
    '[hooks."state"."KEY"]\ntrusted_hash = "sha256:old"\nenabled = false\n',
    '["hooks".state."KEY"]\ntrusted_hash = "sha256:old"\nenabled = false\n',
    "[hooks.state.'KEY']\ntrusted_hash = 'sha256:old'\nenabled = false\n",
    '[ hooks . state . "KEY" ]\ntrusted_hash = "sha256:old"\nenabled = false\n',
    '[hooks]\n"state" = { "KEY" = { enabled = false } }\n',
    '"hooks"."state"."KEY" = { enabled = false }\n',
    '[hooks.state."KEY"]\n"enabled" = false\n',
  ])("leaves an unsupported TOML state layout untouched: %s", async (template) => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      const config = template.replaceAll("KEY", review.hooks[0]!.key);
      const configPath = NodePath.join(home, "config.toml");
      await NodeFSP.writeFile(configPath, config);
      await expect(trustCodexPeerHooks(home, scripts, review.reviewId)).rejects.toThrow(
        /review.*Codex/i,
      );
      assert.strictEqual(await NodeFSP.readFile(configPath, "utf8"), config);
    });
  });

  it("leaves a dangling config symlink intact instead of replacing it during trust", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const target = NodePath.join(home, "absent-config.toml");
      const link = NodePath.join(home, "config.toml");
      await NodeFSP.symlink(target, link);
      const review = await readCodexPeerHookReview(home, scripts);
      await expect(trustCodexPeerHooks(home, scripts, review.reviewId)).rejects.toThrow(
        /symlink.*missing/i,
      );
      assert.strictEqual(await NodeFSP.readlink(link), target);
      await expect(NodeFSP.stat(target)).rejects.toThrow(/ENOENT/);
    });
  });

  it("preserves non-state hook options and empty parent state tables", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      const config =
        "[hooks]\nallow_managed_hooks_only = false # personal option\n\n[hooks.state]\n# no inline entries\n";
      await NodeFSP.writeFile(NodePath.join(home, "config.toml"), config);
      const after = await trustCodexPeerHooks(home, scripts, review.reviewId);
      assert.isTrue(after.trusted);
      assert.isTrue(
        (await NodeFSP.readFile(NodePath.join(home, "config.toml"), "utf8")).startsWith(config),
      );
    });
  });

  it("rejects approval of a home that was removed from the environment's provider configuration", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      await expect(
        trustConfiguredCodexPeerHooks(
          [`${home}/other-profile`],
          { home, reviewId: review.reviewId },
          scripts,
        ),
      ).rejects.toThrow(/no longer configured/);
      await expect(NodeFSP.readFile(NodePath.join(home, "config.toml"))).rejects.toThrow(/ENOENT/);
    });
  });
  it("invalidates the review when the installed script contents change", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      await NodeFSP.writeFile(scripts.hook, "#!/bin/sh\necho changed\n");
      await expect(trustCodexPeerHooks(home, scripts, review.reviewId)).rejects.toThrow(/review/i);
    });
  });

  it("keeps a person's disabled Peer hook disabled when granting trust", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      const disabled = `[hooks.state.${JSON.stringify(review.hooks[0]!.key)}]\nenabled = false # intentionally off\n`;
      await NodeFSP.writeFile(NodePath.join(home, "config.toml"), disabled);
      const after = await trustCodexPeerHooks(home, scripts, review.reviewId);
      assert.isFalse(after.trusted);
      assert.isFalse(after.hooks[0]!.enabled);
      assert.include(
        await NodeFSP.readFile(NodePath.join(home, "config.toml"), "utf8"),
        "enabled = false # intentionally off",
      );
    });
  });

  it("installs eight hooks without trusting any, then approves only the exact reviewed Peer hooks", async () => {
    await fixture(async (home, scripts) => {
      const foreign = { type: "command", command: "echo /peer/coord/foreign" };
      await NodeFSP.writeFile(
        NodePath.join(home, "hooks.json"),
        JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }),
      );
      const config =
        '# personal settings\nmodel = "gpt-5"\n[hooks.state."foreign"]\ntrusted_hash = "sha256:foreign"\nenabled = false\n';
      await NodeFSP.writeFile(NodePath.join(home, "config.toml"), config);
      await installCodexPeerHooks(home, scripts, true);
      const before = await readCodexPeerHookReview(home, scripts);
      assert.isTrue(before.installed);
      assert.isFalse(before.trusted);
      assert.strictEqual(before.hooks.length, 8);
      assert.isTrue(before.hooks.every((hook) => hook.command === `${scripts.hook} codex`));
      await trustCodexPeerHooks(home, scripts, before.reviewId);
      const after = await readCodexPeerHookReview(home, scripts);
      assert.isTrue(after.trusted);
      assert.strictEqual(after.reviewId, before.reviewId);
      assert.isTrue(
        (await NodeFSP.readFile(NodePath.join(home, "config.toml"), "utf8")).startsWith(config),
      );
      assert.deepStrictEqual(
        JSON.parse(await NodeFSP.readFile(NodePath.join(home, "hooks.json"), "utf8")).hooks.Stop[0]
          .hooks[0],
        foreign,
      );
    });
  });

  it("requires a fresh review after a hook changes and never approves a command containing the Peer path", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      const hookPath = NodePath.join(home, "hooks.json");
      const hooks = JSON.parse(await NodeFSP.readFile(hookPath, "utf8"));
      hooks.hooks.Stop[0].hooks[0].command += " && echo unsafe";
      await NodeFSP.writeFile(hookPath, JSON.stringify(hooks));
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).installed);
      await expect(trustCodexPeerHooks(home, scripts, review.reviewId)).rejects.toThrow(
        /review|installed/i,
      );
      await expect(NodeFSP.readFile(NodePath.join(home, "config.toml"))).rejects.toThrow(/ENOENT/);
    });
  });

  it("does not report partial, disabled, or stale-hash installations as ready", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      await trustCodexPeerHooks(home, scripts, review.reviewId);
      const configPath = NodePath.join(home, "config.toml");
      const trusted = await NodeFSP.readFile(configPath, "utf8");
      await NodeFSP.writeFile(configPath, trusted.replace("enabled = true", "enabled = false"));
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).trusted);
      await NodeFSP.writeFile(configPath, trusted.replace(review.hooks[0]!.hash, "sha256:stale"));
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).trusted);
      const hookPath = NodePath.join(home, "hooks.json");
      const hooks = JSON.parse(await NodeFSP.readFile(hookPath, "utf8"));
      delete hooks.hooks.SessionStart;
      await NodeFSP.writeFile(hookPath, JSON.stringify(hooks));
      assert.isTrue((await readCodexPeerHookReview(home, scripts)).present);
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).installed);
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).trusted);
    });
  });

  it("reviews trust separately for a shadow home while preserving shared config links", async () => {
    await fixture(async (home, scripts) => {
      const shadow = NodePath.join(home, "shadow");
      await NodeFSP.mkdir(shadow);
      await NodeFSP.writeFile(NodePath.join(home, "config.toml"), 'model = "gpt-5"\n');
      await installCodexPeerHooks(home, scripts, true);
      await NodeFSP.symlink(
        NodePath.join(home, "config.toml"),
        NodePath.join(shadow, "config.toml"),
      );
      await NodeFSP.symlink(NodePath.join(home, "hooks.json"), NodePath.join(shadow, "hooks.json"));
      const native = await readCodexPeerHookReview(home, scripts);
      await trustCodexPeerHooks(home, scripts, native.reviewId);
      const managed = await readCodexPeerHookReview(shadow, scripts);
      assert.isFalse(managed.trusted);
      assert.notStrictEqual(managed.reviewId, native.reviewId);
      await trustCodexPeerHooks(shadow, scripts, managed.reviewId);
      assert.isTrue((await readCodexPeerHookReview(shadow, scripts)).trusted);
      assert.isTrue((await readCodexPeerHookReview(home, scripts)).trusted);
      assert.strictEqual(
        await NodeFSP.readlink(NodePath.join(shadow, "config.toml")),
        NodePath.join(home, "config.toml"),
      );
    });
  });

  it("removes only Peer hooks and leaves unrelated hook trust and config untouched", async () => {
    await fixture(async (home, scripts) => {
      await installCodexPeerHooks(home, scripts, true);
      const review = await readCodexPeerHookReview(home, scripts);
      await trustCodexPeerHooks(home, scripts, review.reviewId);
      const config = await NodeFSP.readFile(NodePath.join(home, "config.toml"), "utf8");
      await installCodexPeerHooks(home, scripts, false);
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).present);
      assert.isFalse((await readCodexPeerHookReview(home, scripts)).installed);
      assert.strictEqual(
        await NodeFSP.readFile(NodePath.join(home, "config.toml"), "utf8"),
        config,
      );
    });
  });
});
