import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Peer Hub: the workspace service a Peer environment signs in to.
 *
 * People sign in with their email address (a one-time code), then join the
 * workspaces their address qualifies for — by its domain or by an invite —
 * or create one. A workspace declares projects, their repositories, agent
 * tools, knowledge and AI capacity; this environment provisions them
 * locally. The manifest mirrors the hub's
 * `GET /v1/workspaces/{slug}/manifest` (version 2). Unknown fields from a
 * newer hub are ignored on decode.
 */

/** Agent runtime families a workspace project may allow, named as the hub names them. */
export const PeerHarness = Schema.Literals([
  "claude",
  "codex",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
]);
export type PeerHarness = typeof PeerHarness.Type;

export const PeerMcpServer = Schema.Union([
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
export type PeerMcpServer = typeof PeerMcpServer.Type;

export const PeerTool = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  mcp: PeerMcpServer,
  requires: Schema.Array(
    Schema.Struct({
      command: Schema.String,
      install: Schema.optional(Schema.String),
      docs: Schema.optional(Schema.String),
    }),
  ),
});
export type PeerTool = typeof PeerTool.Type;

export const PeerPersonalCapacityPolicy = Schema.Literals(["any", "commercial", "none"]);
export type PeerPersonalCapacityPolicy = typeof PeerPersonalCapacityPolicy.Type;

export const PeerCurrency = Schema.Literals(["EUR", "USD"]);
export type PeerCurrency = typeof PeerCurrency.Type;

export const PeerWorkspaceRole = Schema.Literals(["owner", "admin", "member"]);
export type PeerWorkspaceRole = typeof PeerWorkspaceRole.Type;

const BudgetPeriod = Schema.Literals(["day", "week", "month"]);

export const PeerProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  client: Schema.optional(Schema.String),
  role: Schema.Literals(["lead", "member"]),
  members: Schema.Array(Schema.Struct({ email: Schema.String, name: Schema.String })),
  /** The product's areas in order; tasks sit under them. */
  areas: Schema.optional(Schema.Array(Schema.String)),
  /** Who shared the project from Peer, when it is not in the workspace configuration. */
  addedBy: Schema.optional(Schema.String),
  repositories: Schema.Array(
    Schema.Struct({ id: Schema.String, url: Schema.String, branch: Schema.String }),
  ),
  knowledge: Schema.Struct({ kontext: Schema.Boolean, company: Schema.Boolean }),
  tools: Schema.Array(PeerTool),
  capacity: Schema.Struct({
    personal: PeerPersonalCapacityPolicy,
    /** Harnesses the member declared a qualifying seat for (informational for "commercial"). */
    personalHarnesses: Schema.Array(PeerHarness),
    shared: Schema.optional(
      Schema.Struct({
        pool: Schema.String,
        gatewayUrl: Schema.String,
        models: Schema.Array(
          Schema.Struct({ id: Schema.String, harness: Schema.Array(PeerHarness) }),
        ),
        budget: Schema.Struct({
          amount: Schema.Number,
          period: BudgetPeriod,
          currency: PeerCurrency,
        }),
        allocation: Schema.optional(Schema.Number),
        use: Schema.Array(Schema.Literals(["on-demand", "overflow", "automation"])),
      }),
    ),
  }),
});
export type PeerProject = typeof PeerProject.Type;

export const PeerManifest = Schema.Struct({
  version: Schema.Literal(2),
  workspace: Schema.Struct({
    slug: Schema.String,
    name: Schema.String,
    currency: PeerCurrency,
    revision: Schema.optional(Schema.String),
  }),
  member: Schema.Struct({
    email: Schema.String,
    name: Schema.String,
    role: PeerWorkspaceRole,
  }),
  knowledge: Schema.Struct({
    company: Schema.optional(
      Schema.Struct({ repository: Schema.String, branch: Schema.String, store: Schema.String }),
    ),
  }),
  projects: Schema.Array(PeerProject),
});
export type PeerManifest = typeof PeerManifest.Type;

export const PeerCheckoutState = Schema.Literals(["missing", "cloning", "ready", "error"]);
export type PeerCheckoutState = typeof PeerCheckoutState.Type;

export const PeerPresenceThread = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  branch: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  capacity: Schema.optional(Schema.Literals(["personal", "shared"])),
});
export type PeerPresenceThread = typeof PeerPresenceThread.Type;

