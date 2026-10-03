import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Hotovo Hub: the company registry a Hotovo Peer environment signs in to.
 * The hub declares projects, their repositories, agent tools, knowledge and
 * AI capacity; this environment provisions them locally. The manifest
 * mirrors the hub service's `GET /v1/me/manifest` (version 1). Unknown
 * fields from a newer hub are ignored on decode.
 */

/** Agent runtime families a hub project may allow, named as the hub names them. */
export const HotovoHarness = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);
export type HotovoHarness = typeof HotovoHarness.Type;

export const HotovoHubMcpServer = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({
    transport: Schema.Literals(["http", "sse"]),
    url: Schema.String,
    headers: Schema.Record(Schema.String, Schema.String),
  }),
]);
export type HotovoHubMcpServer = typeof HotovoHubMcpServer.Type;

export const HotovoHubTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mcp: HotovoHubMcpServer,
  requires: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      install: Schema.optional(Schema.String),
      docs: Schema.optional(Schema.String),
    }),
  ),
});
export type HotovoHubTool = typeof HotovoHubTool.Type;

export const HotovoPersonalCapacityPolicy = Schema.Literals(["any", "commercial", "none"]);
export type HotovoPersonalCapacityPolicy = typeof HotovoPersonalCapacityPolicy.Type;

export const HotovoHubCurrency = Schema.Literals(["EUR", "USD"]);

export const HotovoHubProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  client: Schema.optional(Schema.String),
  role: Schema.Literals(["lead", "member"]),
  members: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  repositories: Schema.Array(
    Schema.Struct({ id: Schema.String, url: Schema.String, branch: Schema.String }),
  ),
  knowledge: Schema.Struct({ kontext: Schema.Boolean, company: Schema.Boolean }),
  tools: Schema.Array(HotovoHubTool),
  capacity: Schema.Struct({
    personal: HotovoPersonalCapacityPolicy,
    /** Harnesses the member declared a qualifying seat for (informational for "commercial"). */
    personalHarnesses: Schema.Array(HotovoHarness),
    shared: Schema.optional(
      Schema.Struct({
        pool: Schema.String,
        gatewayUrl: Schema.String,
        models: Schema.Array(
          Schema.Struct({ id: Schema.String, harness: Schema.Array(HotovoHarness) }),
        ),
        budget: Schema.Struct({
          amount: Schema.Number,
          period: Schema.Literals(["day", "week", "month"]),
          currency: HotovoHubCurrency,
        }),
        allocation: Schema.optional(Schema.Number),
        use: Schema.Array(Schema.Literals(["on-demand", "overflow", "automation"])),
      }),
    ),
  }),
});
export type HotovoHubProject = typeof HotovoHubProject.Type;

export const HotovoHubManifest = Schema.Struct({
  version: Schema.Literal(1),
  hub: Schema.Struct({
    name: Schema.String,
    displayName: Schema.String,
    url: Schema.optional(Schema.String),
    currency: HotovoHubCurrency,
    revision: Schema.optional(Schema.String),
  }),
  member: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    github: Schema.optional(Schema.String),
    bitbucket: Schema.optional(Schema.String),
    roles: Schema.Array(Schema.String),
  }),
  knowledge: Schema.Struct({
    company: Schema.optional(
      Schema.Struct({ repository: Schema.String, branch: Schema.String, store: Schema.String }),
    ),
  }),
  projects: Schema.Array(HotovoHubProject),
});
export type HotovoHubManifest = typeof HotovoHubManifest.Type;

export const HotovoHubCheckoutState = Schema.Literals(["missing", "cloning", "ready", "error"]);
export type HotovoHubCheckoutState = typeof HotovoHubCheckoutState.Type;

export const HotovoHubPeerThread = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  branch: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  capacity: Schema.optional(Schema.Literals(["personal", "shared"])),
});
export type HotovoHubPeerThread = typeof HotovoHubPeerThread.Type;

