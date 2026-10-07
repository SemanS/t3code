import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { resolveCodexPeerHookHomes, prepareCodexPeerHookHomes } from "./codexHookHomes.ts";

it.effect(
  "prepares shared hook, config and rules links even before a fresh profile has created those files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "peer-hook-homes-" });
      const shared = path.join(root, "shared");
      const shadow = path.join(root, "shadow");
      yield* prepareCodexPeerHookHomes(
        root,
        {
          [ProviderInstanceId.make("codex-work")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { setupMode: "managed", homePath: shared, shadowHomePath: shadow },
          },
        },
        shared,
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(shadow, "hooks.json")),
        path.join(shared, "hooks.json"),
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(shadow, "config.toml")),
        path.join(shared, "config.toml"),
      );
      assert.strictEqual(
        yield* fs.readLink(path.join(shadow, "rules")),
        path.join(shared, "rules"),
      );
      assert.strictEqual(yield* fs.readFileString(path.join(shared, "config.toml")), "");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "includes ambient, direct, environment and managed shadow homes while excluding disabled and other providers",
  () =>
    Effect.gen(function* () {
      const instances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
        [ProviderInstanceId.make("codex-direct")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: "/custom/direct" },
        },
        [ProviderInstanceId.make("codex-shadow")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { setupMode: "managed", homePath: "/shared" },
        },
        [ProviderInstanceId.make("codex-env")]: {
          driver: ProviderDriverKind.make("codex"),
          environment: [{ name: "CODEX_HOME", value: "/env/home", sensitive: false }],
        },
        [ProviderInstanceId.make("codex-disabled")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: { homePath: "/disabled" },
        },
        [ProviderInstanceId.make("claude")]: { driver: ProviderDriverKind.make("claude") },
      };
      const homes = yield* resolveCodexPeerHookHomes("/state", instances, "/ambient");
      assert.deepStrictEqual(homes, [
        "/ambient",
        "/custom/direct",
        "/state/providers/codex/codex-shadow/shadow",
        "/env/home",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "deduplicates matching direct homes and honors an explicit shadow for an existing provider",
  () =>
    Effect.gen(function* () {
      const homes = yield* resolveCodexPeerHookHomes(
        "/state",
        {
          [ProviderInstanceId.make("codex")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/ambient" },
          },
          [ProviderInstanceId.make("codex-existing-shadow")]: {
            driver: ProviderDriverKind.make("codex"),
            config: { homePath: "/shared", shadowHomePath: "/existing-shadow" },
          },
        },
        "/ambient",
      );
      assert.deepStrictEqual(homes, ["/ambient", "/existing-shadow"]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