/** What an agent thread is doing: ● working, ◐ blocked (needs an answer), ✓ done, ○ idle. */
export const PeerWorkStatus = Schema.Literals(["working", "blocked", "done", "idle", "unknown"]);
export type PeerWorkStatus = typeof PeerWorkStatus.Type;

/** A piece of the product being built, e.g. `KRK-812 · Split Payments` under "Groups & Events". */
export const PeerTask = Schema.Struct({
  id: Schema.String,
  /** The tracker's key; a branch or title naming it attaches the thread. */
  key: Schema.optional(Schema.String),
  title: Schema.String,
  area: Schema.optional(Schema.String),
  status: Schema.Literals(["open", "done"]),
  createdBy: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type PeerTask = typeof PeerTask.Type;

/** A colleague's (or another computer's) agent thread; the person is metadata, not a level. */
export const PeerWorkThread = Schema.Struct({
  id: Schema.String,
  task: Schema.optional(Schema.String),
  title: Schema.String,
  email: Schema.String,
  status: PeerWorkStatus,
  harness: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  source: Schema.Literals(["peer", "herdr"]),
  environment: Schema.String,
  seenAt: Schema.String,
});
export type PeerWorkThread = typeof PeerWorkThread.Type;

/** An agent herdr runs on this computer (https://herdr.dev), whatever started it. */
export const PeerLocalAgent = Schema.Struct({
  /** `herdr:<terminal id>`, stable while the terminal lives. */
  id: Schema.String,
  paneId: Schema.String,
  agent: Schema.optional(Schema.String),
  title: Schema.String,
  status: PeerWorkStatus,
  cwd: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  /** The workspace project whose checkout it runs in. */
  workspace: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
});
export type PeerLocalAgent = typeof PeerLocalAgent.Type;

/** One workspace project as provisioned on this environment. */
export const PeerProjectState = Schema.Struct({
  project: PeerProject,
  repositories: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      branch: Schema.String,
      path: Schema.String,
      state: PeerCheckoutState,
      error: Schema.optional(Schema.String),
      /** Signing in to GitHub, with an account that can open the repository, fixes the error. */
      gitHubSignIn: Schema.optional(Schema.Boolean),
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
  /**
   * The project's work: areas in order, tasks, and the threads other people and computers
   * report. This computer's own threads come live from its thread list.
   */
  work: Schema.Struct({
    areas: Schema.Array(Schema.String),
    tasks: Schema.Array(PeerTask),
    threads: Schema.Array(PeerWorkThread),
    /** This computer's threads (`peer:<thread id>`, `herdr:<terminal id>`) → task id. */
    assignments: Schema.Record(Schema.String, Schema.String),
  }),
  /** Colleagues' environments working on this project right now. */
  peers: Schema.Array(
    Schema.Struct({
      email: Schema.String,
      name: Schema.String,
      environment: Schema.String,
      threads: Schema.Array(PeerPresenceThread),
      seenAt: Schema.String,
    }),
  ),
});
export type PeerProjectState = typeof PeerProjectState.Type;

/** A workspace this member belongs to, with what it provisions here. */
export const PeerWorkspaceState = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  role: PeerWorkspaceRole,
  /** Addresses in these domains may join without an invite. */
  allowedDomains: Schema.Array(Schema.String),
  currency: PeerCurrency,
  /** Where the applied configuration came from, e.g. a registry commit. */
  revision: Schema.optional(Schema.String),
  memberName: Schema.String,
  companyKnowledge: Schema.NullOr(
    Schema.Struct({
      repository: Schema.String,
      path: Schema.String,
      state: PeerCheckoutState,
      error: Schema.optional(Schema.String),
    }),
  ),
  projects: Schema.Array(PeerProjectState),
  lastSyncAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type PeerWorkspaceState = typeof PeerWorkspaceState.Type;

/** A workspace this member may join: their address is in its domains, or they were invited. */
export const PeerJoinableWorkspace = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  allowedDomains: Schema.Array(Schema.String),
  reason: Schema.Literals(["domain", "invite"]),
});
export type PeerJoinableWorkspace = typeof PeerJoinableWorkspace.Type;

/**
 * What an agent about to change a file another agent on the project changed
 * is told: `notify` gives a heads-up, `coordinate` has it write the other
 * agent a note first, `ask` lets its person decide.
 */
export const PeerCoordinationPolicy = Schema.Literals(["notify", "coordinate", "ask"]);
export type PeerCoordinationPolicy = typeof PeerCoordinationPolicy.Type;

