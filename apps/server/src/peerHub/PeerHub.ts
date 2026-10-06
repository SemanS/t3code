// @effect-diagnostics nodeBuiltinImport:off - git subprocesses and checkout probes against the person's own disk.
/**
 * PeerHub — this environment's link to a Peer Hub and its workspaces.
 *
 * A person signs in with their email address (the hub mails a one-time
 * code), then joins the workspaces their address qualifies for — by its
 * domain or an invite — or creates one. Each workspace tells this environment
 * which projects to check out, which agent tools and knowledge they use, and
 * what shared AI capacity each one has. Provisioning stays local:
 * repositories are cloned with the person's own git credentials, projects are
 * ordinary T3 projects, and shared capacity becomes an ordinary provider
 * instance holding a per-member, per-project gateway key.
 *
 * Personal capacity never passes through here. The hub never sees provider
 * logins, and `hubPolicy` keeps hub-provisioned (shared) instances on their
 * own project and personal ones on projects that accept them.
 *
 * @module peerHub/PeerHub
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as MemoryContract from "@t3tools/contracts";

import {
  CommandId,
  PeerCoordinationPolicy,
  PeerHubError,
  PeerHubStatus,
  PeerJoinableWorkspace,
  PeerManifest,
  PeerWorkspaceRole,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  PeerAgentView,
  ThreadId,
  type PeerHubAgentInput,
  type PeerHubContextInput,
  type PeerHubContextVersionInput,
  type PeerHubCandidatesInput,
  type PeerHubDecideCandidateInput,
  type PeerHubCandidateInput,
  type PeerHubHarvestInput,
  type PeerKeptCandidate,
  type PeerKnowledgeCandidate,
  type PeerKnowledgeStatus,
  type PeerStagedEntry,
  type PeerContextVersion,
  type PeerContextVersionText,
  type PeerHubObserveInput,
  type PeerHubShareThreadInput,
  type PeerHubAssignThreadInput,
  type PeerHubCreateTaskInput,
  type PeerHubCreateWorkspaceInput,
  type PeerFoundWorkspace,
  type PeerHubFindWorkspaceInput,
  type PeerHubFinishSignInInput,
  type PeerHubFocusAgentInput,
  type PeerHubInviteInput,
  type PeerHubOverlapNoteInput,
  type PeerHubProjectInput,
  type PeerHubResolveOverlapInput,
  type PeerHubSettleOverlapInput,
  type PeerHubSetCoordinationInput,
  type PeerHubProjectUsage,
  type PeerHubPromptAgentInput,
  type PeerHubStartAgentInput,
  type PeerHubStartAgentResult,
  type PeerHubCoordEventsInput,
  type PeerHubStaleReadsInput,
  type PeerCoordEvent,
  type PeerStaleReads,
  type PeerHubShareProjectInput,
  type PeerHubSharedCapacityInput,
  type PeerHubStartSignInInput,
  type PeerHubTaskInput,
  type PeerHubUpdateTaskInput,
  type PeerHubWorkspaceInput,
  type PeerLocalAgent,
  type PeerPresenceThread,
  type PeerProject,
  type PeerProjectState,
  type PeerTask,
  type PeerWorkStatus,
  type PeerWorkContextText,
  type PeerWorkThread,
  type PeerWorkspaceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
import { explainCloneFailure, explainGitHubCloneFailure } from "./cloneFailure.ts";
import {
  claudeHookGroups,
  codexHookGroups,
  codexRules,
  codexTrustsPeerHooks,
  hasPeerHooks,
  settingsDiffer,
  taskNamed,
  withPeerHooks,
  withContextAccess,
} from "./coordination.ts";
import {
  CoordinationBroker,
  readJsonSettings,
  socketPathFits,
  writeJsonSettings,
  type CheckoutPlace,
} from "./coordinationBroker.ts";
import { GIT_ALLOWED_PROTOCOLS, isSafeGitRef, isSafeGitRemote } from "./gitSafety.ts";
import { idFromName } from "./names.ts";
import {
  activeGitHubAccount,
  gitHubCredentialHelper,
  gitHubCredentialOptions,
  gitHubRepository,
  startGitHubSignIn,
  type GitHubSignIn,
} from "./github.ts";
import * as AgentTranscript from "./agentTranscript.ts";
import * as Herdr from "./herdr.ts";
import * as ClaudeMod from "./claudeMod/install.ts";
import * as ClaudeModRuntime from "./claudeMod/runtime.ts";
import {
  boundedWorkReport,
  mergePullRequestEvidence,
  nativeRuntimePresent,
  nativeWorkPullRequests,
  pullRequestBatch,
  restoreWorkIdentity,
  WorkDeliveryTracker,
} from "./workLifecycle.ts";
import * as Knowledge from "./knowledge.ts";
import * as HubApi from "./hubApi.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as MemoryTransport from "./memory/MemoryTransport.ts";
import * as MemoryCli from "./memory/MemoryCli.ts";
import * as MemoryKnowledge from "./memory/knowledge.ts";
import {
  harnessForDriver,
  setHubPolicyState,
  type HubBoundProject,
  type HubSharedInstance,
} from "./hubPolicy.ts";

const SESSION_SECRET = "peer-hub-session";
/** The hub a fresh install signs in to; PEER_HUB_URL points a build or a machine elsewhere. */
const DEFAULT_HUB_URL = process.env.PEER_HUB_URL?.trim() || "https://hub.webinson.com";
const WORK_INTERVAL = "30 seconds";
/**
 * How often Peer reads herdr's agents when herdr sends no events, and when it
 * does (agents' titles change without an event).
 */
const HERDR_POLL_MS = 4_000;
const HERDR_RESYNC_MS = 15_000;
/** A change in herdr's agents reaches the hub at most this often. */
const HERDR_REPORT_GAP_MS = 2_000;
const MANIFEST_INTERVAL = "10 minutes";
const GIT_TIMEOUT_MS = 15 * 60 * 1000;

const PersistedWorkspace = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  role: PeerWorkspaceRole,
  allowedDomains: Schema.Array(Schema.String),
  manifest: Schema.NullOr(PeerManifest),
  lastSyncAt: Schema.NullOr(Schema.String),
});
type PersistedWorkspace = typeof PersistedWorkspace.Type;

const PersistedState = Schema.Struct({
  hubUrl: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  pendingSignIn: Schema.NullOr(
    Schema.Struct({
      email: Schema.String,
      sentAt: Schema.String,
      echoedCode: Schema.optional(Schema.String),
    }),
  ),
  workspaces: Schema.Array(PersistedWorkspace),
  joinable: Schema.Array(PeerJoinableWorkspace),
  lastSyncAt: Schema.NullOr(Schema.String),
  /** "workspace/project" → provider instances this environment provisioned for its shared capacity. */
  sharedInstances: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  /** Address → workspaces that person left on this computer; signing in does not rejoin them. */
  leftWorkspaces: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** This computer's threads (`peer:<thread id>`, `herdr:<terminal id>`) → the task they work on. */
  assignments: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Struct({ workspace: Schema.String, project: Schema.String, task: Schema.String }),
    ),
  ),
  /** "workspace/project/repository" → a checkout this computer shared from where it already was. */
  localCheckouts: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Agents on the same project staying out of each other's way, on this computer (experimental). */
  coordination: Schema.optional(
    Schema.Struct({ enabled: Schema.Boolean, policy: PeerCoordinationPolicy }),
  ),
  /** This computer's threads (`peer:…`, `herdr:…`) whose owner lets the team watch them. */
  sharedThreads: Schema.optional(Schema.Array(Schema.String)),
});
type PersistedState = typeof PersistedState.Type;

const decodePersisted = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedState));
const encodePersisted = Schema.encodeSync(Schema.fromJsonString(PersistedState));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(PeerHubStatus));

const EMPTY_PERSISTED: PersistedState = {
  hubUrl: null,
  email: null,
  pendingSignIn: null,
  workspaces: [],
  joinable: [],
  lastSyncAt: null,
  sharedInstances: {},
};

interface Transient {
  readonly state: "cloning" | "error";
  readonly error?: string;
  /** Signing in to GitHub with an account that can open the repository fixes the error. */
  readonly gitHubSignIn?: boolean;
}

/** GitHub CLI on this computer, as last read. */
interface GitHubRuntime {
  /** Where `gh` is installed. */
  readonly cli: string | null;
  readonly account: string | null;
  readonly signIn: { readonly userCode: string; readonly verificationUri: string } | null;
  readonly error: string | null;
}

interface RuntimeState {
  readonly persisted: PersistedState;
  readonly syncing: boolean;
  readonly error: string | null;
  /** Workspace slug → why its last manifest refresh failed. */
  readonly workspaceErrors: ReadonlyMap<string, string>;
  /** Checkout path → an in-flight clone or its failure. */
  readonly checkouts: ReadonlyMap<string, Transient>;
  /** Workspace slug → its knowledge clone in flight or failed. */
  readonly knowledge: ReadonlyMap<string, Transient>;
  /** "workspace/project" → why its shared capacity could not be turned on. */
  readonly sharedErrors: ReadonlyMap<string, string>;
  /** "workspace/project" → its areas, tasks and other environments' threads, as the hub last said. */
  readonly work: ReadonlyMap<string, ProjectWork>;
  /** What herdr runs on this computer; null while no herdr server listens. */
  readonly herdr: ReadonlyArray<HerdrAgentState> | null;
  readonly github: GitHubRuntime;
}

interface ProjectWork {
  readonly areas: ReadonlyArray<string>;
  readonly tasks: ReadonlyArray<PeerTask>;
  readonly threads: ReadonlyArray<PeerWorkThread>;
}

interface HerdrAgentState extends Herdr.HerdrAgent {
  readonly branch: string | undefined;
  readonly postHocPaths?: ReadonlyArray<string>;
  readonly postHocPathsTruncated?: number;
  readonly place?: {
    readonly workspace: string;
    readonly projectId: string;
    readonly repositoryId: string;
  };
}

/**
 * What Peer shows and reports of herdr's agents, to tell a change from a re-read.
 * The completion is in it because a turn can start and finish between two reads
 * and leave the state as it was.
 */
function herdrSignature(
  agents: ReadonlyArray<HerdrAgentState> | null,
  keyOf: (agent: HerdrAgentState) => string,
): string {
  if (agents === null) return "";
  return agents
    .map((a) =>
      [keyOf(a), a.paneId, a.status, a.completionSeq, a.title, a.cwd, a.branch].join("\u0000"),
    )
    .toSorted()
    .join("\u0001");
}

const sameAgentView = Schema.toEquivalence(PeerAgentView);

const ACTIVE_RUN_STATES: ReadonlySet<string> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** A thread's state as the work view shows it: ◐ blocked on an answer, ● working, ✓ done, ○ idle. */
function shellStatus(thread: {
  readonly status: string;
  readonly activityRunStatus?: string | null | undefined;
  readonly pendingRuntimeRequest: unknown;
  readonly settledAt: unknown;
}): PeerWorkStatus {
  if (thread.pendingRuntimeRequest !== null) return "blocked";
  if (ACTIVE_RUN_STATES.has(thread.activityRunStatus ?? thread.status)) return "working";
  return thread.settledAt !== null ? "done" : "idle";
}

/** Colleagues' environments that have a thread working or blocked, for "Working now". */
function peersOf(
  threads: ReadonlyArray<PeerWorkThread>,
  names: ReadonlyMap<string, string>,
): PeerProjectState["peers"] {
  const byEnvironment = new Map<
    string,
    {
      email: string;
      name: string;
      environment: string;
      threads: PeerPresenceThread[];
      seenAt: string;
    }
  >();
  for (const thread of threads) {
    if (thread.status !== "working" && thread.status !== "blocked") continue;
    const key = `${thread.email} ${thread.environment}`;
    const entry = byEnvironment.get(key) ?? {
      email: thread.email,
      name: names.get(thread.email) ?? thread.email,
      environment: thread.environment,
      threads: [],
      seenAt: thread.seenAt,
    };
    entry.threads.push({
      title: thread.title,
      status: thread.status,
      ...(thread.branch === undefined ? {} : { branch: thread.branch }),
      ...(thread.harness === undefined ? {} : { harness: thread.harness }),
    });
    if (thread.seenAt > entry.seenAt) entry.seenAt = thread.seenAt;
    byEnvironment.set(key, entry);
  }
  return [...byEnvironment.values()];
}

