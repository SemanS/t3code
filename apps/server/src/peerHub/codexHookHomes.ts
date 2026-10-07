import {
  CodexSettings,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expandHomePath } from "../pathExpansion.ts";
import { resolveManagedCodexHomeLayout } from "../provider/CodexManagedHome.ts";
import {
  resolveCodexHomeLayout,
  materializeCodexShadowHome,
  type CodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

/** The same home selection as the drivers, plus the native CLI's home on this environment. */
const resolveHomeLayouts = Effect.fn("resolveCodexPeerHookHomeLayouts")(function* (
  stateDir: string,
  instances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
  ambientHome: string,
) {
  const path = yield* Path.Path;
  const homes = new Map<string, CodexHomeLayout | undefined>([
    [path.resolve(expandHomePath(ambientHome)), undefined],
  ]);
  for (const [instanceId, instance] of Object.entries(instances)) {
    if (instance.driver !== "codex" || !resolveProviderInstanceEnabled(instance)) continue;
    const config = decodeCodexSettings(instance.config ?? {});
    const layout =
      config.setupMode === "managed"
        ? yield* resolveManagedCodexHomeLayout(stateDir, instanceId as ProviderInstanceId, config)
        : yield* resolveCodexHomeLayout(config);
    const environment = mergeProviderInstanceEnvironment(instance.environment);
    const home =
      layout.effectiveHomePath ??
      (config.setupMode === "managed"
        ? layout.sharedHomePath
        : environment.CODEX_HOME?.trim() || layout.sharedHomePath);
    homes.set(path.resolve(expandHomePath(home)), layout);
  }
  return homes;
});

export const resolveCodexPeerHookHomes = Effect.fn("resolveCodexPeerHookHomes")(function* (
  stateDir: string,
  instances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
  ambientHome: string,
) {
  return [...(yield* resolveHomeLayouts(stateDir, instances, ambientHome)).keys()];
});

/** Only on explicit installation: prepare profile links before writing their hook files. */
export const prepareCodexPeerHookHomes = Effect.fn("prepareCodexPeerHookHomes")(function* (
  stateDir: string,
  instances: Readonly<Record<ProviderInstanceId, ProviderInstanceConfig>>,
  ambientHome: string,
) {
  const homes = yield* resolveHomeLayouts(stateDir, instances, ambientHome);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const layout of homes.values()) {
    if (layout?.mode !== "authOverlay") continue;
    // A fresh shared home has no files for the overlay to link yet. Creating only
    // absent placeholders keeps later hook/config/rule writes on shared targets.
    yield* fs.makeDirectory(path.join(layout.sharedHomePath, "rules"), { recursive: true });
    for (const [name, contents] of [
      ["hooks.json", "{}\n"],
      ["config.toml", ""],
    ] as const) {
      yield* fs
        .writeFileString(path.join(layout.sharedHomePath, name), contents, {
          flag: "wx",
          mode: 0o600,
        })
        .pipe(
          Effect.catchTag("PlatformError", (error) =>
            error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
          ),
        );
    }
    yield* materializeCodexShadowHome(layout);
  }
  return [...homes.keys()];
});