/** An agent session at work on a workspace project, as coordination sees it. */
export const PeerCoordSession = Schema.Struct({
  /** `claude:<session id>` */
  id: Schema.String,
  workspace: Schema.String,
  project: Schema.String,
  email: Schema.String,
  label: Schema.String,
  agent: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  status: PeerWorkStatus,
  /** Files it changed, relative to the repository. */
  files: Schema.Array(Schema.String),
  /** Files, or directories ending in `/`, it is about to change. */
  claims: Schema.Array(Schema.String),
  /** This computer runs it. */
  local: Schema.Boolean,
});
export type PeerCoordSession = typeof PeerCoordSession.Type;

/**
 * Two agent sessions changing the same files. Its notes are the one thing
 * both agents and both people read about it.
 */
export const PeerOverlap = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  project: Schema.String,
  sessions: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  state: Schema.Literals(["open", "resolved"]),
  resolution: Schema.optional(Schema.String),
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** The agent session that wrote it; none when a person did. */
      session: Schema.optional(Schema.String),
      email: Schema.String,
      text: Schema.String,
      at: Schema.String,
    }),
  ),
  updatedAt: Schema.String,
});
export type PeerOverlap = typeof PeerOverlap.Type;

/** Agents on the same project staying out of each other's way (experimental). */
export const PeerCoordinationState = Schema.Struct({
  enabled: Schema.Boolean,
  policy: PeerCoordinationPolicy,
  /** Claude Code runs Peer's coordination hooks. */
  claudeHooks: Schema.Boolean,
  /** Every coordination event, one JSON object per line. */
  logPath: Schema.String,
  sessions: Schema.Array(PeerCoordSession),
  overlaps: Schema.Array(PeerOverlap),
});
export type PeerCoordinationState = typeof PeerCoordinationState.Type;

/**
 * GitHub on this computer, through GitHub CLI: workspace repositories on
 * github.com clone with its account, and Peer signs in to it from the app.
 */
export const PeerGitHubState = Schema.Struct({
  /** GitHub CLI (`gh`) is installed. */
  cli: Schema.Boolean,
  /** GitHub CLI's active account on github.com, which clones use. */
  account: Schema.NullOr(Schema.String),
  /** A sign-in waiting for the person to enter this code at this address. */
  signIn: Schema.NullOr(Schema.Struct({ userCode: Schema.String, verificationUri: Schema.String })),
  /** Why the last sign-in failed. */
  error: Schema.NullOr(Schema.String),
});
export type PeerGitHubState = typeof PeerGitHubState.Type;

export const PeerHubStatus = Schema.Struct({
  /** The hub this environment signs in to (the default one until changed). */
  hubUrl: Schema.String,
  signedIn: Schema.Boolean,
  /** The verified address of the signed-in person. */
  email: Schema.NullOr(Schema.String),
  /** A code was mailed to this address and waits to be entered. */
  pendingSignIn: Schema.NullOr(
    Schema.Struct({
      email: Schema.String,
      sentAt: Schema.String,
      /** Only from a hub that echoes codes (local development and tests). */
      echoedCode: Schema.optional(Schema.String),
    }),
  ),
  workspaces: Schema.Array(PeerWorkspaceState),
  joinable: Schema.Array(PeerJoinableWorkspace),
  /** Directory workspace projects are checked out under, e.g. ~/Peer */
  workspaceRoot: Schema.String,
  /** This environment's server, so a client tells its own threads from everyone else's. */
  environmentId: Schema.String,
  /** Agents herdr runs on this computer, whether or not herdr is running. */
  agents: Schema.Struct({
    herdr: Schema.Literals(["running", "not-running"]),
    list: Schema.Array(PeerLocalAgent),
  }),
  github: PeerGitHubState,
  coordination: PeerCoordinationState,
  syncing: Schema.Boolean,
  lastSyncAt: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export type PeerHubStatus = typeof PeerHubStatus.Type;

export const PeerHubStartSignInInput = Schema.Struct({
  email: TrimmedNonEmptyString,
  /** Another hub than the current one, e.g. a company's own. */
  hubUrl: Schema.optional(TrimmedNonEmptyString),
});
export type PeerHubStartSignInInput = typeof PeerHubStartSignInInput.Type;

export const PeerHubFinishSignInInput = Schema.Struct({ code: TrimmedNonEmptyString });
export type PeerHubFinishSignInInput = typeof PeerHubFinishSignInInput.Type;

export const PeerHubCreateWorkspaceInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Email domains whose people may join without an invite; the creator must have an address there. */
  allowedDomains: Schema.Array(TrimmedNonEmptyString),
});
export type PeerHubCreateWorkspaceInput = typeof PeerHubCreateWorkspaceInput.Type;