export class PeerHub extends Context.Service<
  PeerHub,
  {
    readonly status: Effect.Effect<PeerHubStatus>;
    readonly memoryQueue: (
      input: MemoryContract.PeerMemoryScope,
    ) => Effect.Effect<MemoryContract.PeerMemoryQueue, PeerHubError>;
    readonly memoryRetry: (
      input: MemoryContract.PeerHubMemoryRetryInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryWriteResult, PeerHubError>;
    readonly memoryDiscard: (
      input: MemoryContract.PeerHubMemoryDiscardInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryDiscarded, PeerHubError>;
    readonly memoryState: (
      input: MemoryContract.PeerMemoryScope,
    ) => Effect.Effect<MemoryContract.PeerMemoryState, PeerHubError>;
    readonly memoryMode: (
      input: MemoryContract.PeerMemoryScope,
    ) => Effect.Effect<{ readonly mode: MemoryContract.PeerMemoryMode }, PeerHubError>;
    readonly memorySetMode: (
      input: MemoryContract.PeerHubMemorySetModeInput,
    ) => Effect.Effect<{ readonly mode: MemoryContract.PeerMemoryMode }, PeerHubError>;
    readonly memoryExecute: (
      input: MemoryContract.PeerHubMemoryExecuteInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryWriteResult, PeerHubError>;
    readonly memorySearch: (
      input: MemoryContract.PeerHubMemorySearchInput,
    ) => Effect.Effect<MemoryContract.PeerMemorySearchResult, PeerHubError>;
    readonly memoryRead: (
      input: MemoryContract.PeerHubMemoryReadInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryRecordView, PeerHubError>;
    readonly memoryProject: (
      input: MemoryContract.PeerHubMemoryProjectInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryProjection, PeerHubError>;
    readonly memoryChanges: (
      input: MemoryContract.PeerHubMemoryChangesInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryChanges, PeerHubError>;
    readonly memoryReceipts: (
      input: MemoryContract.PeerHubMemoryReceiptsInput,
    ) => Effect.Effect<
      { readonly receipts: ReadonlyArray<MemoryContract.PeerMemoryReceipt> },
      PeerHubError
    >;
    readonly memoryKeep: (
      input: MemoryContract.PeerHubMemoryKeepInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryKept, PeerHubError>;
    readonly memoryImportKnowledge: (
      input: MemoryContract.PeerHubMemoryImportKnowledgeInput,
    ) => Effect.Effect<
      { readonly operations: ReadonlyArray<MemoryContract.PeerMemoryWriteResult> },
      PeerHubError
    >;
    readonly memoryAgent: (
      nativeSessionId: string,
    ) => Effect.Effect<MemoryService.MemorySession, PeerHubError>;
    readonly memoryRuntime: (
      threadId: ThreadId,
      providerSessionId: string,
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<MemoryService.MemorySession, PeerHubError>;
    readonly memoryAgentContext: (
      nativeSessionId: string,
      action: "notice" | "checkpoint",
      reason?: string,
    ) => Effect.Effect<{ readonly text: string }, PeerHubError>;
    readonly memoryAgentExecute: (
      nativeSessionId: string,
      input: MemoryContract.PeerHubMemoryExecuteInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryWriteResult, PeerHubError>;
    readonly memoryAgentProject: (
      nativeSessionId: string,
      input: MemoryContract.PeerHubMemoryProjectInput,
    ) => Effect.Effect<MemoryContract.PeerMemoryProjection, PeerHubError>;
    readonly memoryAgentReceipt: (
      nativeSessionId: string,
      input: Omit<
        MemoryContract.PeerMemoryReceiptInput,
        "sessionId" | "environmentId" | "runtimeGeneration" | "runtimeProjectId"
      > & { readonly workspace?: string | undefined; readonly project?: string | undefined },
    ) => Effect.Effect<MemoryContract.PeerMemoryReceipt, PeerHubError>;
    /** The current status followed by every change. */
    readonly streamStatus: Stream.Stream<PeerHubStatus>;
    /** Mails a sign-in code to the address. */
    readonly startSignIn: (
      input: PeerHubStartSignInInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly finishSignIn: (
      input: PeerHubFinishSignInInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** Also cancels a sign-in waiting for its code. */
    readonly signOut: Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly sync: Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly createWorkspace: (
      input: PeerHubCreateWorkspaceInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly joinWorkspace: (
      input: PeerHubWorkspaceInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly leaveWorkspace: (
      input: PeerHubWorkspaceInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly invite: (input: PeerHubInviteInput) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A workspace by its short name (null when there is none), to join it by name. */
    readonly findWorkspace: (
      input: PeerHubFindWorkspaceInput,
    ) => Effect.Effect<PeerFoundWorkspace | null, PeerHubError>;
    /** Clones the project's repositories (in the background) and registers them as projects. */
    readonly openProject: (
      input: PeerHubProjectInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** Starts signing GitHub CLI in to GitHub; the status carries the code to enter. */
    readonly connectGitHub: Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly cancelGitHubSignIn: Effect.Effect<PeerHubStatus>;
    /** Agent coordination on or off, its policy, and Peer's hooks in Claude Code and Codex. */
    readonly setCoordination: (
      input: PeerHubSetCoordinationInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A person's note on an overlap; both agents hear it. */
    readonly noteOverlap: (
      input: PeerHubOverlapNoteInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly resolveOverlap: (
      input: PeerHubResolveOverlapInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A person asks the agents on an overlap to settle it between them and close it. */
    readonly settleOverlap: (
      input: PeerHubSettleOverlapInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly setSharedCapacity: (
      input: PeerHubSharedCapacityInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly projectUsage: (
      input: PeerHubProjectInput,
    ) => Effect.Effect<PeerHubProjectUsage, PeerHubError>;
    /** Any member of a project adds, changes and closes its tasks. */
    readonly createTask: (
      input: PeerHubCreateTaskInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly updateTask: (
      input: PeerHubUpdateTaskInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly deleteTask: (input: PeerHubTaskInput) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** Puts one of this computer's threads under a task, or under none. */
    readonly assignThread: (
      input: PeerHubAssignThreadInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** Brings a herdr agent's pane forward in herdr. */
    readonly focusAgent: (
      input: PeerHubFocusAgentInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A herdr agent's work as it happens: its view now, then each change. */
    readonly watchAgent: (input: PeerHubAgentInput) => Stream.Stream<PeerAgentView>;
    /** Sends one of this computer's herdr agents a prompt, as if typed in its terminal. */
    readonly promptAgent: (
      input: PeerHubPromptAgentInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** Starts a task agent in its own checkout and assigns its durable work identity. */
    readonly startAgent: (
      input: PeerHubStartAgentInput,
    ) => Effect.Effect<PeerHubStartAgentResult, PeerHubError>;
    readonly getCoordEvents: (
      input: PeerHubCoordEventsInput,
    ) => Effect.Effect<ReadonlyArray<PeerCoordEvent>, PeerHubError>;
    readonly getStaleReads: (
      input: PeerHubStaleReadsInput,
    ) => Effect.Effect<PeerStaleReads, PeerHubError>;
    /** Lets the team watch one of this computer's threads live, or stops it. */
    readonly shareThread: (
      input: PeerHubShareThreadInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A colleague's shared thread as it happens, relayed by the hub while you watch. */
    readonly observeThread: (
      input: PeerHubObserveInput,
    ) => Stream.Stream<PeerAgentView, PeerHubError>;
    /** A task's shared context with its text; null when it has none yet. */
    readonly readContext: (
      input: PeerHubContextInput,
    ) => Effect.Effect<PeerWorkContextText | null, PeerHubError>;
    /** The versions of a shared context the hub keeps, newest first. */
    readonly contextVersions: (
      input: PeerHubContextInput,
    ) => Effect.Effect<ReadonlyArray<PeerContextVersion>, PeerHubError>;
    readonly readContextVersion: (
      input: PeerHubContextVersionInput,
    ) => Effect.Effect<PeerContextVersionText | null, PeerHubError>;
    /** Brings an older version of a shared context back; its keeper goes on from it. */
    readonly restoreContext: (
      input: PeerHubContextVersionInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** What agents found that a project may want to keep, weighed by independent finders. */
    readonly knowledgeCandidates: (
      input: PeerHubCandidatesInput,
    ) => Effect.Effect<ReadonlyArray<PeerKnowledgeCandidate>, PeerHubError>;
    /** A person dismisses a knowledge candidate, promotes it, or proposes it again. */
    readonly decideCandidate: (
      input: PeerHubDecideCandidateInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    /** A project's knowledge on this computer: its checkout, kontext there, its guidance for agents. */
    readonly knowledgeStatus: (
      input: PeerHubCandidatesInput,
    ) => Effect.Effect<PeerKnowledgeStatus, PeerHubError>;
    /** Runs `kontext init` in the project's checkout here. */
    readonly setupKnowledge: (
      input: PeerHubCandidatesInput,
    ) => Effect.Effect<PeerKnowledgeStatus, PeerHubError>;
    /** Writes a candidate into the project's knowledge, staged, and marks it kept for everyone. */
    readonly keepCandidate: (
      input: PeerHubCandidateInput,
    ) => Effect.Effect<PeerKeptCandidate, PeerHubError>;
    /** Reads a shared context with kontext for what the project should keep, and proposes it. */
    readonly harvestContext: (
      input: PeerHubHarvestInput,
    ) => Effect.Effect<{ readonly proposed: number }, PeerHubError>;
    /** Proposes the project's guidance for its agents from what people kept and dismissed. */
    readonly improveGuidance: (
      input: PeerHubCandidatesInput,
    ) => Effect.Effect<PeerStagedEntry, PeerHubError>;
    /** Shares a local project's repository with a workspace, as a project everyone works on. */
    readonly shareProject: (
      input: PeerHubShareProjectInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly unshareProject: (
      input: PeerHubProjectInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
  }
>()("t3/peerHub/PeerHub") {}

/** Workspace projects are checked out under ~/Peer/<workspace>/<project>/<repository> unless PEER_WORKSPACE says otherwise. */
function resolveWorkspaceRoot(): string {
  const configured = process.env.PEER_WORKSPACE?.trim();
  if (configured) return NodePath.resolve(configured.replace(/^~(?=$|\/)/, NodeOS.homedir()));
  return NodePath.join(NodeOS.homedir(), "Peer");
}

/** Ids from the hub become directory names; anything but kebab-case is refused. */
function safeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);
}

const sharedKey = (workspace: string, projectId: string) => `${workspace}/${projectId}`;

function sharedInstanceId(workspace: string, projectId: string): ProviderInstanceId {
  const id = `peer-${workspace}-${projectId}-claude`;
  if (id.length <= 64) return ProviderInstanceId.make(id);
  const digest = NodeCrypto.createHash("sha256")
    .update(sharedKey(workspace, projectId))
    .digest("hex");
  return ProviderInstanceId.make(`peer-${digest.slice(0, 16)}-claude`);
}

function hasGitCheckout(path: string): boolean {
  return NodeFS.existsSync(NodePath.join(path, ".git"));
}

function realpathOrSelf(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return path;
  }
}

/** Directories on PATH plus the usual install locations a Dock-launched app may miss. */
/** A directory as the file system knows it (macOS keeps /var under /private). */
function realDirectory(path: string): string {
  try {
    return NodeFS.realpathSync(path);
  } catch {
    return NodePath.resolve(path);
  }
}

function searchPath(): string[] {
  const extra = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    NodePath.join(NodeOS.homedir(), ".local", "bin"),
    NodePath.join(NodeOS.homedir(), ".cargo", "bin"),
  ];
  return [...(process.env.PATH ?? "").split(NodePath.delimiter), ...extra].filter(Boolean);
}

function commandAvailable(command: string): boolean {
  if (command.includes("/")) return NodeFS.existsSync(command);
  return commandPath(command) !== null;
}

/** Where `command` is installed, looked up the way `run` finds it. */
function commandPath(command: string): string | null {
  for (const dir of searchPath()) {
    const candidate = NodePath.join(dir, command);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return null;
}

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    /** Its output as printed, not trimmed: `git status --porcelain` starts lines with a space. */
    readonly raw?: boolean;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          PATH: searchPath().join(NodePath.delimiter),
          GIT_TERMINAL_PROMPT: "0",
          // No transport helpers (`ext::`), whatever an address says.
          GIT_ALLOW_PROTOCOL: GIT_ALLOWED_PROTOCOLS,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          // The message is the last lines; the cause keeps all of it for explaining the failure.
          const output = (stderr || error.message).trim();
          reject(new Error(output.split("\n").slice(-3).join(" "), { cause: output }));
        } else {
          resolve(options.raw === true ? stdout : stdout.trim());
        }
      },
    );
  });
}

/** Everything a rejected `run` printed. */
function runOutput(failure: unknown): string {
  if (!(failure instanceof Error)) return String(failure);
  return typeof failure.cause === "string" ? failure.cause : failure.message;
}

function normalizeHubUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(trimmed) ? trimmed : null;
}

const hubError = (detail: string) => new PeerHubError({ detail });

/** Records (or forgets) that `email` left `slug` here, so signing in again does not rejoin it. */
function markLeft(persisted: PersistedState, email: string | null, slug: string, left: boolean) {
  if (email === null) return persisted;
  const current = (persisted.leftWorkspaces?.[email] ?? []).filter((s) => s !== slug);
  return {
    ...persisted,
    leftWorkspaces: { ...persisted.leftWorkspaces, [email]: left ? [...current, slug] : current },
  };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const settings = yield* Settings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const hubApi = yield* HubApi.make;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const layerScope = yield* Effect.scope;

  const statePath = NodePath.join(config.stateDir, "peer-hub.json");
  const hubHome = NodePath.join(config.baseDir, "hub");
  const knowledgePath = (workspace: string) => NodePath.join(hubHome, workspace, "knowledge");
  const workspaceRoot = resolveWorkspaceRoot();
  const repoPath = (workspace: string, projectId: string, repoId: string) =>
    NodePath.join(workspaceRoot, workspace, projectId, repoId);
  /** Where a repository lives here: where it was shared from, or under the workspace root. */
  const checkoutPath = (
    persisted: PersistedState,
    workspace: string,
    projectId: string,
    repoId: string,
  ) =>
    persisted.localCheckouts?.[`${workspace}/${projectId}/${repoId}`] ??
    repoPath(workspace, projectId, repoId);

  const loadPersisted = Effect.tryPromise(() => NodeFSP.readFile(statePath, "utf8")).pipe(
    Effect.map((text) => Option.getOrElse(decodePersisted(text), () => EMPTY_PERSISTED)),
    Effect.orElseSucceed(() => EMPTY_PERSISTED),
  );

  const stateRef = yield* Ref.make<RuntimeState>({
    persisted: yield* loadPersisted,
    syncing: false,
    error: null,
    workspaceErrors: new Map(),
    checkouts: new Map(),
    knowledge: new Map(),
    sharedErrors: new Map(),
    work: new Map(),
    herdr: null,
    github: { cli: null, account: null, signIn: null, error: null },
  });
  const statusRef = yield* Ref.make<PeerHubStatus | null>(null);
  const herdrReportsSkipped = new Map<string, number>();
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<PeerHubStatus>(), PubSub.shutdown);
  // Mutations of hub state run one at a time; background clones only touch their own checkout.
  const lock = yield* Semaphore.make(1);
  /** cwd → its git branch, refreshed every 30 s, for herdr agents. */
  const branches = new Map<string, { readonly branch: string | undefined; readonly at: number }>();

  // Agents on the same project staying out of each other's way (experimental): Peer's scripts
  // for agents, the socket they talk to, and the log of every coordination event.
  const coordinationDir = NodePath.join(config.stateDir, "coord");
  const preferredSocket = NodePath.join(config.stateDir, "coord.sock");
  const coordinationSocket = socketPathFits(preferredSocket)
    ? preferredSocket
    : NodePath.join(
        NodeOS.tmpdir(),
        `peer-coord-${NodeCrypto.createHash("sha256").update(config.stateDir).digest("hex").slice(0, 12)}.sock`,
      );
  const coordinationLog = NodePath.join(config.logsDir, "coordination.jsonl");
  const claudeSettingsPath = NodePath.join(
    process.env.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(NodeOS.homedir(), ".claude"),
    "settings.json",
  );
  /** Agents' working contexts, one file per session (experimental). */
  const coordinationContexts = NodePath.join(coordinationDir, "contexts");
  /** Codex's home: its hooks.json (Claude Code's shape), its config.toml and its rules. */
  const codexHome = process.env.CODEX_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".codex");
  const codexHooksPath = NodePath.join(codexHome, "hooks.json");
  const codexRulesPath = NodePath.join(codexHome, "rules", "peer.rules");
  const peerCommand = NodePath.join(coordinationDir, "bin", "peer");
  /** Peer's rule for its own command in Codex: added with its hooks, taken out with them. */
  const writeCodexRules = (install: boolean) =>
    install
      ? NodeFSP.mkdir(NodePath.dirname(codexRulesPath), { recursive: true }).then(() =>
          NodeFSP.writeFile(codexRulesPath, codexRules(peerCommand)),
        )
      : NodeFSP.rm(codexRulesPath, { force: true });
  /** Whether Codex runs Peer's hooks yet: its person trusts them in Codex. Read when its files change. */
  let codexTrust = { stamp: "", trusted: false };
  const codexTrusts = () => {
    const read = (path: string) => {
      try {
        return NodeFS.readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    const configPath = NodePath.join(codexHome, "config.toml");
    const stamp = [codexHooksPath, configPath]
      .map((path) => {
        try {
          return String(NodeFS.statSync(path).mtimeMs);
        } catch {
          return "-";
        }
      })
      .join(":");
    if (stamp !== codexTrust.stamp) {
      let hooks: Record<string, unknown> = {};
      try {
        hooks = JSON.parse(read(codexHooksPath) || "{}") as Record<string, unknown>;
      } catch {
        hooks = {};
      }
      codexTrust = {
        stamp,
        trusted: codexTrustsPeerHooks(hooks, codexHooksPath, read(configPath), coordinationDir),
      };
    }
    return codexTrust.trusted;
  };
  const peerScripts = {
    hook: NodePath.join(coordinationDir, "hook"),
    wait: NodePath.join(coordinationDir, "wait"),
  };
  let broker: CoordinationBroker | null = null;
  const claudeSettings = yield* Effect.promise(() => readJsonSettings(claudeSettingsPath));
  let claudeHooksInstalled = hasPeerHooks(claudeSettings ?? {}, coordinationDir);
  const claudeModDir = ClaudeMod.peerClaudeModPath(coordinationDir);
  const claudeEnv = claudeSettings?.env;
  const pluginDirs =
    typeof claudeEnv === "object" && claudeEnv !== null
      ? (claudeEnv as Record<string, unknown>).CLAUDE_CODE_PLUGIN_DIRS
      : undefined;
  let claudeModInstalled =
    typeof pluginDirs === "string" && pluginDirs.split(NodePath.delimiter).includes(claudeModDir);
  if (claudeModInstalled) {
    yield* Effect.tryPromise(() =>
      ClaudeMod.writeClaudeMod({
        directory: claudeModDir,
        socketPath: coordinationSocket,
        peerScript: peerCommand,
      }),
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          claudeModInstalled = false;
        }),
      ),
    );
  }
  ClaudeModRuntime.setClaudeModDirectory(claudeModInstalled ? claudeModDir : undefined);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => ClaudeModRuntime.setClaudeModDirectory(undefined)),
  );
  // Hooks an older Peer installed get this Peer's: new events, and agents let into their contexts.
  const currentHooks =
    claudeSettings === null || (!claudeHooksInstalled && !claudeModInstalled)
      ? null
      : withContextAccess(
          withPeerHooks(
            claudeSettings,
            claudeHookGroups(peerScripts),
            coordinationDir,
            !claudeModInstalled,
          ),
          coordinationContexts,
          true,
        );
  if (
    currentHooks !== null &&
    claudeSettings !== null &&
    settingsDiffer(currentHooks, claudeSettings)
  ) {
    yield* Effect.promise(() =>
      writeJsonSettings(claudeSettingsPath, currentHooks).catch(() => undefined),
    );
  }
  if (claudeModInstalled) claudeHooksInstalled = false;
  const codexHooks = yield* Effect.promise(() => readJsonSettings(codexHooksPath));
  let codexHooksInstalled = hasPeerHooks(codexHooks ?? {}, coordinationDir);
  // The same for Codex; a hook that changes asks its person to trust it again.
  const currentCodexHooks =
    codexHooks === null || !codexHooksInstalled
      ? null
      : withPeerHooks(codexHooks, codexHookGroups(peerScripts), coordinationDir, true);
  if (
    currentCodexHooks !== null &&
    codexHooks !== null &&
    settingsDiffer(currentCodexHooks, codexHooks)
  ) {
    yield* Effect.promise(() =>
      writeJsonSettings(codexHooksPath, currentCodexHooks).catch(() => undefined),
    );
  }
  if (codexHooksInstalled) {
    yield* Effect.promise(() => writeCodexRules(true).catch(() => undefined));
  }

  const persist = (persisted: PersistedState) =>
    Effect.tryPromise(async () => {
      await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
      const temp = `${statePath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temp, `${encodePersisted(persisted)}\n`, { mode: 0o600 });
      await NodeFSP.rename(temp, statePath);
    }).pipe(Effect.mapError(() => hubError("Could not save the workspace state.")));

  const updatePersisted = (f: (p: PersistedState) => PersistedState) =>
    Effect.gen(function* () {
      const next = f((yield* Ref.get(stateRef)).persisted);
      yield* persist(next);
      yield* Ref.update(stateRef, (s) => ({ ...s, persisted: next }));
    });

  const updateRuntime = (f: (s: RuntimeState) => RuntimeState) => Ref.update(stateRef, f);

  const readSession = secrets.get(SESSION_SECRET).pipe(
    Effect.map(Option.map((bytes) => Buffer.from(bytes).toString("utf8"))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const hubUrlOf = (persisted: PersistedState) => persisted.hubUrl ?? DEFAULT_HUB_URL;

  const requireSession = Effect.gen(function* () {
    const { persisted } = yield* Ref.get(stateRef);
    const session = yield* readSession;
    if (persisted.email === null || Option.isNone(session)) {
      return yield* hubError("Sign in first.");
    }
    return { hubUrl: hubUrlOf(persisted), session: session.value };
  });

  const memoryFailure = (error: MemoryTransport.MemoryError) =>
    new PeerHubError({ detail: error.detail });
  const appMemorySessions = new Map<
    string,
    {
      session: MemoryService.MemorySession;
      threadId: ThreadId;
      providerInstanceId: ProviderInstanceId;
      label: string;
    }
  >();
  const memoryAuth = MemoryTransport.MemoryAuth.of({
    identity: requireSession.pipe(
      Effect.map(({ hubUrl, session }) => ({
        hubUrl,
        token: session,
        email: currentState().persisted.email!,
        environmentId,
      })),
      Effect.mapError(
        (error) => new MemoryTransport.MemoryError({ code: "not_found", detail: error.detail }),
      ),
    ),
    repository: (scope, repositoryId) =>
      Effect.gen(function* () {
        const { hubUrl, session } = yield* requireSession.pipe(
          Effect.mapError(
            (error) => new MemoryTransport.MemoryError({ code: "not_found", detail: error.detail }),
          ),
        );
        const manifest = yield* hubApi
          .manifest(hubUrl, session, scope.workspace)
          .pipe(
            Effect.mapError(
              (error) =>
                new MemoryTransport.MemoryError({ code: "not_found", detail: error.detail }),
            ),
          );
        if (!safeId(scope.workspace) || !safeId(scope.project))
          return yield* new MemoryTransport.MemoryError({
            code: "not_found",
            detail: "The memory repository is unavailable.",
          });
        if (scope.project === "company") {
          const company = manifest.knowledge.company;
          if (repositoryId !== "company" || company === undefined)
            return yield* new MemoryTransport.MemoryError({
              code: "not_found",
              detail: "The company knowledge repository is unavailable.",
            });
          return { root: knowledgePath(scope.workspace), branch: company.branch };
        }
        const project = manifest.projects.find((candidate) => candidate.id === scope.project);
        const repository = project?.repositories.find((candidate) => candidate.id === repositoryId);
        if (repository === undefined || !safeId(repository.id))
          return yield* new MemoryTransport.MemoryError({
            code: "not_found",
            detail: "The memory repository is unavailable.",
          });
        return {
          root: checkoutPath(
            currentState().persisted,
            scope.workspace,
            scope.project,
            repository.id,
          ),
          branch: repository.branch,
        };
      }),
  });
  const memoryAuthLayer = Layer.succeed(MemoryTransport.MemoryAuth, memoryAuth);
  const memory = yield* MemoryService.MemoryService.pipe(
    Effect.provide(
      MemoryService.layer.pipe(
        Layer.provide(MemoryTransport.layer),
        Layer.provide(memoryAuthLayer),
      ),
    ),
  );
  const memoryCli = yield* MemoryCli.MemoryCli.pipe(
    Effect.provide(
      MemoryCli.layer.pipe(Layer.provide(Layer.succeed(MemoryService.MemoryService, memory))),
    ),
  );
  const memoryQueue: PeerHub["Service"]["memoryQueue"] = (input) =>
    memory.queue(input).pipe(Effect.mapError(memoryFailure));
  const memoryRetry: PeerHub["Service"]["memoryRetry"] = (input) =>
    memory.retry(input).pipe(Effect.mapError(memoryFailure));
  const memoryDiscard: PeerHub["Service"]["memoryDiscard"] = (input) =>
    memory.discard(input).pipe(Effect.mapError(memoryFailure));
  const memoryState: PeerHub["Service"]["memoryState"] = (input) =>
    memory.synchronize(input).pipe(Effect.mapError(memoryFailure));
  const memoryMode: PeerHub["Service"]["memoryMode"] = (input) =>
    memory.mode(input).pipe(Effect.mapError(memoryFailure));
  const memorySetMode: PeerHub["Service"]["memorySetMode"] = (input) =>
    memory.setMode(input).pipe(Effect.mapError(memoryFailure));
  const memorySearch: PeerHub["Service"]["memorySearch"] = (input) =>
    memory.search(input).pipe(Effect.mapError(memoryFailure));
  const memoryRead: PeerHub["Service"]["memoryRead"] = (input) =>
    memory.read(input).pipe(Effect.mapError(memoryFailure));
  const memoryProject: PeerHub["Service"]["memoryProject"] = (input) =>
    memory.project(input).pipe(Effect.mapError(memoryFailure));
  const memoryChanges: PeerHub["Service"]["memoryChanges"] = (input) =>
    memory.changes(input).pipe(Effect.mapError(memoryFailure));
  const memoryReceipts: PeerHub["Service"]["memoryReceipts"] = (input) =>
    memory.receipts(input).pipe(Effect.mapError(memoryFailure));
  const memoryKeep: PeerHub["Service"]["memoryKeep"] = (input) =>
    memory.keep(input).pipe(Effect.provide(memoryAuthLayer), Effect.mapError(memoryFailure));
  const memoryImportKnowledge: PeerHub["Service"]["memoryImportKnowledge"] = (input) =>
    memory
      .importKnowledge(input)
      .pipe(Effect.provide(memoryAuthLayer), Effect.mapError(memoryFailure));
  const memoryExecute: PeerHub["Service"]["memoryExecute"] = (input) => {
    const {
      sessionId: _session,
      environmentId: _environment,
      runtimeGeneration: _generation,
      ...command
    } = input.command;
    return memory.execute({ ...input, command }).pipe(Effect.mapError(memoryFailure));
  };
  const memoryAgent: PeerHub["Service"]["memoryAgent"] = (nativeSessionId) =>
    Effect.gen(function* () {
      const app = appMemorySessions.get(nativeSessionId);
      const session = app?.session ?? broker?.memorySession(nativeSessionId);
      if (session === undefined)
        return yield* hubError(
          "This runtime has no registered Peer memory session. Its coordination hooks must start first.",
        );
      if (app !== undefined) {
        const caller = yield* projections
          .getThreadShell(app.threadId)
          .pipe(Effect.mapError(() => hubError("The runtime is unavailable.")));
        if (
          caller === null ||
          caller.deletedAt !== null ||
          caller.archivedAt !== null ||
          caller.activeRunId === null ||
          caller.providerInstanceId !== app.providerInstanceId
        )
          return yield* hubError("The calling runtime no longer owns an active thread run.");
      } else
        yield* Effect.tryPromise({
          try: () => broker!.registerMemoryRuntime(nativeSessionId),
          catch: () => hubError("The runtime could not report its Peer memory generation."),
        });
      return session;
    });
  const appMemoryReport = (workspace: string): ReadonlyArray<HubApi.ReportedSession> =>
    [...appMemorySessions.values()]
      .filter(({ session }) => session.workspace === workspace)
      .map(({ session, label }) => ({
        id: session.sessionId,
        runtimeGeneration: session.runtimeGeneration,
        project: session.project,
        label,
        agent: session.adapter,
        status: "working",
        files: [],
        claims: [],
        ...(session.taskId === undefined ? {} : { task: session.taskId }),
      }));
  const memoryRuntime: PeerHub["Service"]["memoryRuntime"] = (
    threadId,
    providerSessionId,
    providerInstanceId,
  ) =>
    Effect.gen(function* () {
      const caller = yield* projections
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => hubError("The calling thread is unavailable.")));
      if (
        caller === null ||
        caller.deletedAt !== null ||
        caller.archivedAt !== null ||
        caller.activeRunId === null ||
        caller.providerInstanceId !== providerInstanceId
      )
        return yield* hubError("The calling runtime no longer owns an active thread run.");
      const records = yield* projections
        .getThreadRecords(threadId, ["providerThreads"])
        .pipe(Effect.mapError(() => hubError("The calling runtime is unavailable.")));
      const provider = records.providerThreads.find(
        (entry) => entry.id === caller.activeProviderThreadId,
      );
      const nativeId = provider?.nativeThreadRef?.nativeId;
      if (
        nativeId !== undefined &&
        nativeId !== null &&
        broker?.memorySession(nativeId) !== undefined
      )
        return yield* memoryAgent(nativeId);
      const t3Project = yield* projects
        .getById(caller.projectId)
        .pipe(Effect.mapError(() => hubError("The runtime project is unavailable.")));
      if (Option.isNone(t3Project)) return yield* hubError("The runtime project is unavailable.");
      const place = projectOfPath(currentState(), t3Project.value.workspaceRoot);
      if (place === undefined) return yield* hubError("The runtime is outside a Peer Hub project.");
      const sessionId = `peer:${threadId}`;
      const previous = appMemorySessions.get(sessionId);
      const taskId = assignedTask(
        currentState().persisted,
        sessionId,
        place.workspace,
        place.projectId,
      );
      const session: MemoryService.MemorySession =
        previous?.session.runtimeGeneration === providerSessionId
          ? previous.session
          : {
              workspace: place.workspace,
              project: place.projectId,
              sessionId,
              runtimeGeneration: providerSessionId,
              environmentId,
              workId: sessionId,
              repositoryId: place.repositoryId,
              adapter: provider?.driver ?? String(providerInstanceId),
              root: t3Project.value.workspaceRoot,
              ...(taskId === undefined ? {} : { taskId }),
            };
      if (
        previous !== undefined &&
        previous.session.runtimeGeneration !== session.runtimeGeneration
      )
        yield* memory.endSession(previous.session).pipe(Effect.mapError(memoryFailure));
      appMemorySessions.set(sessionId, {
        session,
        threadId,
        providerInstanceId,
        label: caller.title.slice(0, 300),
      });
      if (previous?.session.runtimeGeneration !== session.runtimeGeneration)
        yield* memory.prepareSession(session, "resume").pipe(Effect.mapError(memoryFailure));
      const auth = yield* requireSession;
      // Runtime provenance is archived before queued commands are replayed. A missing
      // live report during an outage must not prevent the local durable write.
      yield* Effect.gen(function* () {
        const view = yield* hubApi.coordination(auth.hubUrl, auth.session, session.workspace);
        const others = view.sessions.filter(
          (entry) =>
            entry.environment === environmentId &&
            entry.email === currentState().persisted.email &&
            !appMemorySessions.has(entry.id),
        );
        yield* hubApi.reportCoordination(auth.hubUrl, auth.session, session.workspace, {
          environment: environmentId,
          sessions: [
            ...others.map((entry) => ({
              id: entry.id,
              project: entry.project,
              label: entry.label,
              status: entry.status,
              files: entry.files,
              claims: entry.claims,
              ...(entry.runtimeGeneration === undefined
                ? {}
                : { runtimeGeneration: entry.runtimeGeneration }),
              ...(entry.agent === undefined ? {} : { agent: entry.agent }),
              ...(entry.task === undefined ? {} : { task: entry.task }),
              ...(entry.branch === undefined ? {} : { branch: entry.branch }),
              ...(entry.intent === undefined ? {} : { intent: entry.intent }),
              ...(entry.activeAt === undefined ? {} : { activeAt: entry.activeAt }),
            })),
            ...appMemoryReport(session.workspace),
          ],
        });
      }).pipe(Effect.catchTag("PeerHubError", () => Effect.void));
      return session;
    });
  const memoryAgentContext: PeerHub["Service"]["memoryAgentContext"] = (
    nativeSessionId,
    action,
    reason,
  ) =>
    Effect.gen(function* () {
      const session = yield* memoryAgent(nativeSessionId);
      return {
        text:
          action === "checkpoint"
            ? (yield* memory
                .checkpoint(session, reason ?? "runtime checkpoint")
                .pipe(Effect.mapError(memoryFailure))).path
            : (yield* memory.prepareSession(session, "resume").pipe(Effect.mapError(memoryFailure)))
                .notice,
      };
    });
  const memoryAgentExecute: PeerHub["Service"]["memoryAgentExecute"] = (nativeSessionId, input) =>
    Effect.gen(function* () {
      const session = yield* memoryAgent(nativeSessionId);
      if (session.workspace !== input.workspace || session.project !== input.project)
        return yield* hubError("The memory operation must belong to this runtime's project.");
      yield* MemoryCli.assertAgentCommand(input.command).pipe(Effect.mapError(memoryFailure));
      return yield* memory
        .execute({ ...input, command: MemoryCli.agentCommand(session, input.command) })
        .pipe(Effect.mapError(memoryFailure));
    });
  const memoryAgentProject: PeerHub["Service"]["memoryAgentProject"] = (nativeSessionId, input) =>
    Effect.gen(function* () {
      const session = yield* memoryAgent(nativeSessionId);
      if (
        session.workspace !== input.workspace ||
        (session.project !== input.project && input.project !== "company")
      )
        return yield* hubError(
          "The projection must belong to this runtime's project or company scope.",
        );
      return (yield* memory
        .projectForSession(session, input.projection, {
          workspace: input.workspace,
          project: input.project,
        })
        .pipe(Effect.mapError(memoryFailure))).projection;
    });
  const memoryAgentReceipt: PeerHub["Service"]["memoryAgentReceipt"] = (nativeSessionId, input) =>
    Effect.gen(function* () {
      const session = yield* memoryAgent(nativeSessionId);
      const { workspace = session.workspace, project = session.project, ...receipt } = input;
      if (workspace !== session.workspace || (project !== session.project && project !== "company"))
        return yield* hubError(
          "The receipt must belong to this runtime's project or company scope.",
        );
      return yield* memory
        .receipt(session, receipt, { workspace, project })
        .pipe(Effect.mapError(memoryFailure));
    });

  const projectState = (
    workspace: PersistedWorkspace,
    project: PeerProject,
    s: RuntimeState,
  ): Effect.Effect<{
    readonly state: PeerProjectState;
    readonly bound: ReadonlyArray<readonly [string, ProjectId | undefined, HubBoundProject]>;
  }> =>
    Effect.gen(function* () {
      const ref = { slug: workspace.slug, name: workspace.name };
      const bound: Array<readonly [string, ProjectId | undefined, HubBoundProject]> = [];
      const repositories = [];
      for (const repo of project.repositories) {
        if (!safeId(repo.id)) continue;
        const path = checkoutPath(s.persisted, workspace.slug, project.id, repo.id);
        const transient = s.checkouts.get(path);
        const ready = hasGitCheckout(path);
        const t3Project = ready
          ? yield* projects.getByWorkspaceRoot(path).pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        const projectId = Option.isSome(t3Project) ? t3Project.value.id : undefined;
        if (ready) bound.push([path, projectId, { workspace: ref, project, repositoryPath: path }]);
        repositories.push({
          id: repo.id,
          url: repo.url,
          branch: repo.branch,
          path,
          state: transient?.state ?? (ready ? ("ready" as const) : ("missing" as const)),
          ...(transient?.error === undefined ? {} : { error: transient.error }),
          ...(transient?.gitHubSignIn === true ? { gitHubSignIn: true } : {}),
          ...(projectId === undefined ? {} : { projectId }),
        });
      }
      const key = sharedKey(workspace.slug, project.id);
      const instanceIds = s.persisted.sharedInstances[key] ?? [];
      const names = new Map(project.members.map((m) => [m.email, m.name]));
      const sharedError = s.sharedErrors.get(key);
      const work = s.work.get(key);
      const assignments: Record<string, string> = {};
      for (const [thread, assignment] of Object.entries(s.persisted.assignments ?? {})) {
        if (assignment.workspace === workspace.slug && assignment.project === project.id) {
          assignments[thread] = assignment.task;
        }
      }
      return {
        bound,
        state: {
          project,
          repositories,
          tools: project.tools.map((tool) => ({
            id: tool.id,
            name: tool.name,
            missing: tool.requires
              .filter((requirement) => !commandAvailable(requirement.command))
              .map((requirement) => ({
                command: requirement.command,
                ...(requirement.install === undefined ? {} : { install: requirement.install }),
              })),
          })),
          sharedCapacity: {
            enabled: instanceIds.length > 0,
            instanceIds: [...instanceIds],
            ...(sharedError === undefined ? {} : { error: sharedError }),
          },
          work: {
            areas: work?.areas ?? project.areas ?? [],
            tasks: work?.tasks ?? [],
            threads: work?.threads ?? [],
            assignments,
          },
          peers: peersOf(
            (work?.threads ?? []).filter(
              (thread) =>
                thread.email !== s.persisted.email || thread.environment !== environmentId,
            ),
            names,
          ),
        },
      };
    });

  /** The workspace project whose checkout holds `path`, if any. */
  const projectOfPath = (s: RuntimeState, path: string | undefined) => {
    if (path === undefined) return undefined;
    const target = realpathOrSelf(path);
    for (const workspace of s.persisted.workspaces) {
      for (const project of workspace.manifest?.projects ?? []) {
        for (const repo of project.repositories) {
          const root = realpathOrSelf(
            checkoutPath(s.persisted, workspace.slug, project.id, repo.id),
          );
          if (target === root || target.startsWith(`${root}${NodePath.sep}`)) {
            return { workspace: workspace.slug, projectId: project.id, repositoryId: repo.id };
          }
        }
      }
    }
    return undefined;
  };

  /** The session an agent in a pane runs, as herdr's integration or Peer's own hooks say. */
  const sessionOf = (agent: HerdrAgentState) =>
    agent.session ?? broker?.sessionInPane(agent.paneId) ?? undefined;

  /**
   * A herdr agent's thread key: its own session once known, so the thread
   * outlives the pane and a herdr restart; its terminal until then.
   */
  const agentKey = (agent: HerdrAgentState) => {
    const session = sessionOf(agent)?.id;
    return session === undefined
      ? `herdr:${agent.terminalId}`
      : `herdr:${agent.agent ?? "agent"}:${session}`;
  };

  const localAgentView = (s: RuntimeState, agent: HerdrAgentState): PeerLocalAgent => {
    const place = agent.place ?? projectOfPath(s, agent.cwd);
    return {
      id: agentKey(agent),
      paneId: agent.paneId,
      ...(agent.agent === undefined ? {} : { agent: agent.agent }),
      title: agent.title,
      status: agent.status,
      ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      ...(agent.branch === undefined ? {} : { branch: agent.branch }),
      coordinationLevel: broker?.coordinationLevel(agentKey(agent).replace(/^herdr:/, "")) ?? "C",
      ...(agent.postHocPaths === undefined ? {} : { postHocPaths: agent.postHocPaths }),
      ...(agent.postHocPathsTruncated === undefined
        ? {}
        : { postHocPathsTruncated: agent.postHocPathsTruncated }),
      ...(place === undefined ? {} : place),
    };
  };

  /** Rebuilds the status, publishes it when it changed, and hands the policy its new state. */
  /** Coordination as people see it: the settings, and what the broker last heard. */
  const coordinationStatus = (s: RuntimeState): PeerHubStatus["coordination"] => {
    const snapshot = broker?.snapshot() ?? {
      sessions: [],
      overlaps: [],
      findings: [],
      contexts: [],
      advice: [],
      candidates: [],
    };
    return {
      enabled: s.persisted.coordination?.enabled ?? false,
      policy: s.persisted.coordination?.policy ?? "coordinate",
      claudeHooks: claudeHooksInstalled,
      claudeMod: claudeModInstalled,
      codexHooks: codexHooksInstalled,
      ...(codexHooksInstalled ? { codexHooksTrusted: codexTrusts() } : {}),
      logPath: coordinationLog,
      sessions: snapshot.sessions.map((session) => ({
        id: session.id,
        ...(session.runtimeGeneration === undefined
          ? {}
          : { runtimeGeneration: session.runtimeGeneration }),
        workspace: session.workspace,
        project: session.project,
        email: session.email,
        environment: session.environment,
        label: session.label,
        ...(session.agent === undefined ? {} : { agent: session.agent }),
        ...(session.task === undefined ? {} : { task: session.task }),
        ...(session.branch === undefined ? {} : { branch: session.branch }),
        status: session.status,
        files: session.files,
        claims: session.claims,
        local: session.local,
        ...(session.activeAt === undefined ? {} : { activeAt: session.activeAt }),
      })),
      findings: snapshot.findings.map((finding) => ({
        id: finding.id,
        workspace: finding.workspace,
        project: finding.project,
        ...(finding.task === undefined ? {} : { task: finding.task }),
        text: finding.text,
        email: finding.email,
        at: finding.at,
        ...(finding.scope === undefined ? {} : { scope: finding.scope }),
      })),
      contexts: snapshot.contexts.map((context) => ({
        workspace: context.workspace,
        project: context.project,
        scope: context.scope,
        version: context.version,
        ...(context.keeper === undefined ? {} : { keeper: context.keeper }),
        updatedAt: context.updatedAt,
        ...(context.updatedBy === undefined ? {} : { updatedBy: context.updatedBy }),
        ...(context.updatedSession === undefined ? {} : { updatedSession: context.updatedSession }),
        ...(context.restoredFrom === undefined ? {} : { restoredFrom: context.restoredFrom }),
        ...(context.gist === undefined ? {} : { gist: context.gist }),
        bytes: context.bytes ?? 0,
      })),
      advice: snapshot.advice.map((told) => ({
        workspace: told.workspace,
        project: told.project,
        session: told.session,
        about: told.about,
        scope: told.scope,
        name: told.name,
        how: told.how,
        why: told.why,
        ...(told.entryKind === undefined ? {} : { entryKind: told.entryKind }),
        ...(told.path === undefined ? {} : { path: told.path }),
        at: told.at,
      })),
      candidates: snapshot.candidates.map((waiting) => ({
        workspace: waiting.workspace,
        project: waiting.project,
        proposed: waiting.proposed,
      })),
      overlaps: snapshot.overlaps.map((overlap) => ({
        id: overlap.id,
        workspace: overlap.workspace,
        project: overlap.project,
        sessions: overlap.sessions,
        files: overlap.files,
        state: overlap.state,
        ...(overlap.resolution === undefined ? {} : { resolution: overlap.resolution }),
        notes: overlap.notes.map((note) => ({
          id: note.id,
          ...(note.session === undefined ? {} : { session: note.session }),
          email: note.email,
          text: note.text,
          at: note.at,
        })),
        updatedAt: overlap.updatedAt,
        ...(overlap.closer === undefined ? {} : { closer: overlap.closer }),
        ...(overlap.askedAt === undefined ? {} : { askedAt: overlap.askedAt }),
      })),
    };
  };

  const publish = Effect.gen(function* () {
    const s = yield* Ref.get(stateRef);
    const session = yield* readSession;
    const signedIn = Option.isSome(session) && s.persisted.email !== null;
    const byProject = new Map<string, HubBoundProject>();
    const byRoot = new Map<string, HubBoundProject>();
    const knowledgePaths = new Map<string, string>();
    const workspaces: PeerWorkspaceState[] = [];
    for (const workspace of s.persisted.workspaces) {
      const manifest = workspace.manifest;
      const projectStates: PeerProjectState[] = [];
      for (const project of manifest?.projects ?? []) {
        if (!safeId(project.id)) continue;
        const { state, bound } = yield* projectState(workspace, project, s);
        projectStates.push(state);
        for (const [path, projectId, entry] of bound) {
          byRoot.set(path, entry);
          byRoot.set(realpathOrSelf(path), entry);
          if (projectId !== undefined) byProject.set(projectId, entry);
        }
      }
      const knowledgeRepo = manifest?.knowledge.company;
      const knowledgeTransient = s.knowledge.get(workspace.slug);
      const knowledgeReady =
        knowledgeRepo !== undefined && hasGitCheckout(knowledgePath(workspace.slug));
      if (knowledgeReady) knowledgePaths.set(workspace.slug, knowledgePath(workspace.slug));
      workspaces.push({
        slug: workspace.slug,
        name: workspace.name,
        role: workspace.role,
        allowedDomains: workspace.allowedDomains,
        currency: manifest?.workspace.currency ?? "EUR",
        ...(manifest?.workspace.revision === undefined
          ? {}
          : { revision: manifest.workspace.revision }),
        memberName: manifest?.member.name ?? s.persisted.email ?? "",
        companyKnowledge:
          knowledgeRepo === undefined
            ? null
            : {
                repository: knowledgeRepo.repository,
                path: knowledgePath(workspace.slug),
                state: knowledgeTransient?.state ?? (knowledgeReady ? "ready" : "missing"),
                ...(knowledgeTransient?.error === undefined
                  ? {}
                  : { error: knowledgeTransient.error }),
              },
        projects: projectStates,
        lastSyncAt: workspace.lastSyncAt,
        error: s.workspaceErrors.get(workspace.slug) ?? null,
      });
    }
    const sharedInstances = new Map<string, HubSharedInstance>();
    for (const [key, ids] of Object.entries(s.persisted.sharedInstances)) {
      const [slug = "", projectId = ""] = key.split("/");
      const workspace = s.persisted.workspaces.find((w) => w.slug === slug);
      for (const id of ids) {
        sharedInstances.set(id, { workspace: { slug, name: workspace?.name ?? slug }, projectId });
      }
    }
    setHubPolicyState(
      s.persisted.workspaces.length === 0 && sharedInstances.size === 0
        ? null
        : { projects: byProject, roots: byRoot, sharedInstances, knowledgePaths },
    );

    const status: PeerHubStatus = {
      hubUrl: hubUrlOf(s.persisted),
      signedIn,
      email: signedIn ? s.persisted.email : null,
      pendingSignIn: s.persisted.pendingSignIn,
      workspaces,
      joinable: signedIn ? s.persisted.joinable : [],
      workspaceRoot,
      environmentId,
      agents: {
        herdr: s.herdr === null ? "not-running" : "running",
        list: (s.herdr ?? []).map((agent) => localAgentView(s, agent)),
        postHocSkipped: s.persisted.workspaces.reduce(
          (count, workspace) => count + (herdrReportsSkipped.get(workspace.slug) ?? 0),
          0,
        ),
      },
      github: {
        cli: s.github.cli !== null,
        account: s.github.account,
        signIn: s.github.signIn,
        error: s.github.error,
      },
      coordination: coordinationStatus(s),
      sharedThreads: s.persisted.sharedThreads ?? [],
      syncing: s.syncing,
      lastSyncAt: s.persisted.lastSyncAt,
      error: s.error,
    };
    const previous = yield* Ref.getAndSet(statusRef, status);
    if (previous === null || encodeStatus(previous) !== encodeStatus(status)) {
      yield* PubSub.publish(changes, status);
    }
    return status;
  });

  const background = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.andThen(publish),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(layerScope),
      Effect.asVoid,
    );

  /** Clones a workspace's company knowledge repository, or fast-forwards it. */
  const refreshKnowledge = (
    slug: string,
    repository: { readonly repository: string; readonly branch: string },
  ) =>
    Effect.gen(function* () {
      const path = knowledgePath(slug);
      const exists = hasGitCheckout(path);
      const setKnowledge = (transient: Transient | null) =>
        updateRuntime((s) => {
          const knowledge = new Map(s.knowledge);
          if (transient === null) knowledge.delete(slug);
          else knowledge.set(slug, transient);
          return { ...s, knowledge };
        });
      if (!isSafeGitRemote(repository.repository) || !isSafeGitRef(repository.branch)) {
        yield* setKnowledge({
          state: "error",
          error: "The workspace gives an address git must not clone; ask an admin to fix it.",
        });
        return;
      }
      if (!exists) yield* setKnowledge({ state: "cloning" });
      yield* publish;
      const result = yield* Effect.tryPromise({
        try: async () => {
          if (exists) {
            await run("git", ["-C", path, "pull", "--ff-only", "--quiet"], {
              timeoutMs: GIT_TIMEOUT_MS,
            });
          } else {
            await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
            await run(
              "git",
              [
                "clone",
                "--quiet",
                "--branch",
                repository.branch,
                "--",
                repository.repository,
                path,
              ],
              { timeoutMs: GIT_TIMEOUT_MS },
            );
          }
        },
        catch: (failure) =>
          explainCloneFailure(runOutput(failure), {
            url: repository.repository,
            branch: repository.branch,
          }),
      }).pipe(Effect.result);
      // A failed pull keeps the last good checkout usable.
      yield* setKnowledge(
        result._tag === "Success" || exists ? null : { state: "error", error: result.failure },
      );
    });

  /** Drops the local provider instances of a workspace project's shared capacity. */
  const removeSharedInstances = (key: string) =>
    Effect.gen(function* () {
      const ids = (yield* Ref.get(stateRef)).persisted.sharedInstances[key] ?? [];
      for (const id of ids) {
        yield* settings
          .updateProviderInstance({ operation: "remove", instanceId: ProviderInstanceId.make(id) })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* updatePersisted((p) => {
        const { [key]: _removed, ...rest } = p.sharedInstances;
        return { ...p, sharedInstances: rest };
      });
    });

  /** Revokes this environment's gateway key for the project, then drops its instances. */
  const turnOffShared = (workspace: string, projectId: string) =>
    Effect.gen(function* () {
      const { persisted } = yield* Ref.get(stateRef);
      const session = yield* readSession;
      if (Option.isSome(session)) {
        yield* hubApi
          .revokeCredentials(
            hubUrlOf(persisted),
            session.value,
            workspace,
            projectId,
            environmentId,
          )
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* removeSharedInstances(sharedKey(workspace, projectId));
    });

  /** Forgets the session after the hub refused it, so the app asks to sign in again. */
  const dropSession = Effect.gen(function* () {
    yield* secrets.remove(SESSION_SECRET).pipe(Effect.ignoreCause({ log: true }));
    yield* updatePersisted((p) => ({ ...p, email: null, joinable: [] }));
  });

  const syncNow = Effect.gen(function* () {
    const { hubUrl, session } = yield* requireSession;
    yield* updateRuntime((s) => ({ ...s, syncing: true }));
    yield* publish;
    const me = yield* hubApi.me(hubUrl, session).pipe(Effect.result);
    if (me._tag === "Failure") {
      if (HubApi.isSessionEnded(me.failure)) yield* dropSession;
      yield* updateRuntime((s) => ({ ...s, syncing: false, error: me.failure.detail }));
      yield* publish;
      return yield* me.failure;
    }

    const previous = (yield* Ref.get(stateRef)).persisted.workspaces;
    const workspaceErrors = new Map<string, string>();
    const workspaces: PersistedWorkspace[] = [];
    for (const summary of me.success.workspaces) {
      if (!safeId(summary.slug)) continue;
      const old = previous.find((w) => w.slug === summary.slug);
      const manifest = yield* hubApi.manifest(hubUrl, session, summary.slug).pipe(Effect.result);
      if (manifest._tag === "Failure") workspaceErrors.set(summary.slug, manifest.failure.detail);
      workspaces.push({
        slug: summary.slug,
        name: summary.name,
        role: summary.role,
        allowedDomains: summary.allowedDomains,
        manifest: manifest._tag === "Success" ? manifest.success : (old?.manifest ?? null),
        lastSyncAt:
          manifest._tag === "Success"
            ? DateTime.formatIso(yield* DateTime.now)
            : (old?.lastSyncAt ?? null),
      });
    }
    const syncedAt = DateTime.formatIso(yield* DateTime.now);
    yield* updatePersisted((p) => ({
      ...p,
      email: me.success.email,
      workspaces,
      joinable: me.success.joinable
        .filter((j) => safeId(j.slug))
        .map((j) => ({
          slug: j.slug,
          name: j.name,
          allowedDomains: j.allowedDomains,
          reason: j.joinReason,
        })),
      lastSyncAt: syncedAt,
    }));
    yield* updateRuntime((s) => ({ ...s, syncing: false, error: null, workspaceErrors }));

    // Shared capacity the workspaces no longer grant (or workspaces left) goes away here too.
    const stillShared = new Set(
      workspaces.flatMap((w) =>
        (w.manifest?.projects ?? [])
          .filter((p) => p.capacity.shared !== undefined)
          .map((p) => sharedKey(w.slug, p.id)),
      ),
    );
    for (const key of Object.keys((yield* Ref.get(stateRef)).persisted.sharedInstances)) {
      if (!stillShared.has(key)) yield* removeSharedInstances(key);
    }

    for (const workspace of workspaces) {
      const company = workspace.manifest?.knowledge.company;
      if (company !== undefined) yield* background(refreshKnowledge(workspace.slug, company));
    }
    yield* background(refreshWork);
    return yield* publish;
  });

  const assignedTask = (
    persisted: PersistedState,
    thread: string,
    workspace: string,
    projectId: string,
  ): string | undefined => {
    const assignment = persisted.assignments?.[thread];
    return assignment !== undefined &&
      assignment.workspace === workspace &&
      assignment.project === projectId
      ? assignment.task
      : undefined;
  };

  /**
   * Reports this computer's threads — Peer's own and the agents herdr runs in
   * workspace checkouts — to each workspace, and reads everyone's work back.
   */
  const runtimeClock = yield* Clock.Clock;
  const deliveryTracker = new WorkDeliveryTracker();
  const nativeRuntimes = new Map<string, PeerWorkStatus>();
  let nativeRuntimesAt = 0;
  let reportRound = 0;
  const refreshWorkUnlocked = Effect.gen(function* () {
    const sessionInfo = yield* requireSession.pipe(Effect.option);
    if (Option.isNone(sessionInfo)) return;
    const { hubUrl, session } = sessionInfo.value;
    const currentSettings = yield* settings.getSettings.pipe(Effect.option);
    const driverOf = (instanceId: string) =>
      Option.match(currentSettings, {
        onNone: () => instanceId,
        onSome: (value) =>
          value.providerInstances[instanceId as ProviderInstanceId]?.driver ?? instanceId,
      });
    const shell = yield* projections.getShellSnapshot({ location: "active" }).pipe(Effect.option);
    const threads = Option.isSome(shell) ? shell.value.threads : [];
    if (Option.isSome(shell)) {
      nativeRuntimes.clear();
      nativeRuntimesAt = DateTime.toEpochMillis(yield* DateTime.now);
    }
    const before = yield* Ref.get(stateRef);
    const work = new Map<string, ProjectWork>();

    for (const workspace of before.persisted.workspaces) {
      const manifest = workspace.manifest;
      if (manifest === null) continue;
      // T3 project id → workspace project id, for the threads running here.
      const roots = new Map<string, { projectId: string; repositoryId: string }>();
      for (const project of manifest.projects) {
        if (!safeId(project.id)) continue;
        for (const repo of project.repositories) {
          if (!safeId(repo.id)) continue;
          const t3 = yield* projects
            .getByWorkspaceRoot(checkoutPath(before.persisted, workspace.slug, project.id, repo.id))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(t3))
            roots.set(t3.value.id, { projectId: project.id, repositoryId: repo.id });
        }
      }

      const s = yield* Ref.get(stateRef);
      const shared = new Set(s.persisted.sharedThreads ?? []);
      let reported: HubApi.ReportedThread[] = [];
      for (const thread of threads) {
        const place = roots.get(thread.projectId);
        if (place === undefined) continue;
        const { projectId, repositoryId } = place;
        const id = `peer:${thread.id}`;
        const task = assignedTask(s.persisted, id, workspace.slug, projectId);
        const harness = harnessForDriver(driverOf(thread.providerInstanceId));
        const records = yield* projections
          .getThreadRecords(thread.id, ["providerThreads", "providerSessions"])
          .pipe(Effect.option);
        const provider = Option.isSome(records)
          ? records.value.providerThreads.find((p) => p.id === thread.activeProviderThreadId)
          : undefined;
        const nativeId = provider?.nativeThreadRef?.nativeId;
        const runtimePresent = nativeRuntimePresent(
          provider,
          Option.isSome(records) ? records.value.providerSessions : [],
        );
        const nativeHarness =
          provider === undefined ? undefined : harnessForDriver(provider.driver);
        if (runtimePresent && nativeId !== undefined && nativeHarness !== undefined) {
          nativeRuntimes.set(`${id}/${nativeHarness}:${nativeId}`, shellStatus(thread));
        }
        const repo = manifest.projects
          .find((p) => p.id === projectId)
          ?.repositories.find((r) => r.id === repositoryId);
        const pullRequests =
          repo === undefined
            ? undefined
            : nativeWorkPullRequests(repo.url, thread.branch, thread.pullRequests ?? []);
        reported.push({
          id,
          project: projectId,
          repository: repositoryId,
          ...(task === undefined ? {} : { task }),
          title: thread.title.slice(0, 300),
          status: shellStatus(thread),
          ...(harness === undefined ? {} : { harness }),
          ...(thread.branch === null ? {} : { branch: thread.branch }),
          source: "peer",
          runtimePresent,
          ...(pullRequests === undefined ? {} : { pullRequests }),
          ...(shared.has(id) ? { observable: true } : {}),
        });
      }
      for (const agent of s.herdr ?? []) {
        const place = agent.place ?? projectOfPath(s, agent.cwd);
        if (place === undefined || place.workspace !== workspace.slug) continue;
        const id = agentKey(agent);
        const task =
          assignedTask(s.persisted, id, workspace.slug, place.projectId) ??
          assignedTask(s.persisted, `herdr:${agent.terminalId}`, workspace.slug, place.projectId);
        reported.push({
          id,
          project: place.projectId,
          repository: place.repositoryId,
          ...(task === undefined ? {} : { task }),
          title: agent.title.slice(0, 300),
          // Finished work is "done" like a Peer thread's, whether or not someone looked in herdr.
          // The local list keeps herdr's own state: Needs you clears once the person has looked.
          status: Herdr.herdrWorkStatus(agent),
          ...(agent.agent === undefined ? {} : { harness: agent.agent }),
          ...(agent.branch === undefined ? {} : { branch: agent.branch }),
          source: "herdr",
          ...(id === `herdr:${agent.terminalId}`
            ? {}
            : { previousId: `herdr:${agent.terminalId}` }),
          ...(shared.has(id) ? { observable: true } : {}),
        });
      }
      reported = reported.map((thread) =>
        restoreWorkIdentity(
          thread,
          (before.work.get(sharedKey(workspace.slug, thread.project))?.threads ?? []).filter(
            (old) => old.email === s.persisted.email && old.environment === environmentId,
          ),
        ),
      );
      // Keep absent runtimes in the ledger and reconcile their registered PRs too.
      // The hub retains them through a restart before this computer has read its first view.
      for (const project of manifest.projects) {
        const previous = before.work.get(sharedKey(workspace.slug, project.id))?.threads ?? [];
        for (const thread of previous) {
          if (
            thread.email !== s.persisted.email ||
            thread.environment !== environmentId ||
            reported.some((current) => current.id === thread.id || current.previousId === thread.id)
          )
            continue;
          if (thread.delivery === "merged" || thread.delivery === "closed") continue;
          const task =
            assignedTask(s.persisted, thread.id, workspace.slug, project.id) ?? thread.task;
          reported.push({
            id: thread.id,
            project: project.id,
            title: thread.title,
            status: "unknown",
            source: thread.source,
            runtimePresent: false,
            observable: false,
            ...(task === undefined ? {} : { task }),
            ...(thread.branch === undefined ? {} : { branch: thread.branch }),
            ...(thread.harness === undefined ? {} : { harness: thread.harness }),
            ...(thread.repository === undefined ? {} : { repository: thread.repository }),
            ...(thread.pullRequests === undefined ? {} : { pullRequests: thread.pullRequests }),
          });
        }
      }
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const withDelivery = boundedWorkReport(reported, reportRound).map((thread) => {
        const project = manifest.projects.find((p) => p.id === thread.project);
        const previous = before.work
          .get(sharedKey(workspace.slug, thread.project))
          ?.threads.find(
            (old) =>
              old.id === thread.id &&
              old.email === s.persisted.email &&
              old.environment === environmentId &&
              old.branch === thread.branch,
          );
        const repository = thread.repository ?? previous?.repository;
        const repo = project?.repositories.find((r) => r.id === repository);
        const required = thread.pullRequests ?? previous?.pullRequests;
        const known = pullRequestBatch(required ?? [], thread.branch);
        // Native threads already get host snapshots through their PR links. herdr and dormant
        // threads use exact URLs once discovered; failed lookups leave hub evidence untouched.
        const observed =
          thread.source === "peer" &&
          thread.runtimePresent !== false &&
          thread.pullRequests !== undefined
            ? thread.pullRequests
            : repo === undefined || thread.branch === undefined || s.github.cli === null
              ? undefined
              : deliveryTracker.read(
                  {
                    workId: `${s.persisted.email}/${workspace.slug}/${thread.project}/${thread.id}`,
                    repositoryUrl: repo.url,
                    branch: thread.branch,
                    known,
                  },
                  (args) => run(s.github.cli!, args, { timeoutMs: 5000 }),
                  now,
                );
        const pullRequests = mergePullRequestEvidence(required, observed);
        return {
          ...thread,
          ...(repository === undefined ? {} : { repository }),
          ...(pullRequests === undefined ? {} : { pullRequests }),
        };
      });
      yield* hubApi
        .reportThreads(hubUrl, session, workspace.slug, {
          environment: environmentId,
          threads: withDelivery,
        })
        .pipe(Effect.ignoreCause({ log: true }));

      const fetched = yield* hubApi.work(hubUrl, session, workspace.slug).pipe(Effect.option);
      if (Option.isNone(fetched)) {
        // Keep the last good view of a workspace the hub did not answer for.
        for (const [key, value] of before.work) {
          if (key.startsWith(`${workspace.slug}/`)) work.set(key, value);
        }
        continue;
      }
      for (const [key, value] of workOf(workspace.slug, fetched.value)) {
        work.set(key, value);
      }
    }
    reportRound += 1;
    yield* updateRuntime((current) => ({ ...current, work }));
  });

  const refreshWork = refreshWorkUnlocked.pipe(lock.withPermits(1));

  /** One workspace's work as the hub gave it, keyed like `RuntimeState.work`. */
  const workOf = (slug: string, fetched: HubApi.HubWork) =>
    Object.entries(fetched.projects).map(
      ([projectId, projectWork]) =>
        [
          sharedKey(slug, projectId),
          {
            areas: projectWork.areas,
            tasks: projectWork.tasks,
            // The ledger includes our absent runtimes too; clients overlay their live threads.
            threads: projectWork.threads,
          },
        ] as const,
    );

  /** Reads one workspace's work again, without reporting, once the hub says it changed. */
  const readWork = (slug: string) =>
    Effect.gen(function* () {
      const sessionInfo = yield* requireSession.pipe(Effect.option);
      if (Option.isNone(sessionInfo)) return;
      const { hubUrl, session } = sessionInfo.value;
      const fetched = yield* hubApi.work(hubUrl, session, slug);
      yield* updateRuntime((current) => {
        const work = new Map([...current.work].filter(([key]) => !key.startsWith(`${slug}/`)));
        for (const [key, value] of workOf(slug, fetched)) work.set(key, value);
        return { ...current, work };
      });
    });

  const branchOf = (cwd: string | undefined, nowMillis: number) =>
    Effect.gen(function* () {
      if (cwd === undefined) return undefined;
      const cached = branches.get(cwd);
      if (cached !== undefined && nowMillis - cached.at < 30_000) return cached.branch;
      const branch = yield* Effect.tryPromise(() =>
        run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 3000 }),
      ).pipe(
        Effect.map((name) => (name === "" || name === "HEAD" ? undefined : name)),
        Effect.orElseSucceed(() => undefined),
      );
      branches.set(cwd, { branch, at: nowMillis });
      return branch;
    });

  /** GitHub CLI and its active account, read again: what github.com clones sign in with. */
  const refreshGitHub = Effect.gen(function* () {
    const gh = commandPath("gh");
    const account =
      gh === null
        ? null
        : yield* Effect.tryPromise(() =>
            run(gh, ["auth", "status", "--hostname", "github.com", "--json", "hosts"]),
          ).pipe(
            Effect.map(activeGitHubAccount),
            Effect.orElseSucceed(() => null),
          );
    yield* updateRuntime((s) => ({ ...s, github: { ...s.github, cli: gh, account } }));
    return { gh, account };
  });

  /** herdr's events say to read its agents again; a burst of them is one signal. */
  const herdrChanged = yield* Queue.dropping<void>(1);
  /** Lists herdr's agents with its events subscribed first, so no change goes unheard. */
  const herdrFollower = Herdr.followHerdrAgents({
    onChange: () => void Queue.offerUnsafe(herdrChanged, undefined),
    retryMs: HERDR_RESYNC_MS,
  });
  const herdrPlaces = new Map<string, { at: number; place: HerdrAgentState["place"] }>();
  const herdrCompletions = new Herdr.HerdrCompletionTracker();
  const herdrObservedPaths = new Map<string, { paths: ReadonlyArray<string>; truncated: number }>();
  /** What herdr runs on this computer, with each agent's git branch and worktree's repository. */
  const refreshHerdr = Effect.gen(function* () {
    const agents = yield* Effect.promise(() => herdrFollower.read());
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const withBranches =
      agents === null
        ? null
        : yield* Effect.forEach(agents, (agent) =>
            Effect.gen(function* () {
              const branch = yield* branchOf(agent.cwd, nowMillis);
              const observationKey = [
                agent.terminalId,
                agent.agent,
                agent.session?.id,
                agent.session?.path,
                agent.cwd,
              ].join("\0");
              if (herdrCompletions.completed(agent) && agent.cwd !== undefined) {
                const paths = yield* Effect.promise(() => Herdr.readHerdrChangedPaths(agent.cwd!));
                if (paths !== null)
                  herdrObservedPaths.set(observationKey, {
                    paths: paths.slice(0, 200),
                    truncated: Math.max(0, paths.length - 200),
                  });
                if (herdrObservedPaths.size > 500)
                  herdrObservedPaths.delete(herdrObservedPaths.keys().next().value!);
              }
              const observation = herdrObservedPaths.get(observationKey);
              let place = projectOfPath(yield* Ref.get(stateRef), agent.cwd);
              if (place === undefined && agent.cwd !== undefined) {
                const cached = herdrPlaces.get(agent.cwd);
                if (cached !== undefined && nowMillis - cached.at < 30_000) place = cached.place;
                else {
                  const resolved = yield* Effect.promise(() => placeOf(agent.cwd!));
                  place =
                    resolved?.repositoryId === undefined
                      ? undefined
                      : {
                          workspace: resolved.workspace,
                          projectId: resolved.project,
                          repositoryId: resolved.repositoryId,
                        };
                  herdrPlaces.set(agent.cwd, { at: nowMillis, place });
                  if (herdrPlaces.size > 500) herdrPlaces.delete(herdrPlaces.keys().next().value!);
                }
              }
              return {
                ...agent,
                branch,
                ...(observation === undefined
                  ? {}
                  : {
                      postHocPaths: observation.paths,
                      postHocPathsTruncated: observation.truncated,
                    }),
                ...(place === undefined ? {} : { place }),
              };
            }),
          );
    yield* updateRuntime((s) => ({ ...s, herdr: withBranches }));
  });

  /** An agent placed on a task under its terminal keeps the task once its session is known. */
  const keepAssignments = (agents: ReadonlyArray<HerdrAgentState>) =>
    Effect.gen(function* () {
      const assignments = (yield* Ref.get(stateRef)).persisted.assignments ?? {};
      const moves = agents.flatMap((agent) => {
        const legacy = `herdr:${agent.terminalId}`;
        const key = agentKey(agent);
        const assignment = assignments[legacy];
        return key !== legacy && assignment !== undefined && assignments[key] === undefined
          ? [{ legacy, key, assignment }]
          : [];
      });
      const shared = (yield* Ref.get(stateRef)).persisted.sharedThreads ?? [];
      const renamed = new Map(
        agents.flatMap((agent) => {
          const legacy = `herdr:${agent.terminalId}`;
          const key = agentKey(agent);
          return key !== legacy && shared.includes(legacy) ? [[legacy, key] as const] : [];
        }),
      );
      if (moves.length === 0 && renamed.size === 0) return;
      yield* updatePersisted((p) => {
        const next = { ...p.assignments };
        for (const move of moves) {
          delete next[move.legacy];
          next[move.key] = move.assignment;
        }
        return {
          ...p,
          assignments: next,
          sharedThreads: (p.sharedThreads ?? []).map((key) => renamed.get(key) ?? key),
        };
      });
    });

  /** Where Peer found agents' transcripts: session id → file, or null, rechecked after a while. */
  const transcripts = new Map<string, { readonly path: string | null; readonly at: number }>();

  /** A herdr agent as its view shows it: its transcript when Peer can read it, else its terminal. */
  const agentView = (agentId: string) =>
    Effect.gen(function* () {
      const agent = ((yield* Ref.get(stateRef)).herdr ?? []).find(
        (candidate) =>
          agentKey(candidate) === agentId || `herdr:${candidate.terminalId}` === agentId,
      );
      if (agent === undefined) {
        return { agentId, title: "", status: "unknown", gone: true } satisfies PeerAgentView;
      }
      const base = {
        agentId,
        title: agent.title,
        status: agent.status,
        paneId: agent.paneId,
        gone: false,
        ...(agent.agent === undefined ? {} : { agent: agent.agent }),
        ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
        ...(agent.branch === undefined ? {} : { branch: agent.branch }),
      } satisfies PeerAgentView;
      const session = sessionOf(agent);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let path: string | null = null;
      if (session !== undefined && agent.agent === "claude") {
        const key = session.id ?? session.path ?? "";
        const known = transcripts.get(key);
        if (known !== undefined && (known.path !== null || now - known.at < 10_000)) {
          path = known.path;
        } else {
          path = yield* Effect.promise(() => AgentTranscript.findClaudeTranscript(session));
          transcripts.set(key, { path, at: now });
        }
      }
      if (path !== null) {
        const transcriptPath = path;
        const lines = yield* Effect.tryPromise(() =>
          AgentTranscript.readTranscriptTail(transcriptPath),
        ).pipe(Effect.orElseSucceed(() => [] as string[]));
        return {
          ...base,
          entries: AgentTranscript.transcriptEntries(
            lines,
            agent.cwd === undefined ? {} : { cwd: agent.cwd },
          ),
        } satisfies PeerAgentView;
      }
      // herdr will not read a working full-screen agent's history. Say so rather than show nothing;
      // the view is read again every second, so its output appears once herdr reports it idle or done.
      const terminal = yield* Effect.promise(() => Herdr.readHerdrAgent(agent.paneId));
      const hint = [
        terminal.kind === "notIdle" ? Herdr.herdrNotIdleHint(agent.status) : undefined,
        agent.agent === "claude"
          ? "To follow this conversation here instead of its terminal, install herdr's Claude Code integration once: herdr integration install claude"
          : undefined,
      ]
        .filter((line) => line !== undefined)
        .join(". ");
      return {
        ...base,
        ...(terminal.kind === "text" ? { terminal: terminal.text } : {}),
        ...(hint === "" ? {} : { hint }),
      } satisfies PeerAgentView;
    });

  /**
   * Keeps herdr's agents current. herdr's events say when an agent appears,
   * leaves or changes state; Peer then reads the list, shows it at once and
   * tells the hub within a couple of seconds. The events are subscribed before
   * each list, and again at once when herdr drops them for falling behind.
   * Without events (no herdr, or one from before them) Peer reads the list
   * every few seconds instead.
   */
  const followHerdr = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => herdrFollower.close()));
    let shown = "";
    let reported = "";
    let reportedAt = 0;

    const step = Effect.gen(function* () {
      yield* refreshHerdr;
      const agents = (yield* Ref.get(stateRef)).herdr;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* keepAssignments(agents ?? []);
      const seen = herdrSignature(agents, agentKey);
      if (seen !== shown) {
        shown = seen;
        yield* publish;
      }
      if (seen !== reported && now - reportedAt >= HERDR_REPORT_GAP_MS) {
        reported = seen;
        reportedAt = now;
        yield* background(refreshWork);
      }
      return seen !== reported
        ? Math.max(100, HERDR_REPORT_GAP_MS - (now - reportedAt))
        : herdrFollower.live()
          ? HERDR_RESYNC_MS
          : HERDR_POLL_MS;
    });

    while (true) {
      const wait = yield* step.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Peer could not read herdr's agents", cause).pipe(
            Effect.as(HERDR_POLL_MS),
          ),
        ),
      );
      const woken = yield* Queue.take(herdrChanged).pipe(Effect.timeoutOption(wait));
      if (Option.isSome(woken)) {
        // An agent starting or finishing sends a few events at once; read once they settle.
        yield* Effect.sleep(150);
        yield* Queue.clear(herdrChanged);
      }
    }
  });

  const startSignIn: PeerHub["Service"]["startSignIn"] = Effect.fn("PeerHub.startSignIn")(
    function* (input) {
      const { persisted } = yield* Ref.get(stateRef);
      if (persisted.email !== null && Option.isSome(yield* readSession)) {
        return yield* hubError(`You are signed in as ${persisted.email}. Sign out first.`);
      }
      const hubUrl = normalizeHubUrl(input.hubUrl ?? hubUrlOf(persisted));
      if (hubUrl === null)
        return yield* hubError("Enter the hub's address, e.g. https://hub.example.com.");
      const started = yield* hubApi.startSignIn(hubUrl, input.email);
      const sentAt = DateTime.formatIso(yield* DateTime.now);
      yield* updatePersisted((p) => ({
        ...p,
        hubUrl: hubUrl === DEFAULT_HUB_URL ? null : hubUrl,
        pendingSignIn: {
          email: started.email,
          sentAt,
          ...(started.code === undefined ? {} : { echoedCode: started.code }),
        },
      }));
      yield* updateRuntime((s) => ({ ...s, error: null }));
      return yield* publish;
    },
    lock.withPermits(1),
  );

  const finishSignIn: PeerHub["Service"]["finishSignIn"] = Effect.fn("PeerHub.finishSignIn")(
    function* (input) {
      const { persisted } = yield* Ref.get(stateRef);
      const pending = persisted.pendingSignIn;
      if (pending === null) return yield* hubError("Ask for a sign-in code first.");
      const signedIn = yield* hubApi.finishSignIn(
        hubUrlOf(persisted),
        pending.email,
        input.code.replace(/\s+/g, ""),
      );
      yield* secrets
        .set(SESSION_SECRET, Buffer.from(signedIn.session, "utf8"))
        .pipe(Effect.mapError(() => hubError("Could not store the hub session.")));
      yield* updatePersisted((p) => ({ ...p, email: signedIn.email, pendingSignIn: null }));
      // Workspaces that admit the address's domain take the person in right away, like Slack,
      // except the ones they left on this computer before.
      const hubUrl = hubUrlOf(persisted);
      const left = new Set(persisted.leftWorkspaces?.[signedIn.email] ?? []);
      const me = yield* hubApi.me(hubUrl, signedIn.session).pipe(Effect.option);
      for (const workspace of Option.isSome(me) ? me.value.joinable : []) {
        if (
          workspace.joinReason !== "domain" ||
          left.has(workspace.slug) ||
          !safeId(workspace.slug)
        )
          continue;
        yield* hubApi
          .join(hubUrl, signedIn.session, workspace.slug)
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return yield* syncNow;
    },
    lock.withPermits(1),
  );

  const signOut: PeerHub["Service"]["signOut"] = Effect.gen(function* () {
    const { persisted } = yield* Ref.get(stateRef);
    const session = yield* readSession;
    for (const key of Object.keys(persisted.sharedInstances)) {
      const [workspace = "", projectId = ""] = key.split("/");
      yield* turnOffShared(workspace, projectId);
    }
    if (Option.isSome(session)) {
      yield* hubApi
        .signOut(hubUrlOf(persisted), session.value)
        .pipe(Effect.ignoreCause({ log: true }));
    }
    yield* secrets.remove(SESSION_SECRET).pipe(Effect.ignoreCause({ log: true }));
    // Keep the hub address so signing back in is one step, and what each person left so it is
    // not rejoined. Checkouts stay: they are the person's files.
    yield* updatePersisted(() => ({
      ...EMPTY_PERSISTED,
      hubUrl: persisted.hubUrl,
      ...(persisted.leftWorkspaces === undefined
        ? {}
        : { leftWorkspaces: persisted.leftWorkspaces }),
      // Which checkouts and threads belong where is about this computer's files.
      ...(persisted.localCheckouts === undefined
        ? {}
        : { localCheckouts: persisted.localCheckouts }),
      ...(persisted.assignments === undefined ? {} : { assignments: persisted.assignments }),
      ...(persisted.coordination === undefined ? {} : { coordination: persisted.coordination }),
    }));
    yield* updateRuntime((s) => ({
      ...s,
      error: null,
      workspaceErrors: new Map(),
      work: new Map(),
      sharedErrors: new Map(),
    }));
    return yield* publish;
  }).pipe(lock.withPermits(1));

  const sync: PeerHub["Service"]["sync"] = syncNow.pipe(lock.withPermits(1));

  const createWorkspace: PeerHub["Service"]["createWorkspace"] = Effect.fn(
    "PeerHub.createWorkspace",
  )(function* (input) {
    const { hubUrl, session } = yield* requireSession;
    const slug = input.slug.toLowerCase();
    yield* hubApi.createWorkspace(hubUrl, session, {
      slug,
      name: input.name,
      allowedDomains: input.allowedDomains.map((domain) => domain.toLowerCase()),
    });
    yield* updatePersisted((p) => markLeft(p, p.email, slug, false));
    return yield* syncNow;
  }, lock.withPermits(1));

  const joinWorkspace: PeerHub["Service"]["joinWorkspace"] = Effect.fn("PeerHub.joinWorkspace")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      yield* hubApi.join(hubUrl, session, input.workspace);
      yield* updatePersisted((p) => markLeft(p, p.email, input.workspace, false));
      return yield* syncNow;
    },
    lock.withPermits(1),
  );

  const leaveWorkspace: PeerHub["Service"]["leaveWorkspace"] = Effect.fn("PeerHub.leaveWorkspace")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      yield* hubApi.leave(hubUrl, session, input.workspace);
      yield* updatePersisted((p) => markLeft(p, p.email, input.workspace, true));
      // The hub revoked this member's keys; the local instances go too.
      const prefix = `${input.workspace}/`;
      for (const key of Object.keys((yield* Ref.get(stateRef)).persisted.sharedInstances)) {
        if (key.startsWith(prefix)) yield* removeSharedInstances(key);
      }
      return yield* syncNow;
    },
    lock.withPermits(1),
  );

  const invite: PeerHub["Service"]["invite"] = Effect.fn("PeerHub.invite")(function* (input) {
    const { hubUrl, session } = yield* requireSession;
    yield* hubApi.invite(hubUrl, session, input.workspace, {
      email: input.email,
      role: input.role ?? "member",
    });
    return yield* publish;
  });

  const findWorkspace: PeerHub["Service"]["findWorkspace"] = Effect.fn("PeerHub.findWorkspace")(
    function* (input) {
      const slug = input.slug.trim().toLowerCase();
      if (!safeId(slug)) return null;
      const { hubUrl, session } = yield* requireSession;
      return yield* hubApi.findWorkspace(hubUrl, session, slug);
    },
  );

  const findProject = (workspaceSlug: string, projectId: string) =>
    Effect.gen(function* () {
      const workspace = (yield* Ref.get(stateRef)).persisted.workspaces.find(
        (w) => w.slug === workspaceSlug,
      );
      if (workspace === undefined) {
        return yield* hubError(`You are not a member of the workspace "${workspaceSlug}".`);
      }
      const project = workspace.manifest?.projects.find((p) => p.id === projectId);
      if (project === undefined || !safeId(project.id)) {
        return yield* hubError(`${workspace.name} gives you no project "${projectId}".`);
      }
      return { workspace, project };
    });

  const cloneAndRegister = (workspace: PersistedWorkspace, project: PeerProject) =>
    Effect.gen(function* () {
      const settled = (path: string) =>
        updateRuntime((s) => {
          const checkouts = new Map(s.checkouts);
          checkouts.delete(path);
          return { ...s, checkouts };
        });
      for (const repo of project.repositories) {
        if (!safeId(repo.id)) continue;
        const path = checkoutPath(
          (yield* Ref.get(stateRef)).persisted,
          workspace.slug,
          project.id,
          repo.id,
        );
        if (!hasGitCheckout(path) && (!isSafeGitRemote(repo.url) || !isSafeGitRef(repo.branch))) {
          yield* updateRuntime((s) => ({
            ...s,
            checkouts: new Map(s.checkouts).set(path, {
              state: "error",
              error: "The workspace gives an address git must not clone; ask an admin to fix it.",
            }),
          }));
          continue;
        }
        if (!hasGitCheckout(path)) {
          yield* updateRuntime((s) => ({
            ...s,
            checkouts: new Map(s.checkouts).set(path, { state: "cloning" }),
          }));
          yield* publish;
          // On github.com, GitHub CLI's account clones over https when it is signed in, whatever
          // else git keeps; otherwise git signs in its own way (SSH keys, the keychain).
          const github = gitHubRepository(repo.url);
          const { gh, account } =
            github === null ? { gh: null, account: null } : yield* refreshGitHub;
          const viaGh = github !== null && gh !== null && account !== null ? gh : null;
          const cloned = yield* Effect.tryPromise({
            try: async () => {
              await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
              const source = viaGh === null ? repo.url : (github?.httpsUrl ?? repo.url);
              await run(
                "git",
                [
                  ...(viaGh === null ? [] : gitHubCredentialOptions(viaGh)),
                  "clone",
                  "--quiet",
                  "--branch",
                  repo.branch,
                  "--",
                  source,
                  path,
                ],
                { timeoutMs: GIT_TIMEOUT_MS },
              );
              if (viaGh !== null) {
                // Pulls and pushes in this checkout sign in the same way.
                const key = "credential.https://github.com.helper";
                await run("git", ["-C", path, "config", "--local", key, ""]);
                await run("git", [
                  "-C",
                  path,
                  "config",
                  "--local",
                  "--add",
                  key,
                  gitHubCredentialHelper(viaGh),
                ]);
              }
            },
            catch: (failure) =>
              github === null
                ? { message: explainCloneFailure(runOutput(failure), repo), signIn: false }
                : explainGitHubCloneFailure(runOutput(failure), {
                    ...repo,
                    nameWithOwner: github.nameWithOwner,
                    account: viaGh === null ? null : account,
                    cli: gh !== null,
                  }),
          }).pipe(Effect.result);
          if (cloned._tag === "Failure") {
            const { message, signIn } = cloned.failure;
            yield* updateRuntime((s) => ({
              ...s,
              checkouts: new Map(s.checkouts).set(path, {
                state: "error",
                error: message,
                ...(signIn ? { gitHubSignIn: true } : {}),
              }),
            }));
            continue;
          }
        }
        // A checkout already open as a project is not opened a second time.
        const registered = yield* projects
          .getByWorkspaceRoot(path)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(registered)) {
          yield* settled(path);
          continue;
        }
        yield* projects
          .bootstrap({
            commandId: CommandId.make(`peer-open:${NodeCrypto.randomUUID()}`),
            projectId: ProjectId.make(
              `peer-${workspace.slug}-${project.id}-${repo.id}-${NodeCrypto.randomBytes(3).toString("hex")}`,
            ),
            title:
              project.repositories.length === 1 ? project.name : `${project.name} · ${repo.id}`,
            workspaceRoot: path,
          })
          .pipe(
            Effect.tap(() => settled(path)),
            Effect.catch((cause) =>
              updateRuntime((s) => ({
                ...s,
                checkouts: new Map(s.checkouts).set(path, { state: "error", error: cause.message }),
              })),
            ),
          );
      }
    });

  // Projects being opened here; a second request for one waits for the first.
  const openings = new Map<string, Deferred.Deferred<void>>();

  const openProject: PeerHub["Service"]["openProject"] = Effect.fn("PeerHub.openProject")(
    function* (input) {
      const { workspace, project } = yield* findProject(input.workspace, input.projectId);
      if (project.repositories.length === 0) {
        return yield* hubError(`${project.name} declares no repositories yet.`);
      }
      // The answer waits for the clone, so the app can open the project or say why it could not.
      // The clone runs in the layer's scope: a request that goes away leaves it running.
      const key = sharedKey(workspace.slug, project.id);
      let opened = openings.get(key);
      if (opened === undefined) {
        const created = Deferred.makeUnsafe<void>();
        openings.set(key, created);
        opened = created;
        yield* background(
          cloneAndRegister(workspace, project).pipe(
            Effect.ensuring(
              Effect.sync(() => openings.delete(key)).pipe(
                Effect.andThen(Deferred.succeed(created, undefined)),
              ),
            ),
          ),
        );
      }
      yield* Deferred.await(opened);
      return yield* publish;
    },
  );

  // The sign-in GitHub CLI is waiting on, killed with the layer if still waiting.
  let gitHubSignIn: GitHubSignIn | null = null;
  yield* Effect.addFinalizer(() => Effect.sync(() => gitHubSignIn?.cancel()));

  const connectGitHub: PeerHub["Service"]["connectGitHub"] = Effect.gen(function* () {
    if (gitHubSignIn !== null) return yield* publish;
    const { gh } = yield* refreshGitHub;
    if (gh === null) {
      return yield* hubError(
        "Install GitHub CLI first (brew install gh, or see cli.github.com), then connect GitHub.",
      );
    }
    const started = yield* Effect.tryPromise({
      try: () =>
        startGitHubSignIn(gh, { ...process.env, PATH: searchPath().join(NodePath.delimiter) }),
      catch: (failure) =>
        hubError(
          `GitHub CLI could not start signing in: ${failure instanceof Error ? failure.message : String(failure)}`,
        ),
    });
    gitHubSignIn = started;
    const { userCode, verificationUri } = started;
    yield* updateRuntime((s) => ({
      ...s,
      github: { ...s.github, signIn: { userCode, verificationUri }, error: null },
    }));
    // gh waits until the person entered the code; the account it gets is the one clones use.
    yield* background(
      Effect.gen(function* () {
        const finished = yield* Effect.tryPromise({
          try: () => started.done,
          catch: (failure) => (failure instanceof Error ? failure.message : String(failure)),
        }).pipe(Effect.result);
        // A cancelled or replaced sign-in leaves no error behind.
        const current = gitHubSignIn === started;
        if (current) gitHubSignIn = null;
        yield* updateRuntime((s) => ({
          ...s,
          github: {
            ...s.github,
            signIn: current ? null : s.github.signIn,
            error: current && finished._tag === "Failure" ? finished.failure : s.github.error,
          },
        }));
        yield* refreshGitHub;
      }),
    );
    return yield* publish;
  });

  const cancelGitHubSignIn: PeerHub["Service"]["cancelGitHubSignIn"] = Effect.gen(function* () {
    const waiting = gitHubSignIn;
    gitHubSignIn = null;
    waiting?.cancel();
    yield* updateRuntime((s) => ({ ...s, github: { ...s.github, signIn: null } }));
    return yield* publish;
  });

  // ---- agent coordination (experimental) ----

  const currentState = () => Effect.runSync(Ref.get(stateRef));

  /** The workspace project a directory is in, and the repository working tree around it. */
  const placeOf = async (cwd: string): Promise<CheckoutPlace | null> => {
    const toplevel = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(
      () => null,
    );
    if (toplevel === null || toplevel === "") return null;
    const s = currentState();
    // A worktree of a workspace checkout counts as that checkout.
    const common = await run("git", [
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]).catch(() => null);
    const place =
      projectOfPath(s, toplevel) ??
      (common === null ? undefined : projectOfPath(s, NodePath.dirname(common)));
    return place === undefined
      ? null
      : {
          workspace: place.workspace,
          project: place.projectId,
          root: realpathOrSelf(toplevel),
          repositoryId: place.repositoryId,
        };
  };

  /** What the workspace calls a person. */
  const nameIn = (slug: string, email: string) => {
    const workspace = currentState().persisted.workspaces.find((w) => w.slug === slug);
    for (const project of workspace?.manifest?.projects ?? []) {
      const name = project.members.find((member) => member.email === email)?.name;
      if (name !== undefined && name !== "") return name;
    }
    // Someone the manifest does not name yet: ana.novak@… reads as Ana.
    const local = email.split("@")[0]?.split(/[._-]/)[0] ?? email;
    return local === "" ? email : `${local[0]?.toUpperCase() ?? ""}${local.slice(1)}`;
  };

  /**
   * The Peer thread whose agent runs as a provider session, by the session id
   * its harness gives hooks: Peer starts Claude Code with its thread's native
   * id, and Codex's thread id is it too. Threads at work come first, since a
   * session's hooks start as its thread's turn does.
   */
  const threadOfSession = (nativeId: string) =>
    Effect.gen(function* () {
      const shell = yield* projections.getShellSnapshot({ location: "active" });
      // Only threads at work, or whose run started lately: a session's hooks start with its run.
      const lately = DateTime.toEpochMillis(yield* DateTime.now) - 15 * 60 * 1000;
      const candidates = shell.threads
        .filter(
          (thread) =>
            (thread.activityRunStatus ?? null) !== null ||
            (thread.latestRunStartedAt !== undefined &&
              thread.latestRunStartedAt !== null &&
              DateTime.toEpochMillis(thread.latestRunStartedAt) > lately),
        )
        .slice(0, 20);
      for (const thread of candidates) {
        const records = yield* projections.getThreadRecords(thread.id, ["providerThreads"]);
        if (
          records.providerThreads.some(
            (p) =>
              p.id === thread.activeProviderThreadId && p.nativeThreadRef?.nativeId === nativeId,
          )
        ) {
          return `peer:${thread.id}`;
        }
      }
      return undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));

  const withHub = <A>(
    call: (hubUrl: string, session: string) => Effect.Effect<A, PeerHubError>,
  ): Promise<A> =>
    Effect.runPromise(
      requireSession.pipe(Effect.flatMap(({ hubUrl, session }) => call(hubUrl, session))),
    );

  const herdrCoordinationReport = (
    workspace: string,
    reported: ReadonlyArray<HubApi.ReportedSession>,
  ) => {
    const s = currentState();
    return (s.herdr ?? []).flatMap((agent): HubApi.ReportedSession[] => {
      if (agent.place?.workspace !== workspace) return [];
      const id = agentKey(agent).replace(/^herdr:/, "");
      if (reported.some((session) => session.id === id)) return [];
      return [
        {
          id,
          project: agent.place.projectId,
          label: agent.title,
          ...(agent.agent === undefined ? {} : { agent: agent.agent }),
          status: agent.status,
          ...(agent.branch === undefined ? {} : { branch: agent.branch }),
          files: agent.postHocPaths ?? [],
          claims: [],
          ...(assignedTask(s.persisted, agentKey(agent), workspace, agent.place.projectId) ===
          undefined
            ? {}
            : {
                task: assignedTask(s.persisted, agentKey(agent), workspace, agent.place.projectId)!,
              }),
        },
      ];
    });
  };

  const coordinationReport = (
    workspace: string,
    sessions: ReadonlyArray<HubApi.ReportedSession>,
  ) => {
    const primary = [
      ...new Map(
        [...appMemoryReport(workspace), ...sessions].map((session) => [session.id, session]),
      ).values(),
    ];
    const observations = herdrCoordinationReport(workspace, primary);
    const report = Herdr.boundHerdrObservations(primary, observations);
    herdrReportsSkipped.set(workspace, report.skipped);
    return report.sessions;
  };

  const startBroker = Effect.tryPromise({
    try: async () => {
      if (broker !== null) return;
      const created = new CoordinationBroker({
        socketPath: coordinationSocket,
        scriptsDir: coordinationDir,
        logPath: coordinationLog,
        environment: environmentId,
        memory: {
          prepare: (session, source) => Effect.runPromise(memory.prepareSession(session, source)),
          notice: (session) => Effect.runPromise(memory.sessionNotice(session)),
          cli: (session, command, args) => Effect.runPromise(memoryCli.run(session, command, args)),
          checkpoint: (session, reason) => Effect.runPromise(memory.checkpoint(session, reason)),
          end: (session) => Effect.runPromise(memory.endSession(session)),
          legacySnapshot: (session, text, source) =>
            Effect.runPromise(memory.legacySnapshot(session, text, source)),
        },
        placeOf,
        branchOf: async (root) => {
          const name = await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]).catch(
            () => "",
          );
          return name === "" || name === "HEAD" ? undefined : name;
        },
        runtimeStatus: (id, thread, pane) => {
          const agent = currentState().herdr?.find(
            (candidate) =>
              agentKey(candidate) === `herdr:${id}` &&
              (pane === undefined || candidate.paneId === pane),
          );
          if (agent !== undefined) return agent.status;
          if (thread !== undefined)
            return runtimeClock.currentTimeMillisUnsafe() - nativeRuntimesAt < 180_000
              ? (nativeRuntimes.get(`${thread}/${id}`) ?? null)
              : null;
          return pane === undefined ? undefined : null;
        },
        work: (workspace, project) =>
          currentState().work.get(sharedKey(workspace, project))?.threads ?? [],
        herdrTitle: (pane) => currentState().herdr?.find((agent) => agent.paneId === pane)?.title,
        herdrPane: (agent, cwd, named) => {
          const here = realDirectory(cwd);
          const panes = (currentState().herdr ?? []).filter((candidate) => {
            if (candidate.agent !== agent || candidate.cwd === undefined) return false;
            const there = realDirectory(candidate.cwd);
            return here === there || here.startsWith(`${there}/`) || there.startsWith(`${here}/`);
          });
          if (named !== undefined && panes.some((candidate) => candidate.paneId === named)) {
            return named;
          }
          return panes.length === 1 ? panes[0]?.paneId : undefined;
        },
        queueCodex: async (session, text) => {
          // The coordination lab's made-up sessions are no threads of this person's Codex.
          if (process.env.PEER_CODEX_QUEUE === "off") return false;
          return run("codex", ["queue", "--thread", session, "--message", text], {
            timeoutMs: 20_000,
          }).then(
            () => true,
            () => false,
          );
        },
        wakeRuntime: async (nativeId, _pane, text) => {
          const agent = currentState().herdr?.find(
            (candidate) => agentKey(candidate) === `herdr:${nativeId}`,
          );
          if (agent === undefined) return { status: "unavailable" as const };
          return Herdr.wakeHerdrAgent({ ...agent, session: sessionOf(agent) }, text);
        },
        nameOf: nameIn,
        email: () => currentState().persisted.email,
        policy: () => currentState().persisted.coordination?.policy ?? "coordinate",
        report: (workspace, sessions) =>
          withHub((hubUrl, session) =>
            hubApi.reportCoordination(hubUrl, session, workspace, {
              environment: environmentId,
              sessions: coordinationReport(workspace, sessions),
            }),
          ),
        view: (workspace) =>
          withHub((hubUrl, session) => hubApi.coordination(hubUrl, session, workspace)),
        note: (workspace, project, overlap, text, author, op) =>
          withHub((hubUrl, session) =>
            hubApi.noteOverlap(hubUrl, session, workspace, project, overlap, {
              ...(author === undefined ? {} : { session: author }),
              text,
              ...(op === undefined ? {} : { op }),
            }),
          ),
        resolve: (workspace, project, overlap, resolution, author, op) =>
          withHub((hubUrl, session) =>
            hubApi.resolveOverlap(hubUrl, session, workspace, project, overlap, {
              ...(author === undefined ? {} : { session: author }),
              resolution,
              ...(op === undefined ? {} : { op }),
            }),
          ),
        intent: (workspace, project, request, timeoutMs) =>
          withHub((hubUrl, session) =>
            hubApi.intent(hubUrl, session, workspace, project, request, { timeoutMs }),
          ),
        ack: (workspace, project, overlap, agentSession, op, filesAt) =>
          withHub((hubUrl, session) =>
            hubApi.ack(hubUrl, session, workspace, project, overlap, {
              session: agentSession,
              op,
              ...(filesAt === undefined ? {} : { filesAt }),
            }),
          ),
        workspaces: () => {
          const s = currentState();
          return s.persisted.email === null ? [] : s.persisted.workspaces.map((w) => w.slug);
        },
        notify: (title, body) => void Herdr.notifyHerdr(title, body),
        changed: () => void Effect.runFork(publish.pipe(Effect.ignore)),
        contextsDir: coordinationContexts,
        taskOf: (workspace, project, keys, texts) => {
          const s = currentState();
          for (const key of keys) {
            const assigned = s.persisted.assignments?.[key];
            if (
              assigned !== undefined &&
              assigned.workspace === workspace &&
              assigned.project === project
            ) {
              return assigned.task;
            }
          }
          return taskNamed(s.work.get(sharedKey(workspace, project))?.tasks ?? [], texts);
        },
        threadOf: (nativeId) => Effect.runPromise(threadOfSession(nativeId)),
        tasks: (workspace, project) =>
          currentState().work.get(sharedKey(workspace, project))?.tasks ?? [],
        finishTask: (workspace, project, task, agentSession, status, op) =>
          withHub((hubUrl, session) =>
            hubApi.updateTask(hubUrl, session, workspace, project, task, {
              status,
              session: agentSession,
              environment: environmentId,
              op,
            }),
          ).then(() => {
            void Effect.runFork(refreshWork.pipe(Effect.ignore));
          }),
        taskName: (workspace, project, task) => {
          const found = currentState()
            .work.get(sharedKey(workspace, project))
            ?.tasks.find((candidate) => candidate.id === task);
          if (found === undefined) return task;
          return found.key === undefined ? found.title : `${found.key} · ${found.title}`;
        },
        readContext: (workspace, project, scope) =>
          withHub((hubUrl, session) =>
            hubApi.readContext(hubUrl, session, workspace, project, scope),
          ),
        contextRead: (workspace, project, scope, agentSession, version, op) =>
          withHub((hubUrl, session) =>
            hubApi.contextRead(hubUrl, session, workspace, project, scope, {
              environment: environmentId,
              session: agentSession,
              version,
              op,
            }),
          ),
        staleReads: (workspace, project, agentSession) =>
          withHub((hubUrl, session) =>
            hubApi.staleReads(hubUrl, session, workspace, project, {
              environment: environmentId,
              session: agentSession,
            }),
          ),
        coordEvents: (workspace, project, filter) =>
          withHub((hubUrl, session) =>
            hubApi.coordEvents(hubUrl, session, workspace, project, filter),
          ),
        projectGuidance: async (root) => (await Knowledge.projectGuidance(root))?.text ?? null,
        gitStatus: (root) =>
          run("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
            raw: true,
          }),
        taskDone: (workspace, project, task) =>
          currentState()
            .work.get(sharedKey(workspace, project))
            ?.tasks.find((candidate) => candidate.id === task)?.status === "done",
        contextVersions: (workspace, project, scope) =>
          withHub((hubUrl, session) =>
            hubApi.contextVersions(hubUrl, session, workspace, project, scope),
          ),
        readContextVersion: (workspace, project, scope, version) =>
          withHub((hubUrl, session) =>
            hubApi.contextVersion(hubUrl, session, workspace, project, scope, version),
          ),
        keepContext: (workspace, project, scope, agentSession, release, epoch, op) =>
          withHub((hubUrl, session) =>
            hubApi.keepContext(hubUrl, session, workspace, project, scope, {
              environment: environmentId,
              session: agentSession,
              ...(release ? { release: true } : {}),
              ...(epoch === undefined ? {} : { epoch }),
              ...(op === undefined ? {} : { op }),
            }),
          ),
        writeContext: (workspace, project, scope, agentSession, baseVersion, text, epoch, op) =>
          withHub((hubUrl, session) =>
            hubApi.writeContext(hubUrl, session, workspace, project, scope, {
              environment: environmentId,
              session: agentSession,
              baseVersion,
              text,
              ...(epoch === undefined ? {} : { epoch }),
              ...(op === undefined ? {} : { op }),
            }),
          ),
      });
      await created.start();
      broker = created;
    },
    catch: (failure) =>
      hubError(
        `Agent coordination could not start: ${failure instanceof Error ? failure.message : String(failure)}`,
      ),
  });

  const stopBroker = Effect.promise(async () => {
    const running = broker;
    broker = null;
    await running?.stop();
  });
  yield* Effect.addFinalizer(() => stopBroker);

  const setCoordination: PeerHub["Service"]["setCoordination"] = Effect.fn(
    "PeerHub.setCoordination",
  )(function* (input) {
    if (input.claudeMod === true) {
      const cli = commandPath("claude");
      if (cli === null)
        return yield* hubError(
          "Install Claude Code 2.1.291 or newer on this environment before enabling the Peer Mod.",
        );
      const version = yield* Effect.tryPromise(() =>
        run(cli, ["--version"], { timeoutMs: 3000 }),
      ).pipe(
        Effect.mapError(() =>
          hubError("Could not read Claude Code's version. Check the CLI on this environment."),
        ),
      );
      if (!ClaudeMod.supportsClaudeMod(version))
        return yield* hubError(
          "Update Claude Code to 2.1.291 or newer before enabling the Peer Mod.",
        );
    }
    const current = (yield* Ref.get(stateRef)).persisted.coordination ?? {
      enabled: false,
      policy: "coordinate" as const,
    };
    // Hooks run Peer's scripts, which coordination writes: installing them turns it on.
    const next = {
      enabled:
        input.claudeHooks === true || input.codexHooks === true || input.claudeMod === true
          ? true
          : (input.enabled ?? current.enabled),
      policy: input.policy ?? current.policy,
    };
    yield* updatePersisted((p) => ({ ...p, coordination: next }));
    if (next.enabled) yield* startBroker;
    else yield* stopBroker;
    if (input.claudeHooks !== undefined) {
      const install = input.claudeHooks;
      yield* Effect.tryPromise({
        try: async () => {
          const settings = await readJsonSettings(claudeSettingsPath);
          if (settings === null) {
            throw new Error(`${claudeSettingsPath} is not valid JSON; fix it first`);
          }
          await writeJsonSettings(
            claudeSettingsPath,
            withContextAccess(
              withPeerHooks(
                install ? ClaudeMod.withClaudeMod(settings, claudeModDir, false) : settings,
                claudeHookGroups(peerScripts),
                coordinationDir,
                install,
              ),
              coordinationContexts,
              install,
            ),
          );
          claudeHooksInstalled = install;
          if (install) {
            claudeModInstalled = false;
            ClaudeModRuntime.setClaudeModDirectory(undefined);
          }
        },
        catch: (failure) =>
          hubError(
            `Claude Code's settings could not change: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
      });
    }
    const modChange =
      input.claudeMod ?? (input.enabled === false && claudeModInstalled ? false : undefined);
    if (modChange !== undefined) {
      const install = modChange;
      yield* Effect.tryPromise({
        try: async () => {
          const settings = await readJsonSettings(claudeSettingsPath);
          if (settings === null)
            throw new Error(`${claudeSettingsPath} is not valid JSON; fix it first`);
          if (install)
            await ClaudeMod.writeClaudeMod({
              directory: claudeModDir,
              socketPath: coordinationSocket,
              peerScript: peerCommand,
            });
          await writeJsonSettings(
            claudeSettingsPath,
            withContextAccess(
              ClaudeMod.withClaudeMod(
                install
                  ? withPeerHooks(settings, claudeHookGroups(peerScripts), coordinationDir, false)
                  : settings,
                claudeModDir,
                install,
              ),
              coordinationContexts,
              install || claudeHooksInstalled,
            ),
          );
          claudeModInstalled = install;
          if (install) claudeHooksInstalled = false;
          ClaudeModRuntime.setClaudeModDirectory(install ? claudeModDir : undefined);
          if (!install) await ClaudeMod.removeClaudeMod(claudeModDir);
        },
        catch: (failure) =>
          hubError(
            `Claude Code's Peer Mod could not change: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
      });
    }
    if (input.codexHooks !== undefined) {
      const install = input.codexHooks;
      yield* Effect.tryPromise({
        try: async () => {
          const hooks = await readJsonSettings(codexHooksPath);
          if (hooks === null) {
            throw new Error(`${codexHooksPath} is not valid JSON; fix it first`);
          }
          await writeJsonSettings(
            codexHooksPath,
            withPeerHooks(hooks, codexHookGroups(peerScripts), coordinationDir, install),
          );
          await writeCodexRules(install);
          codexHooksInstalled = install;
          codexTrust = { stamp: "", trusted: false };
        },
        catch: (failure) =>
          hubError(
            `Codex's hooks could not change: ${failure instanceof Error ? failure.message : String(failure)}`,
          ),
      });
    }
    return yield* publish;
  });

  const noteOverlap: PeerHub["Service"]["noteOverlap"] = Effect.fn("PeerHub.noteOverlap")(
    function* (input) {
      const running = broker;
      if (running !== null) {
        yield* Effect.tryPromise({
          try: () => running.personNote(input.workspace, input.project, input.overlap, input.text),
          catch: (failure) =>
            hubError(failure instanceof Error ? failure.message : String(failure)),
        });
      } else {
        const { hubUrl, session } = yield* requireSession;
        yield* hubApi.noteOverlap(hubUrl, session, input.workspace, input.project, input.overlap, {
          text: input.text,
        });
      }
      return yield* publish;
    },
  );

  const resolveOverlap: PeerHub["Service"]["resolveOverlap"] = Effect.fn("PeerHub.resolveOverlap")(
    function* (input) {
      const running = broker;
      if (running !== null) {
        yield* Effect.tryPromise({
          try: () =>
            running.personResolve(input.workspace, input.project, input.overlap, input.resolution),
          catch: (failure) =>
            hubError(failure instanceof Error ? failure.message : String(failure)),
        });
      } else {
        const { hubUrl, session } = yield* requireSession;
        yield* hubApi.resolveOverlap(
          hubUrl,
          session,
          input.workspace,
          input.project,
          input.overlap,
          { resolution: input.resolution },
        );
      }
      return yield* publish;
    },
  );

  const settleOverlap: PeerHub["Service"]["settleOverlap"] = Effect.fn("PeerHub.settleOverlap")(
    function* (input) {
      const running = broker;
      if (running === null) {
        return yield* hubError("Turn agent coordination on to have the agents settle it.");
      }
      yield* Effect.tryPromise({
        try: () =>
          running.personSettle(input.workspace, input.project, input.overlap, input.message),
        catch: (failure) => hubError(failure instanceof Error ? failure.message : String(failure)),
      });
      return yield* publish;
    },
  );

  const enableSharedCapacity = (workspace: PersistedWorkspace, project: PeerProject) =>
    Effect.gen(function* () {
      const { hubUrl, session } = yield* requireSession;
      if (project.capacity.shared === undefined) {
        return yield* hubError(`${project.name} has no shared capacity.`);
      }
      const credentials = yield* hubApi.issueCredentials(
        hubUrl,
        session,
        workspace.slug,
        project.id,
        environmentId,
      );
      const claudeModels = credentials.models
        .filter((m) => m.harness.includes("claude"))
        .map((m) => m.id);
      if (claudeModels.length === 0) {
        yield* hubApi
          .revokeCredentials(hubUrl, session, workspace.slug, project.id, environmentId)
          .pipe(Effect.ignoreCause({ log: true }));
        return yield* hubError(
          `${project.name}'s shared capacity has no Claude models for this app yet.`,
        );
      }
      const pick = (family: string) => claudeModels.find((id) => id.includes(family));
      const homePath = NodePath.join(hubHome, workspace.slug, "claude", project.id);
      yield* Effect.tryPromise(() =>
        NodeFSP.mkdir(homePath, { recursive: true, mode: 0o700 }),
      ).pipe(
        Effect.mapError(() => hubError("Could not create the shared capacity's config directory.")),
      );
      const instanceId = sharedInstanceId(workspace.slug, project.id);
      const aliases = [
        ["ANTHROPIC_DEFAULT_OPUS_MODEL", pick("opus")],
        ["ANTHROPIC_DEFAULT_SONNET_MODEL", pick("sonnet")],
        ["ANTHROPIC_DEFAULT_HAIKU_MODEL", pick("haiku")],
      ] as const;
      yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: {
            driver: ProviderDriverKind.make("claudeAgent"),
            displayName: `${project.name} · ${workspace.name} capacity`,
            enabled: true,
            environment: [
              { name: "ANTHROPIC_BASE_URL", value: credentials.baseUrl, sensitive: false },
              { name: "ANTHROPIC_AUTH_TOKEN", value: credentials.apiKey, sensitive: true },
              // An inherited API key must not win over the gateway key.
              { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
              ...aliases.flatMap(([name, value]) =>
                value === undefined ? [] : [{ name, value, sensitive: false }],
              ),
            ],
            // Its own config directory, so no cached subscription login sits next to the gateway key.
            config: { homePath },
          },
        })
        .pipe(Effect.mapError(() => hubError("Could not save the shared capacity provider.")));
      yield* updatePersisted((p) => ({
        ...p,
        sharedInstances: {
          ...p.sharedInstances,
          [sharedKey(workspace.slug, project.id)]: [instanceId],
        },
      }));
    });

  const setSharedCapacity: PeerHub["Service"]["setSharedCapacity"] = Effect.fn(
    "PeerHub.setSharedCapacity",
  )(function* (input) {
    const { workspace, project } = yield* findProject(input.workspace, input.projectId);
    const key = sharedKey(workspace.slug, project.id);
    const clearError = updateRuntime((s) => {
      const sharedErrors = new Map(s.sharedErrors);
      sharedErrors.delete(key);
      return { ...s, sharedErrors };
    });
    if (input.enabled) {
      const result = yield* enableSharedCapacity(workspace, project).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* updateRuntime((s) => ({
          ...s,
          sharedErrors: new Map(s.sharedErrors).set(key, result.failure.detail),
        }));
        yield* publish;
        return yield* result.failure;
      }
    } else {
      yield* turnOffShared(workspace.slug, project.id);
    }
    yield* clearError;
    return yield* publish;
  }, lock.withPermits(1));

  const projectUsage: PeerHub["Service"]["projectUsage"] = Effect.fn("PeerHub.projectUsage")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      return yield* hubApi.projectUsage(hubUrl, session, input.workspace, input.projectId);
    },
  );

  const createTask: PeerHub["Service"]["createTask"] = Effect.fn("PeerHub.createTask")(function* (
    input,
  ) {
    const { hubUrl, session } = yield* requireSession;
    yield* findProject(input.workspace, input.projectId);
    const key = input.key?.trim();
    const area = input.area?.trim();
    yield* hubApi.createTask(hubUrl, session, input.workspace, input.projectId, {
      title: input.title,
      ...(key ? { key } : {}),
      ...(area ? { area } : {}),
    });
    yield* refreshWorkUnlocked;
    return yield* publish;
  }, lock.withPermits(1));

  const updateTask: PeerHub["Service"]["updateTask"] = Effect.fn("PeerHub.updateTask")(function* (
    input,
  ) {
    const { hubUrl, session } = yield* requireSession;
    yield* findProject(input.workspace, input.projectId);
    yield* hubApi.updateTask(hubUrl, session, input.workspace, input.projectId, input.taskId, {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.area === undefined ? {} : { area: input.area }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    yield* refreshWorkUnlocked;
    return yield* publish;
  }, lock.withPermits(1));

  const deleteTask: PeerHub["Service"]["deleteTask"] = Effect.fn("PeerHub.deleteTask")(function* (
    input,
  ) {
    const { hubUrl, session } = yield* requireSession;
    yield* findProject(input.workspace, input.projectId);
    yield* hubApi.deleteTask(hubUrl, session, input.workspace, input.projectId, input.taskId);
    // Threads that worked on it go back to the project's unsorted work.
    yield* updatePersisted((p) => ({
      ...p,
      assignments: Object.fromEntries(
        Object.entries(p.assignments ?? {}).filter(
          ([, a]) =>
            !(
              a.workspace === input.workspace &&
              a.project === input.projectId &&
              a.task === input.taskId
            ),
        ),
      ),
    }));
    yield* refreshWorkUnlocked;
    return yield* publish;
  }, lock.withPermits(1));

  const assignThread: PeerHub["Service"]["assignThread"] = Effect.fn("PeerHub.assignThread")(
    function* (input) {
      yield* findProject(input.workspace, input.projectId);
      const state = yield* Ref.get(stateRef);
      const key = sharedKey(input.workspace, input.projectId);
      const ownsRetained = state.work
        .get(key)
        ?.threads.some(
          (thread) =>
            thread.id === input.thread &&
            thread.email === state.persisted.email &&
            thread.environment === environmentId,
        );
      if (
        !/^(peer|herdr):/.test(input.thread) &&
        !(input.thread.startsWith("retained:") && ownsRetained)
      ) {
        return yield* hubError("Only this computer's work can be placed.");
      }
      yield* updatePersisted((p) => {
        const { [input.thread]: _previous, ...assignments } = p.assignments ?? {};
        return {
          ...p,
          assignments:
            input.taskId === null
              ? assignments
              : {
                  ...assignments,
                  [input.thread]: {
                    workspace: input.workspace,
                    project: input.projectId,
                    task: input.taskId,
                  },
                },
        };
      });
      // Apply a placement to saved work as well, including clearing an old assignment.
      // Mark it open until the hub derives delivery from the newly selected task.
      yield* updateRuntime((current) => {
        const project = current.work.get(key);
        if (project === undefined) return current;
        const work = new Map(current.work);
        work.set(key, {
          ...project,
          threads: project.threads.map((thread) => {
            if (
              thread.id !== input.thread ||
              thread.email !== current.persisted.email ||
              thread.environment !== environmentId
            )
              return thread;
            const { task: _task, ...rest } = thread;
            return {
              ...rest,
              delivery: "open",
              ...(input.taskId === null ? {} : { task: input.taskId }),
            };
          }),
        });
        return { ...current, work };
      });
      yield* refreshWorkUnlocked;
      return yield* publish;
    },
    lock.withPermits(1),
  );

  const focusAgent: PeerHub["Service"]["focusAgent"] = Effect.fn("PeerHub.focusAgent")(
    function* (input) {
      yield* Effect.tryPromise(() => Herdr.focusHerdrAgent(input.paneId)).pipe(
        Effect.mapError(() =>
          hubError("herdr could not bring that agent forward. Is herdr running?"),
        ),
      );
      return yield* publish;
    },
  );

  const goneView = (agentId: string): PeerAgentView => ({
    agentId,
    title: "",
    status: "unknown",
    gone: true,
  });

  /** One of this computer's Peer threads as a view: its latest steps, from its own timeline. */
  const peerThreadView = (key: string, threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* projections.getThreadShell(threadId);
      if (shell === null) return goneView(key);
      const head = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 0 });
      const page = yield* projections.getTimelinePage(threadId, {
        view: "activity",
        limit: 80,
        afterPosition: Math.max(-1, head.totalItems - 81),
      });
      return {
        agentId: key,
        title: shell.title,
        status: shellStatus(shell),
        gone: false,
        entries: AgentTranscript.timelineEntries(page.items),
      } satisfies PeerAgentView;
    }).pipe(Effect.orElseSucceed(() => goneView(key)));

  /** The view of one of this computer's threads, whichever runtime runs it. */
  const ownThreadView = (key: string) =>
    key.startsWith("peer:")
      ? peerThreadView(key, ThreadId.make(key.slice("peer:".length)))
      : agentView(key);

  /** Shared threads whose views go to the hub now, because someone watches them. */
  const publishing = new Map<string, { resend: boolean }>();

  /**
   * Sends a shared thread's view to the hub while someone watches it: at once,
   * then on each change, and every 10 s to learn when the last watcher left.
   */
  const publishThread = (slug: string, key: string) =>
    Effect.gen(function* () {
      let last: PeerAgentView | null = null;
      let sentAt = 0;
      while (true) {
        if (!((yield* Ref.get(stateRef)).persisted.sharedThreads ?? []).includes(key)) return;
        const signedIn = yield* requireSession.pipe(Effect.option);
        if (Option.isNone(signedIn)) return;
        const { hubUrl, session } = signedIn.value;
        const view = yield* ownThreadView(key);
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const asked = publishing.get(key);
        if (
          last === null ||
          !sameAgentView(last, view) ||
          asked?.resend === true ||
          now - sentAt > 10_000
        ) {
          if (asked !== undefined) asked.resend = false;
          const watchers = yield* hubApi
            .publishView(hubUrl, session, slug, environmentId, key, view)
            .pipe(Effect.orElseSucceed(() => 0));
          last = view;
          sentAt = now;
          if (watchers === 0) return;
        }
        yield* Effect.sleep("1500 millis");
      }
    }).pipe(Effect.ensuring(Effect.sync(() => publishing.delete(key))));

  /** Someone started watching one of this computer's shared threads. */
  const startPublishing = (slug: string, key: string) =>
    Effect.gen(function* () {
      const active = publishing.get(key);
      if (active !== undefined) {
        // A new watcher needs the current view now, not at the next change.
        active.resend = true;
        return;
      }
      if (!((yield* Ref.get(stateRef)).persisted.sharedThreads ?? []).includes(key)) return;
      publishing.set(key, { resend: false });
      yield* publishThread(slug, key).pipe(
        Effect.ignoreCause({ log: true }),
        Effect.forkIn(layerScope),
      );
    });

  const shareThread: PeerHub["Service"]["shareThread"] = Effect.fn("PeerHub.shareThread")(
    function* (input) {
      if (!/^(peer|herdr):/.test(input.thread)) {
        return yield* hubError("Only this computer's threads and herdr agents can be shared.");
      }
      yield* updatePersisted((p) => {
        const shared = new Set(p.sharedThreads ?? []);
        if (input.shared) shared.add(input.thread);
        else shared.delete(input.thread);
        return { ...p, sharedThreads: [...shared] };
      });
      yield* refreshWorkUnlocked;
      return yield* publish;
    },
    lock.withPermits(1),
  );

  const observeThread: PeerHub["Service"]["observeThread"] = (input) =>
    Stream.unwrap(
      requireSession.pipe(
        Effect.map(({ hubUrl, session }) =>
          hubApi.observe(hubUrl, session, input.workspace, input.environment, input.thread),
        ),
      ),
    ).pipe(
      // The hub ends a stream every 15 minutes; watching goes on.
      Stream.forever,
    );

  const readContext: PeerHub["Service"]["readContext"] = (input) =>
    requireSession.pipe(
      Effect.flatMap(({ hubUrl, session }) =>
        hubApi.readContext(hubUrl, session, input.workspace, input.project, input.scope),
      ),
      Effect.map((context) =>
        context === null
          ? null
          : { ...context, workspace: input.workspace, bytes: context.bytes ?? context.text.length },
      ),
    );

  const getCoordEvents: PeerHub["Service"]["getCoordEvents"] = Effect.fn("PeerHub.getCoordEvents")(
    function* (input) {
      yield* findProject(input.workspace, input.project);
      const { hubUrl, session } = yield* requireSession;
      return yield* hubApi.coordEvents(hubUrl, session, input.workspace, input.project, {
        ...(input.task === undefined ? {} : { task: input.task }),
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
    },
  );

  const getStaleReads: PeerHub["Service"]["getStaleReads"] = Effect.fn("PeerHub.getStaleReads")(
    function* (input) {
      yield* findProject(input.workspace, input.project);
      const { hubUrl, session } = yield* requireSession;
      return yield* hubApi.staleReads(hubUrl, session, input.workspace, input.project, input);
    },
  );

  const contextVersions: PeerHub["Service"]["contextVersions"] = (input) =>
    requireSession.pipe(
      Effect.flatMap(({ hubUrl, session }) =>
        hubApi.contextVersions(hubUrl, session, input.workspace, input.project, input.scope),
      ),
    );

  const readContextVersion: PeerHub["Service"]["readContextVersion"] = (input) =>
    requireSession.pipe(
      Effect.flatMap(({ hubUrl, session }) =>
        hubApi.contextVersion(
          hubUrl,
          session,
          input.workspace,
          input.project,
          input.scope,
          input.version,
        ),
      ),
    );

  const restoreContext: PeerHub["Service"]["restoreContext"] = Effect.fn("PeerHub.restoreContext")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      yield* hubApi.restoreContext(
        hubUrl,
        session,
        input.workspace,
        input.project,
        input.scope,
        input.version,
      );
      // Its keeper here, if any, hears of it at its next step; the status follows the new version.
      broker?.hubChanged();
      return yield* publish;
    },
  );

  const knowledgeCandidates: PeerHub["Service"]["knowledgeCandidates"] = (input) =>
    requireSession.pipe(
      Effect.flatMap(({ hubUrl, session }) =>
        hubApi.candidates(hubUrl, session, input.workspace, input.project),
      ),
    );

  const decideCandidate: PeerHub["Service"]["decideCandidate"] = Effect.fn(
    "PeerHub.decideCandidate",
  )(function* (input) {
    const { hubUrl, session } = yield* requireSession;
    yield* hubApi.decideCandidate(
      hubUrl,
      session,
      input.workspace,
      input.project,
      input.id,
      input.status,
    );
    // The count waiting in Work follows from the next view.
    broker?.hubChanged();
    return yield* publish;
  });

  // ---- the project's knowledge (kontext, `.ai/` in its repository) ----

  let kontextInstalled: boolean | undefined;
  const kontextAvailable = Effect.promise(async () => {
    kontextInstalled ??=
      (await Knowledge.runKontext(["--version"], NodeOS.homedir(), undefined, 15_000)).code === 0;
    return kontextInstalled;
  });
  /** Wording entries with kontext's llm adapter runs on this person's own account; off for tests. */
  const knowledgeLlm = process.env.PEER_KNOWLEDGE_LLM !== "off";
  const lastLine = (run: Knowledge.KontextRun) =>
    `${run.stderr}\n${run.stdout}`.trim().split("\n").at(-1) ?? `exit ${run.code}`;

  /** A workspace project's checkouts on this computer, the one that keeps kontext knowledge first. */
  const knowledgeCheckouts = (s: RuntimeState, workspace: string, projectId: string) => {
    const project = s.persisted.workspaces
      .find((candidate) => candidate.slug === workspace)
      ?.manifest?.projects.find((candidate) => candidate.id === projectId);
    return (project?.repositories ?? [])
      .filter((repo) => safeId(repo.id))
      .map((repo) => checkoutPath(s.persisted, workspace, projectId, repo.id))
      .filter((path) => hasGitCheckout(path))
      .toSorted((a, b) => Number(Knowledge.hasStore(b)) - Number(Knowledge.hasStore(a)));
  };

  /** A task as people name it on this computer, or the project's work outside tasks. */
  const workName = (s: RuntimeState, workspace: string, projectId: string, task?: string) => {
    if (task === undefined) return "work outside tasks";
    const found = s.work.get(sharedKey(workspace, projectId))?.tasks.find((t) => t.id === task);
    return found === undefined
      ? task
      : found.key === undefined
        ? found.title
        : `${found.key} · ${found.title}`;
  };

  const knowledgeStatusOf = (workspace: string, projectId: string) =>
    Effect.gen(function* () {
      const [checkout] = knowledgeCheckouts(yield* Ref.get(stateRef), workspace, projectId);
      const kontext = yield* kontextAvailable;
      const store = checkout !== undefined && Knowledge.hasStore(checkout);
      const guidance =
        checkout !== undefined && store
          ? yield* Effect.promise(() => Knowledge.projectGuidance(checkout))
          : null;
      return {
        checkout: checkout ?? null,
        store,
        kontext,
        llm: kontext && knowledgeLlm,
        guidance: guidance?.text ?? null,
      } satisfies PeerKnowledgeStatus;
    });

  /** The checkout keeping the project's knowledge here, or why there is none. */
  const knowledgeStore = (workspace: string, projectId: string) =>
    Effect.gen(function* () {
      const status = yield* knowledgeStatusOf(workspace, projectId);
      if (status.checkout === null) {
        return yield* hubError("This project is not on this computer: clone it first.");
      }
      if (!status.kontext) {
        return yield* hubError("kontext is not installed here (semans.github.io/kontext).");
      }
      if (!status.store) {
        return yield* hubError(
          `This project keeps no knowledge yet: set it up (kontext init in ${status.checkout}).`,
        );
      }
      return { ...status, checkout: status.checkout };
    });

  const knowledgeStatus: PeerHub["Service"]["knowledgeStatus"] = (input) =>
    knowledgeStatusOf(input.workspace, input.project);

  const setupKnowledge: PeerHub["Service"]["setupKnowledge"] = Effect.fn("PeerHub.setupKnowledge")(
    function* (input) {
      const status = yield* knowledgeStatusOf(input.workspace, input.project);
      const checkout = status.checkout;
      if (checkout === null) {
        return yield* hubError("This project is not on this computer: clone it first.");
      }
      if (!status.kontext) {
        return yield* hubError("kontext is not installed here (semans.github.io/kontext).");
      }
      if (!status.store) {
        const run = yield* Effect.promise(() => Knowledge.runKontext(["init"], checkout));
        if (run.code !== 0) return yield* hubError(`kontext init failed: ${lastLine(run)}`);
      }
      return yield* knowledgeStatusOf(input.workspace, input.project);
    },
  );

  const keepCandidate: PeerHub["Service"]["keepCandidate"] = Effect.fn("PeerHub.keepCandidate")(
    function* (input) {
      const store = yield* knowledgeStore(input.workspace, input.project);
      const checkout = store.checkout;
      const { hubUrl, session } = yield* requireSession;
      const candidate = (yield* hubApi.candidates(
        hubUrl,
        session,
        input.workspace,
        input.project,
      )).find((one) => one.id === input.id);
      if (candidate === undefined) return yield* hubError("That candidate is no longer there.");
      const s = yield* Ref.get(stateRef);
      const where = (task: string | undefined) => workName(s, input.workspace, input.project, task);
      const kontext = (args: ReadonlyArray<string>, stdin?: string) =>
        Effect.promise(() => Knowledge.runKontext(args, checkout, stdin));
      // An entry already in the knowledge may say the same: the person checks before committing.
      const related = Knowledge.relatedTitle(
        (yield* kontext(["search", "--json", "-n", "3", "-s", "local", candidate.text])).stdout,
      );
      const kind = candidate.kind ?? "learning";
      let id: string | null = null;
      // Why kontext's model did not word it, when it is kept as the agents wrote it.
      let asWritten: string | null = null;
      if (candidate.detail !== undefined) {
        // Already worded, e.g. read from a task's context: written as it is.
        const run = yield* kontext([
          "capture",
          "--kind",
          kind,
          "--title",
          candidate.text,
          "--body",
          candidate.detail,
        ]);
        id = Knowledge.capturedId(run.stdout);
      } else if (store.llm) {
        // kontext words it, with the shared context of the work it came from.
        const task = candidate.sources[0]?.task;
        const scope = task === undefined ? "project" : `task:${task}`;
        const context = yield* hubApi
          .readContext(hubUrl, session, input.workspace, input.project, scope)
          .pipe(Effect.orElseSucceed(() => null));
        const run = yield* kontext(
          ["distill", "--max", "1", "-"],
          Knowledge.keepThread({
            project: input.project,
            candidate,
            where,
            context: context === null ? undefined : { subject: where(task), text: context.text },
          }),
        );
        id = Knowledge.distilledIds(run.stdout)[0] ?? null;
        if (id === null) asWritten = Knowledge.distillMiss(run);
      }
      if (id === null) {
        const run = yield* kontext([
          "capture",
          "--kind",
          kind,
          "--title",
          Knowledge.titleOf(candidate.text),
          "--body",
          Knowledge.directBody(candidate, where),
        ]);
        id = Knowledge.capturedId(run.stdout);
        if (id === null) return yield* hubError(`kontext did not take it: ${lastLine(run)}`);
      }
      const promoted = yield* kontext(["promote", id]);
      const path = Knowledge.promotedPath(promoted.stdout);
      if (path === null)
        return yield* hubError(`kontext could not write it: ${lastLine(promoted)}`);
      const entry = Knowledge.entryParts(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(checkout, path), "utf8").catch(() => ""),
        ),
      );
      const keptAs = {
        path,
        title: entry.fields.title ?? Knowledge.titleOf(candidate.text),
        kind: entry.fields.kind ?? kind,
      };
      yield* hubApi.decideCandidate(
        hubUrl,
        session,
        input.workspace,
        input.project,
        input.id,
        "promoted",
        keptAs,
      );
      broker?.hubChanged();
      yield* publish;
      return { checkout, keptAs, related, asWritten };
    },
  );

  const harvestContext: PeerHub["Service"]["harvestContext"] = Effect.fn("PeerHub.harvestContext")(
    function* (input) {
      const store = yield* knowledgeStore(input.workspace, input.project);
      if (!store.llm) {
        return yield* hubError("Reading a context for what to keep needs kontext's llm adapter.");
      }
      const { hubUrl, session } = yield* requireSession;
      const context = yield* hubApi.readContext(
        hubUrl,
        session,
        input.workspace,
        input.project,
        input.scope,
      );
      if (context === null || context.text.trim() === "") {
        return yield* hubError("Nobody has written that context yet.");
      }
      const task = input.scope.startsWith("task:") ? input.scope.slice("task:".length) : undefined;
      const s = yield* Ref.get(stateRef);
      const run = yield* Effect.promise(() =>
        Knowledge.runKontext(
          ["distill", "--dry-run", "--max", "3", "-"],
          store.checkout,
          Knowledge.harvestThread({
            project: input.project,
            subject: workName(s, input.workspace, input.project, task),
            text: context.text,
          }),
        ),
      );
      if (run.code !== 0) return yield* hubError(`kontext could not read it: ${lastLine(run)}`);
      const entries = Knowledge.dryRunEntries(run.stdout);
      for (const entry of entries) {
        yield* hubApi.proposeCandidate(hubUrl, session, input.workspace, input.project, {
          text: entry.title,
          kind: entry.kind,
          detail:
            entry.paths.length === 0
              ? entry.body
              : `${entry.body}\n\nFiles: ${entry.paths.join(", ")}`,
          ...(task === undefined ? {} : { task }),
          origin: `context:${input.scope}@v${context.version}`,
        });
      }
      broker?.hubChanged();
      return { proposed: entries.length };
    },
  );

  const improveGuidance: PeerHub["Service"]["improveGuidance"] = Effect.fn(
    "PeerHub.improveGuidance",
  )(function* (input) {
    const store = yield* knowledgeStore(input.workspace, input.project);
    if (!store.llm) return yield* hubError("Proposing guidance needs kontext's llm adapter.");
    const { hubUrl, session } = yield* requireSession;
    const candidates = yield* hubApi.candidates(hubUrl, session, input.workspace, input.project);
    // The labels are people's decisions on what agents marked; a harvest is not an agent's mark.
    const marked = (candidate: (typeof candidates)[number]) =>
      candidate.sources.some((source) => source.tagged && source.origin === undefined);
    const decided = candidates.filter((candidate) => candidate.status !== "proposed");
    if (decided.length < 3) {
      return yield* hubError(
        `Keep or dismiss a few more candidates first: ${decided.length} decided, 3 needed.`,
      );
    }
    const current = yield* Effect.promise(() => Knowledge.projectGuidance(store.checkout));
    const run = yield* Effect.promise(() =>
      Knowledge.runKontext(
        ["distill", "--dry-run", "--max", "1", "-"],
        store.checkout,
        Knowledge.guidanceThread({
          project: input.project,
          current: current?.text ?? null,
          kept: decided.filter((c) => c.status === "promoted" && marked(c)).map((c) => c.text),
          dismissed: decided
            .filter((c) => c.status === "dismissed" && marked(c))
            .map((c) => c.text),
          missed: decided.filter((c) => c.status === "promoted" && !marked(c)).map((c) => c.text),
        }),
      ),
    );
    const [entry] = Knowledge.dryRunEntries(run.stdout);
    if (entry === undefined) return yield* hubError(`kontext proposed nothing: ${lastLine(run)}`);
    const capture = yield* Effect.promise(() =>
      Knowledge.runKontext(
        [
          "capture",
          "--kind",
          "convention",
          "--tags",
          "peer-skill",
          "--title",
          entry.title,
          "--body",
          entry.body,
          ...(current === null ? [] : ["--supersedes", current.id]),
        ],
        store.checkout,
      ),
    );
    const id = Knowledge.capturedId(capture.stdout);
    if (id === null) return yield* hubError(`kontext did not take it: ${lastLine(capture)}`);
    const promoted = yield* Effect.promise(() =>
      Knowledge.runKontext(["promote", id], store.checkout),
    );
    const path = Knowledge.promotedPath(promoted.stdout);
    if (path === null) return yield* hubError(`kontext could not write it: ${lastLine(promoted)}`);
    return { checkout: store.checkout, path, title: entry.title };
  });

  const watchAgent: PeerHub["Service"]["watchAgent"] = (input) =>
    Stream.tick("1 second").pipe(
      Stream.mapEffect(() => agentView(input.agentId)),
      Stream.changesWith(sameAgentView),
    );

  const promptAgent: PeerHub["Service"]["promptAgent"] = Effect.fn("PeerHub.promptAgent")(
    function* (input) {
      const agent = ((yield* Ref.get(stateRef)).herdr ?? []).find(
        (candidate) =>
          agentKey(candidate) === input.agentId ||
          `herdr:${candidate.terminalId}` === input.agentId,
      );
      if (agent === undefined) return yield* hubError("That agent no longer runs in herdr.");
      if (agent.status === "blocked") {
        return yield* hubError(
          "It is waiting for an answer in its terminal. Answer it in herdr first.",
        );
      }
      yield* Effect.tryPromise(() => Herdr.promptHerdrAgent(agent.paneId, input.text)).pipe(
        Effect.mapError((error) =>
          hubError(
            `herdr did not take the prompt${error.cause instanceof Error ? `: ${error.cause.message}` : "."}`,
          ),
        ),
      );
      yield* refreshHerdr;
      return yield* publish;
    },
  );

  const startAgent: PeerHub["Service"]["startAgent"] = Effect.fn("PeerHub.startAgent")(
    function* (input) {
      yield* requireSession;
      const { workspace, project } = yield* findProject(input.workspace, input.projectId);
      const task = (yield* Ref.get(stateRef)).work
        .get(sharedKey(workspace.slug, project.id))
        ?.tasks.find((task) => task.id === input.taskId);
      if (task === undefined || task.status === "done")
        return yield* hubError("Select an open task in this project first.");
      const repository = project.repositories.find(
        (repository) => repository.id === input.repositoryId,
      );
      if (repository === undefined || !safeId(repository.id))
        return yield* hubError("That repository does not belong to this project.");
      if (project.capacity.personal !== "any")
        return yield* hubError(
          "This project needs an approved commercial or shared provider. Start a Peer thread with an allowed provider instead.",
        );
      if ((yield* Effect.promise(() => Herdr.listHerdrAgents())) === null)
        return yield* hubError(
          "herdr is not running on this environment. Install it from https://herdr.dev/docs/install/, start herdr here, then try again.",
        );
      const checkout = checkoutPath(
        (yield* Ref.get(stateRef)).persisted,
        workspace.slug,
        project.id,
        repository.id,
      );
      const tree = yield* Effect.tryPromise(() =>
        Herdr.prepareHerdrTaskWorktree({
          checkout,
          baseBranch: repository.branch,
          worktrees: NodePath.join(
            workspaceRoot,
            ".worktrees",
            workspace.slug,
            project.id,
            repository.id,
          ),
          task: task.key ?? task.id,
        }),
      ).pipe(
        Effect.mapError((error) =>
          hubError(
            `Could not prepare the task checkout: ${error.cause instanceof Error ? error.cause.message : "check the local repository branch."}`,
          ),
        ),
      );
      const started = yield* Effect.tryPromise(() =>
        Herdr.startHerdrAgent({
          cwd: tree.cwd,
          harness: input.harness,
          env: {
            PEER_TASK: task.key ?? task.id,
            ...(claudeModInstalled && input.harness === "claude"
              ? { PEER_CLAUDE_MOD_DIR: claudeModDir }
              : {}),
          },
        }),
      ).pipe(
        Effect.mapError((error) =>
          hubError(
            `herdr did not start the agent${error.cause instanceof Error ? `: ${error.cause.message}` : "."} The task checkout remains at ${tree.cwd}.`,
          ),
        ),
      );
      yield* updatePersisted((p) => ({
        ...p,
        assignments: {
          ...p.assignments,
          [`herdr:${started.terminalId}`]: {
            workspace: workspace.slug,
            project: project.id,
            task: task.id,
          },
        },
      }));
      // Show it at once; herdr's events would say within a moment.
      yield* refreshHerdr;
      const agent = ((yield* Ref.get(stateRef)).herdr ?? []).find(
        (agent) => agent.terminalId === started.terminalId,
      );
      let promptError = started.promptError;
      if (agent !== undefined) {
        yield* keepAssignments([agent]);
        if (agent.status === "blocked")
          promptError =
            "The agent is waiting for an answer in herdr. Answer it there, then send the task prompt.";
        else {
          const prompt =
            input.prompt?.trim() ||
            `${task.key === undefined ? "" : `${task.key}: `}${task.title}. Work in your own checkout and coordinate shared changes through Peer.`;
          const sent = yield* Effect.tryPromise(() =>
            Herdr.promptHerdrAgent(agent.name ?? agent.paneId, prompt),
          ).pipe(Effect.result);
          if (sent._tag === "Failure")
            promptError = `The task prompt could not be confirmed. Read the agent before retrying: ${sent.failure.cause instanceof Error ? sent.failure.cause.message : "herdr did not answer"}.`;
        }
      } else
        promptError =
          "The agent started but is not visible yet. Check herdr before sending its task prompt.";
      yield* refreshWork;
      yield* publish;
      return { ...started, ...(promptError === undefined ? {} : { promptError }) };
    },
  );

  /** What sharing gives the workspace: one repository, and where it is checked out here if it is. */
  interface SharedRepository {
    readonly name: string;
    readonly repoId: string;
    readonly url: string;
    readonly branch: string;
    readonly root: string | null;
  }

  /** A project on this computer: its origin, and the branch that remote starts from. */
  const localRepository = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const local = yield* projects
        .getById(projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(local)) return yield* hubError("That project is not on this computer.");
      const { title, workspaceRoot: root } = local.value;
      const url = yield* Effect.tryPromise(() =>
        run("git", ["-C", root, "remote", "get-url", "origin"]),
      ).pipe(
        Effect.mapError(() =>
          hubError(
            `${title} has no git remote named origin. Push it where your team can clone it, or share its repository by address.`,
          ),
        ),
      );
      if (!isSafeGitRemote(url)) {
        return yield* hubError(`${title}'s origin is not an address colleagues can clone.`);
      }
      // Colleagues start from the remote's own branch, not whatever is checked out here.
      const remoteHead = yield* Effect.tryPromise(() =>
        run("git", ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
      ).pipe(Effect.orElseSucceed(() => ""));
      const head =
        remoteHead.replace(/^origin\//, "") ||
        (yield* Effect.tryPromise(() =>
          run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]),
        ).pipe(Effect.orElseSucceed(() => "")));
      return {
        name: title,
        repoId: idFromName(NodePath.basename(root), "repo"),
        url,
        branch: head === "" || head === "HEAD" ? "main" : head,
        root,
      } satisfies SharedRepository;
    });

  /**
   * A repository by its address, GitHub's `owner/repo` or a clone URL, as
   * "Add project" takes one. Asking it for its default branch also shows
   * that the person sharing it can open it.
   */
  const addressedRepository = (address: string) =>
    Effect.gen(function* () {
      const github = gitHubRepository(address);
      if (github === null && !isSafeGitRemote(address)) {
        return yield* hubError(
          `"${address}" is not a repository address. Enter GitHub's owner/repo or a clone URL.`,
        );
      }
      const url = github?.httpsUrl ?? address;
      const { gh, account } = github === null ? { gh: null, account: null } : yield* refreshGitHub;
      const viaGh = github !== null && gh !== null && account !== null ? gh : null;
      const head = yield* Effect.tryPromise({
        try: () =>
          run(
            "git",
            [
              ...(viaGh === null ? [] : gitHubCredentialOptions(viaGh)),
              "ls-remote",
              "--symref",
              url,
              "HEAD",
            ],
            { timeoutMs: 60_000 },
          ),
        catch: (failure) =>
          hubError(
            github === null
              ? explainCloneFailure(runOutput(failure), { url, branch: "" })
              : explainGitHubCloneFailure(runOutput(failure), {
                  url,
                  branch: "",
                  nameWithOwner: github.nameWithOwner,
                  account: viaGh === null ? null : account,
                  cli: gh !== null,
                }).message,
          ),
      });
      const name =
        github?.name ?? NodePath.basename(url.replace(/\/+$/, "")).replace(/\.git$/i, "");
      return {
        name,
        repoId: idFromName(name, "repo"),
        url,
        branch: /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1] ?? "main",
        root: null,
      } satisfies SharedRepository;
    });

  const shareProject: PeerHub["Service"]["shareProject"] = Effect.fn("PeerHub.shareProject")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      const workspace = (yield* Ref.get(stateRef)).persisted.workspaces.find(
        (w) => w.slug === input.workspace,
      );
      if (workspace === undefined) {
        return yield* hubError(`You are not a member of the workspace "${input.workspace}".`);
      }
      let shared: SharedRepository;
      if (input.repository !== undefined) shared = yield* addressedRepository(input.repository);
      else if (input.projectId !== undefined) shared = yield* localRepository(input.projectId);
      else return yield* hubError("Choose a project on this computer or enter a repository.");
      const name = input.name ?? shared.name;
      const id = idFromName(name, "project");
      if (!safeId(id)) return yield* hubError("Give the project a name.");
      yield* hubApi.shareProject(hubUrl, session, input.workspace, {
        id,
        name,
        repositories: [{ id: shared.repoId, url: shared.url, branch: shared.branch }],
        areas: input.areas ?? [],
      });
      const root = shared.root;
      if (root !== null) {
        // Here the checkout stays where it is; colleagues clone it under their workspace root.
        yield* updatePersisted((p) => ({
          ...p,
          localCheckouts: {
            ...p.localCheckouts,
            [`${input.workspace}/${id}/${shared.repoId}`]: root,
          },
        }));
      }
      return yield* syncNow;
    },
    lock.withPermits(1),
  );

  const unshareProject: PeerHub["Service"]["unshareProject"] = Effect.fn("PeerHub.unshareProject")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      yield* hubApi.unshareProject(hubUrl, session, input.workspace, input.projectId);
      const prefix = `${input.workspace}/${input.projectId}/`;
      yield* updatePersisted((p) => ({
        ...p,
        localCheckouts: Object.fromEntries(
          Object.entries(p.localCheckouts ?? {}).filter(([key]) => !key.startsWith(prefix)),
        ),
      }));
      return yield* syncNow;
    },
    lock.withPermits(1),
  );

  /**
   * Listens to the hub's change pings for every workspace while signed in and
   * reads what changed right away: a workspace's work (tasks, colleagues'
   * threads), its coordination, or its projects. Pings this computer caused
   * are skipped. The periodic reads stay as the fallback, so a hub without
   * pings, or a lost connection, only means slower news.
   */
  const importedKnowledge = new Set<string>();
  const refreshMemory = Effect.fn("PeerHub.refreshMemory")(function* (only?: string) {
    if (Option.isNone(yield* requireSession.pipe(Effect.option))) return;
    for (const [id, runtime] of appMemorySessions) {
      const caller = yield* projections.getThreadShell(runtime.threadId).pipe(Effect.option);
      if (
        Option.isNone(caller) ||
        caller.value === null ||
        caller.value.deletedAt !== null ||
        caller.value.archivedAt !== null ||
        caller.value.activeRunId === null ||
        caller.value.providerInstanceId !== runtime.providerInstanceId
      ) {
        yield* memory.endSession(runtime.session).pipe(Effect.ignore);
        appMemorySessions.delete(id);
      }
    }
    const persisted = (yield* Ref.get(stateRef)).persisted;
    for (const workspace of persisted.workspaces) {
      if ((only !== undefined && workspace.slug !== only) || workspace.manifest === null) continue;
      const scopes = [
        ...workspace.manifest.projects.map((project) => ({
          workspace: workspace.slug,
          project: project.id,
          repositories: project.repositories.map((repo) => ({
            repositoryId: repo.id,
            root: checkoutPath(persisted, workspace.slug, project.id, repo.id),
            branch: repo.branch,
          })),
        })),
        {
          workspace: workspace.slug,
          project: "company",
          repositories:
            workspace.manifest.knowledge.company === undefined
              ? []
              : [
                  {
                    repositoryId: "company",
                    root: knowledgePath(workspace.slug),
                    branch: workspace.manifest.knowledge.company.branch,
                  },
                ],
        },
      ];
      for (const scope of scopes) {
        const synced = yield* memory.synchronize(scope).pipe(Effect.option);
        if (Option.isNone(synced) || !synced.value.available || synced.value.mode === "legacy")
          continue;
        for (const repo of scope.repositories) {
          const revision = yield* MemoryKnowledge.approvedRevision(repo.root, repo.branch).pipe(
            Effect.option,
          );
          if (Option.isNone(revision)) continue;
          const key = `${persisted.email}/${scope.workspace}/${scope.project}/${repo.repositoryId}/${revision.value}`;
          if (importedKnowledge.has(key)) continue;
          const result = yield* memory
            .importKnowledge({
              workspace: scope.workspace,
              project: scope.project,
              repositoryId: repo.repositoryId,
              commit: revision.value,
              reviewRef: repo.branch,
            })
            .pipe(Effect.provide(memoryAuthLayer), Effect.option);
          if (
            Option.isSome(result) &&
            result.value.operations.every((operation) => operation.status === "stored")
          )
            importedKnowledge.add(key);
        }
      }
    }
  });
  const followHub = Effect.gen(function* () {
    const listeners = yield* FiberMap.make<string>();
    const listening = new Set<string>();
    const workChanged = yield* Queue.unbounded<string>();

    const onPing = (slug: string, ping: HubApi.HubPing) =>
      Effect.gen(function* () {
        if (ping.change === "memory.changed" || ping.change === "resync")
          yield* refreshMemory(slug);
        if (ping.origin === environmentId) return;
        if (ping.change === "work" || ping.change === "resync") {
          yield* Queue.offer(workChanged, slug);
        }
        if (ping.change === "coord" || ping.change === "resync") broker?.hubChanged();
        if (ping.change === "projects" || ping.change === "resync") {
          yield* background(sync);
        }
        if (
          ping.change === "observe" &&
          ping.environment === environmentId &&
          ping.thread !== undefined
        ) {
          yield* startPublishing(slug, ping.thread);
        }
      });

    const listen = (slug: string) =>
      Effect.gen(function* () {
        let failures = 0;
        while (true) {
          const signedIn = yield* requireSession.pipe(Effect.option);
          if (Option.isNone(signedIn)) return;
          const { hubUrl, session } = signedIn.value;
          const ended = yield* hubApi.events(hubUrl, session, slug).pipe(
            Stream.runForEach((ping) => {
              failures = 0;
              return onPing(slug, ping);
            }),
            Effect.result,
          );
          if (Result.isSuccess(ended)) {
            // The hub ends a stream every 15 minutes; one that ends at once must not spin.
            yield* Effect.sleep("1 second");
            continue;
          }
          if (HubApi.isSessionEnded(ended.failure)) return;
          if (HubApi.isWithoutEvents(ended.failure)) {
            yield* Effect.sleep("10 minutes");
            continue;
          }
          failures += 1;
          yield* Effect.logInfo("Peer lost the hub's change events; it reconnects", {
            workspace: slug,
            reason: ended.failure.detail,
          });
          yield* Effect.sleep(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)));
        }
      }).pipe(Effect.ensuring(Effect.sync(() => listening.delete(slug))));

    // A burst of pings (an agent's first steps) reads each workspace once.
    yield* Effect.gen(function* () {
      while (true) {
        const first = yield* Queue.take(workChanged);
        yield* Effect.sleep(300);
        const rest = yield* Queue.clear(workChanged);
        for (const slug of new Set([first, ...rest])) {
          yield* readWork(slug).pipe(Effect.ignoreCause({ log: true }));
        }
        yield* publish;
      }
    }).pipe(Effect.forkScoped);

    while (true) {
      const signedIn = Option.isSome(yield* requireSession.pipe(Effect.option));
      const slugs = signedIn
        ? (yield* Ref.get(stateRef)).persisted.workspaces.map((workspace) => workspace.slug)
        : [];
      for (const slug of slugs) {
        if (listening.has(slug)) continue;
        listening.add(slug);
        yield* FiberMap.run(listeners, slug, listen(slug));
      }
      for (const slug of listening) {
        if (slugs.includes(slug)) continue;
        listening.delete(slug);
        yield* FiberMap.remove(listeners, slug);
      }
      yield* Effect.sleep("15 seconds");
    }
  });

  // Keep the manifests fresh and colleagues' presence current.
  yield* Effect.forever(
    Effect.sleep(MANIFEST_INTERVAL).pipe(
      Effect.andThen(requireSession.pipe(Effect.option)),
      Effect.flatMap((signedIn) =>
        Option.isSome(signedIn) ? sync.pipe(Effect.ignore) : Effect.void,
      ),
    ),
  ).pipe(Effect.forkScoped);
  yield* Effect.forever(
    Effect.sleep(WORK_INTERVAL).pipe(
      Effect.andThen(refreshWork),
      Effect.andThen(publish),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);
  yield* followHerdr.pipe(Effect.forkScoped);
  yield* followHub.pipe(Effect.forkScoped);
  yield* Effect.forever(
    Effect.sleep("15 seconds").pipe(
      Effect.andThen(refreshMemory()),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);
  yield* background(refreshGitHub);
  if ((yield* Ref.get(stateRef)).persisted.coordination?.enabled === true) {
    yield* background(startBroker);
  }
  // Publish the persisted state right away so policy and tools apply before the first sync.
  yield* publish.pipe(
    Effect.andThen(requireSession.pipe(Effect.option)),
    Effect.flatMap((signedIn) =>
      Option.isSome(signedIn) ? sync.pipe(Effect.ignore) : Effect.void,
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return PeerHub.of({
    memoryQueue,
    memoryRetry,
    memoryDiscard,
    memoryState,
    memoryMode,
    memorySetMode,
    memorySearch,
    memoryRead,
    memoryProject,
    memoryExecute,
    memoryChanges,
    memoryReceipts,
    memoryKeep,
    memoryImportKnowledge,
    memoryAgent,
    memoryRuntime,
    memoryAgentContext,
    memoryAgentExecute,
    memoryAgentProject,
    memoryAgentReceipt,
    status: publish,
    get streamStatus() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* publish;
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription));
        }),
      );
    },
    startSignIn,
    finishSignIn,
    signOut,
    sync,
    createWorkspace,
    joinWorkspace,
    leaveWorkspace,
    invite,
    findWorkspace,
    openProject,
    connectGitHub,
    cancelGitHubSignIn,
    setCoordination,
    noteOverlap,
    resolveOverlap,
    settleOverlap,
    setSharedCapacity,
    projectUsage,
    createTask,
    updateTask,
    deleteTask,
    assignThread,
    focusAgent,
    watchAgent,
    promptAgent,
    startAgent,
    getCoordEvents,
    getStaleReads,
    shareThread,
    observeThread,
    readContext,
    contextVersions,
    readContextVersion,
    restoreContext,
    knowledgeCandidates,
    decideCandidate,
    knowledgeStatus,
    setupKnowledge,
    keepCandidate,
    harvestContext,
    improveGuidance,
    shareProject,
    unshareProject,
  });
});

export const layer = Layer.effect(PeerHub, make);