/** One hub project as provisioned on this environment. */
export const HotovoHubProjectState = Schema.Struct({
  project: HotovoHubProject,
  repositories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      branch: Schema.String,
      path: Schema.String,
      state: HotovoHubCheckoutState,
      error: Schema.optional(Schema.String),
      projectId: Schema.optional(ProjectId),
    }),
  ),
  tools: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      /** Required commands not found on this environment's PATH, with how to install them. */
      missing: Schema.Array(
        Schema.Struct({ command: Schema.String, install: Schema.optional(Schema.String) }),
      ),
    }),
  ),
  sharedCapacity: Schema.Struct({
    enabled: Schema.Boolean,
    instanceIds: Schema.Array(Schema.String),
    error: Schema.optional(Schema.String),
  }),
  /** Colleagues' environments working on this project right now. */
  peers: Schema.Array(
    Schema.Struct({
      member: Schema.String,
      name: Schema.String,
      environment: Schema.String,
      threads: Schema.Array(HotovoHubPeerThread),
      seenAt: Schema.String,
    }),
  ),
});
export type HotovoHubProjectState = typeof HotovoHubProjectState.Type;

export const HotovoHubStatus = Schema.Struct({
  hubUrl: Schema.NullOr(Schema.String),
  signedIn: Schema.Boolean,
  /** The account the member proved, e.g. "github:SemanS". */
  account: Schema.NullOr(Schema.String),
  member: Schema.NullOr(
    Schema.Struct({ id: Schema.String, name: Schema.String, roles: Schema.Array(Schema.String) }),
  ),
  hub: Schema.NullOr(
    Schema.Struct({
      name: Schema.String,
      displayName: Schema.String,
      currency: HotovoHubCurrency,
      revision: Schema.optional(Schema.String),
    }),
  ),
  /** Directory hub projects are checked out under, e.g. ~/Hotovo */
  workspaceRoot: Schema.String,
  companyKnowledge: Schema.NullOr(
    Schema.Struct({
      repository: Schema.String,
      path: Schema.String,
      state: HotovoHubCheckoutState,
      error: Schema.optional(Schema.String),
    }),
  ),
  projects: Schema.Array(HotovoHubProjectState),
  syncing: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type HotovoHubStatus = typeof HotovoHubStatus.Type;

export const HotovoHubSignInInput = Schema.Struct({
  hubUrl: TrimmedNonEmptyString,
  /** "github-cli" reads the token of this machine's `gh auth login`. */
  method: Schema.Literals(["github-cli", "token"]),
  kind: Schema.optional(Schema.Literals(["github", "bitbucket"])),
  token: Schema.optional(Schema.String),
});
export type HotovoHubSignInInput = typeof HotovoHubSignInInput.Type;

export const HotovoHubProjectInput = Schema.Struct({ projectId: TrimmedNonEmptyString });
export type HotovoHubProjectInput = typeof HotovoHubProjectInput.Type;

export const HotovoHubSharedCapacityInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type HotovoHubSharedCapacityInput = typeof HotovoHubSharedCapacityInput.Type;

export const HotovoHubProjectUsage = Schema.Struct({
  project: Schema.String,
  currency: HotovoHubCurrency,
  shared: Schema.NullOr(
    Schema.Struct({
      budget: Schema.Number,
      period: Schema.Literals(["day", "week", "month"]),
      spent: Schema.Number,
      members: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          name: Schema.String,
          allocation: Schema.NullOr(Schema.Number),
          spent: Schema.Number,
        }),
      ),
    }),
  ),
  /** Token totals peers reported for this period, personal and shared. */
  reported: Schema.Array(
    Schema.Struct({
      member: Schema.String,
      harness: Schema.String,
      capacity: Schema.Literals(["personal", "shared"]),
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cachedInputTokens: Schema.Number,
      costUsd: Schema.NullOr(Schema.Number),
    }),
  ),
});
export type HotovoHubProjectUsage = typeof HotovoHubProjectUsage.Type;

export class HotovoHubError extends Schema.TaggedError<HotovoHubError>()("HotovoHubError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