export const PeerHubWorkspaceInput = Schema.Struct({ workspace: TrimmedNonEmptyString });
export type PeerHubWorkspaceInput = typeof PeerHubWorkspaceInput.Type;

export const PeerHubFindWorkspaceInput = Schema.Struct({ slug: TrimmedNonEmptyString });
export type PeerHubFindWorkspaceInput = typeof PeerHubFindWorkspaceInput.Type;

/**
 * A workspace looked up by its short name. Its domains show only to those it concerns (members
 * and people it admits), so a lookup never reveals whose workspace it is.
 */
export const PeerFoundWorkspace = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  role: Schema.NullOr(PeerWorkspaceRole),
  canJoin: Schema.Boolean,
  allowedDomains: Schema.Array(Schema.String),
});
export type PeerFoundWorkspace = typeof PeerFoundWorkspace.Type;

export const PeerHubInviteInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  role: Schema.optional(Schema.Literals(["admin", "member"])),
});
export type PeerHubInviteInput = typeof PeerHubInviteInput.Type;

export const PeerHubProjectInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
});
export type PeerHubProjectInput = typeof PeerHubProjectInput.Type;

export const PeerHubSharedCapacityInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type PeerHubSharedCapacityInput = typeof PeerHubSharedCapacityInput.Type;

export const PeerHubCreateTaskInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  key: Schema.optional(Schema.String),
  area: Schema.optional(Schema.String),
});
export type PeerHubCreateTaskInput = typeof PeerHubCreateTaskInput.Type;

export const PeerHubUpdateTaskInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  /** An empty string clears it. */
  area: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Literals(["open", "done"])),
});
export type PeerHubUpdateTaskInput = typeof PeerHubUpdateTaskInput.Type;

export const PeerHubTaskInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  taskId: TrimmedNonEmptyString,
});
export type PeerHubTaskInput = typeof PeerHubTaskInput.Type;

export const PeerHubAssignThreadInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  projectId: TrimmedNonEmptyString,
  /** `peer:<thread id>` or `herdr:<terminal id>`. */
  thread: TrimmedNonEmptyString,
  taskId: Schema.NullOr(TrimmedNonEmptyString),
});
export type PeerHubAssignThreadInput = typeof PeerHubAssignThreadInput.Type;

export const PeerHubSetCoordinationInput = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  policy: Schema.optional(PeerCoordinationPolicy),
  /** Add Peer's hooks to Claude Code's user settings, or take them out. */
  claudeHooks: Schema.optional(Schema.Boolean),
});
export type PeerHubSetCoordinationInput = typeof PeerHubSetCoordinationInput.Type;

export const PeerHubOverlapNoteInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  project: TrimmedNonEmptyString,
  overlap: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type PeerHubOverlapNoteInput = typeof PeerHubOverlapNoteInput.Type;

export const PeerHubResolveOverlapInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  project: TrimmedNonEmptyString,
  overlap: TrimmedNonEmptyString,
  resolution: TrimmedNonEmptyString,
});
export type PeerHubResolveOverlapInput = typeof PeerHubResolveOverlapInput.Type;

export const PeerHubFocusAgentInput = Schema.Struct({ paneId: TrimmedNonEmptyString });
export type PeerHubFocusAgentInput = typeof PeerHubFocusAgentInput.Type;

export const PeerHubShareProjectInput = Schema.Struct({
  workspace: TrimmedNonEmptyString,
  /** The local project whose repository the workspace gets... */
  projectId: Schema.optional(ProjectId),
  /** ...or a repository by its address: GitHub's `owner/repo` or a clone URL. */
  repository: Schema.optional(TrimmedNonEmptyString),
  name: Schema.optional(TrimmedNonEmptyString),
  areas: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type PeerHubShareProjectInput = typeof PeerHubShareProjectInput.Type;

export const PeerHubProjectUsage = Schema.Struct({
  project: Schema.String,
  currency: PeerCurrency,
  shared: Schema.NullOr(
    Schema.Struct({
      budget: Schema.Number,
      period: BudgetPeriod,
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
export type PeerHubProjectUsage = typeof PeerHubProjectUsage.Type;

export class PeerHubError extends Schema.TaggedError<PeerHubError>()("PeerHubError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
