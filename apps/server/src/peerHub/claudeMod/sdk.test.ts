import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";

import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const input = {
  modelSelection: {
    instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
    model: "claude-sonnet-4-6",
  },
  nativeThreadId: "peer-mod-sdk-test",
  resume: false,
  cwd: "/work",
} as const;

describe("Peer Claude Mod in Agent SDK", () => {
  it("loads only the opted-in private plugin and removes its duplicate env path", () => {
    const options = makeClaudeQueryOptions({
      ...input,
      peerPluginDir: "/peer/coord/claude-mod",
      environment: {
        PRIVATE_SETTING: "preserved",
        CLAUDE_CODE_PLUGIN_DIRS: "/other:/peer/coord/claude-mod",
      },
    });
    assert.deepStrictEqual(options.plugins, [{ type: "local", path: "/peer/coord/claude-mod" }]);
    assert.deepStrictEqual(options.env, {
      PRIVATE_SETTING: "preserved",
      CLAUDE_CODE_PLUGIN_DIRS: "/other",
    });
  });

  it("does not turn unrelated environment plugin paths into Peer managed plugins", () => {
    const environment = {
      CLAUDE_CODE_PLUGIN_DIRS: "/other/plugin",
      PEER_CLAUDE_MOD_DIR: "/other/plugin",
    };
    const options = makeClaudeQueryOptions({ ...input, environment });
    assert.isUndefined(options.plugins);
    assert.strictEqual(options.env, environment);
  });

  it("keeps Peer disabled for helper sessions even when its package is installed", () => {
    const options = makeClaudeQueryOptions({
      ...input,
      peerPluginDir: "/peer/coord/claude-mod",
      environment: { PEER_COORDINATION: "off" },
    });
    assert.isUndefined(options.plugins);
  });
});
