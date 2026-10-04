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
  type PeerHubSetCoordinationInput,
  type PeerHubProjectUsage,
  type PeerHubPromptAgentInput,
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
  hasClaudeHooks,
  hasContextAccess,
  taskNamed,
  withClaudeHooks,
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
import * as HubApi from "./hubApi.ts";
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
}

/** What Peer shows and reports of herdr's agents, to tell a change from a re-read. */
function herdrSignature(
  agents: ReadonlyArray<HerdrAgentState> | null,
  keyOf: (agent: HerdrAgentState) => string,
): string {
  if (agents === null) return "";
  return agents
    .map((a) => [keyOf(a), a.paneId, a.status, a.title, a.cwd, a.branch].join("\u0000"))
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

/** A kebab-case id from a name, at most 40 characters. */
function kebab(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export class PeerHub extends Context.Service<
  PeerHub,
  {
    readonly status: Effect.Effect<PeerHubStatus>;
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
    /** Agent coordination on or off, its policy, and Peer's hooks in Claude Code. */
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
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
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
          resolve(stdout.trim());
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
  let broker: CoordinationBroker | null = null;
  const claudeSettings = yield* Effect.promise(() => readJsonSettings(claudeSettingsPath));
  let claudeHooksInstalled = hasClaudeHooks(claudeSettings ?? {}, coordinationDir);
  // Hooks installed by an older Peer still need their agents let into their working contexts.
  if (
    claudeSettings !== null &&
    claudeHooksInstalled &&
    !hasContextAccess(claudeSettings, coordinationContexts)
  ) {
    yield* Effect.promise(() =>
      writeJsonSettings(
        claudeSettingsPath,
        withContextAccess(claudeSettings, coordinationContexts, true),
      ).catch(() => undefined),
    );
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
          peers: peersOf(work?.threads ?? [], names),
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
            return { workspace: workspace.slug, projectId: project.id };
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
    const place = projectOfPath(s, agent.cwd);
    return {
      id: agentKey(agent),
      paneId: agent.paneId,
      ...(agent.agent === undefined ? {} : { agent: agent.agent }),
      title: agent.title,
      status: agent.status,
      ...(agent.cwd === undefined ? {} : { cwd: agent.cwd }),
      ...(agent.branch === undefined ? {} : { branch: agent.branch }),
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
    };
    return {
      enabled: s.persisted.coordination?.enabled ?? false,
      policy: s.persisted.coordination?.policy ?? "coordinate",
      claudeHooks: claudeHooksInstalled,
      logPath: coordinationLog,
      sessions: snapshot.sessions.map((session) => ({
        id: session.id,
        workspace: session.workspace,
        project: session.project,
        email: session.email,
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
    const before = yield* Ref.get(stateRef);
    const work = new Map<string, ProjectWork>();

    for (const workspace of before.persisted.workspaces) {
      const manifest = workspace.manifest;
      if (manifest === null) continue;
      // T3 project id → workspace project id, for the threads running here.
      const roots = new Map<string, string>();
      for (const project of manifest.projects) {
        if (!safeId(project.id)) continue;
        for (const repo of project.repositories) {
          if (!safeId(repo.id)) continue;
          const t3 = yield* projects
            .getByWorkspaceRoot(checkoutPath(before.persisted, workspace.slug, project.id, repo.id))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(t3)) roots.set(t3.value.id, project.id);
        }
      }

      const s = yield* Ref.get(stateRef);
      const shared = new Set(s.persisted.sharedThreads ?? []);
      const reported: HubApi.ReportedThread[] = [];
      for (const thread of threads) {
        const projectId = roots.get(thread.projectId);
        if (projectId === undefined) continue;
        const id = `peer:${thread.id}`;
        const task = assignedTask(s.persisted, id, workspace.slug, projectId);
        const harness = harnessForDriver(driverOf(thread.providerInstanceId));
        reported.push({
          id,
          project: projectId,
          ...(task === undefined ? {} : { task }),
          title: thread.title.slice(0, 300),
          status: shellStatus(thread),
          ...(harness === undefined ? {} : { harness }),
          ...(thread.branch === null ? {} : { branch: thread.branch }),
          source: "peer",
          ...(shared.has(id) ? { observable: true } : {}),
        });
      }
      for (const agent of s.herdr ?? []) {
        const place = projectOfPath(s, agent.cwd);
        if (place === undefined || place.workspace !== workspace.slug) continue;
        const id = agentKey(agent);
        const task =
          assignedTask(s.persisted, id, workspace.slug, place.projectId) ??
          assignedTask(s.persisted, `herdr:${agent.terminalId}`, workspace.slug, place.projectId);
        reported.push({
          id,
          project: place.projectId,
          ...(task === undefined ? {} : { task }),
          title: agent.title.slice(0, 300),
          status: agent.status,
          ...(agent.agent === undefined ? {} : { harness: agent.agent }),
          ...(agent.branch === undefined ? {} : { branch: agent.branch }),
          source: "herdr",
          ...(shared.has(id) ? { observable: true } : {}),
        });
      }
      yield* hubApi
        .reportThreads(hubUrl, session, workspace.slug, {
          environment: environmentId,
          threads: reported,
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
      for (const [key, value] of workOf(workspace.slug, fetched.value, s.persisted.email)) {
        work.set(key, value);
      }
    }
    yield* updateRuntime((current) => ({ ...current, work }));
  });

  const refreshWork = refreshWorkUnlocked.pipe(lock.withPermits(1));

  /** One workspace's work as the hub gave it, keyed like `RuntimeState.work`. */
  const workOf = (slug: string, fetched: HubApi.HubWork, email: string | null) =>
    Object.entries(fetched.projects).map(
      ([projectId, projectWork]) =>
        [
          sharedKey(slug, projectId),
          {
            areas: projectWork.areas,
            tasks: projectWork.tasks,
            // This computer's own threads show live from its thread list.
            threads: projectWork.threads.filter(
              (thread) => !(thread.environment === environmentId && thread.email === email),
            ),
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
      const email = (yield* Ref.get(stateRef)).persisted.email;
      yield* updateRuntime((current) => {
        const work = new Map([...current.work].filter(([key]) => !key.startsWith(`${slug}/`)));
        for (const [key, value] of workOf(slug, fetched, email)) work.set(key, value);
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

  /** What herdr runs on this computer, with each agent's git branch. */
  const refreshHerdr = Effect.gen(function* () {
    const agents = yield* Effect.promise(() => Herdr.listHerdrAgents());
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    const withBranches =
      agents === null
        ? null
        : yield* Effect.forEach(agents, (agent) =>
            branchOf(agent.cwd, nowMillis).pipe(Effect.map((branch) => ({ ...agent, branch }))),
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
      const terminal = yield* Effect.promise(() => Herdr.readHerdrAgent(agent.paneId));
      return {
        ...base,
        ...(terminal === null ? {} : { terminal }),
        ...(agent.agent === "claude"
          ? {
              hint: "To follow this conversation here instead of its terminal, install herdr's Claude Code integration once: herdr integration install claude",
            }
          : {}),
      } satisfies PeerAgentView;
    });

  /**
   * Keeps herdr's agents current. herdr's events say when an agent appears,
   * leaves or changes state; Peer then reads the list, shows it at once and
   * tells the hub within a couple of seconds. Without events (no herdr, or
   * one from before them) Peer reads the list every few seconds instead.
   */
  const followHerdr = Effect.gen(function* () {
    const changed = yield* Queue.dropping<void>(1);
    const signal = () => void Queue.offerUnsafe(changed, undefined);
    const watch = {
      handle: null as Herdr.HerdrWatch | null,
      panes: "",
      refused: false,
      retryAt: 0,
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => watch.handle?.close()));
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
      if (watch.refused) {
        watch.refused = false;
        watch.retryAt = now + HERDR_RESYNC_MS;
      }
      // Follow the panes that run agents now: herdr reports state per pane.
      const panes = (agents ?? []).map((agent) => agent.paneId).toSorted();
      if (agents === null) {
        watch.handle?.close();
        watch.handle = null;
      } else if (
        (watch.handle === null || watch.panes !== panes.join(" ")) &&
        now >= watch.retryAt
      ) {
        watch.handle?.close();
        watch.panes = panes.join(" ");
        watch.handle = Herdr.watchHerdrAgents({
          paneIds: panes,
          onChange: signal,
          onEnd: (subscribed) => {
            watch.handle = null;
            watch.refused = !subscribed;
            signal();
          },
        });
      }
      return seen !== reported
        ? Math.max(100, HERDR_REPORT_GAP_MS - (now - reportedAt))
        : watch.handle === null
          ? HERDR_POLL_MS
          : HERDR_RESYNC_MS;
    });

    while (true) {
      const wait = yield* step.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Peer could not read herdr's agents", cause).pipe(
            Effect.as(HERDR_POLL_MS),
          ),
        ),
      );
      const woken = yield* Queue.take(changed).pipe(Effect.timeoutOption(wait));
      if (Option.isSome(woken)) {
        // An agent starting or finishing sends a few events at once; read once they settle.
        yield* Effect.sleep(150);
        yield* Queue.clear(changed);
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
      : { workspace: place.workspace, project: place.projectId, root: realpathOrSelf(toplevel) };
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

  const withHub = <A>(
    call: (hubUrl: string, session: string) => Effect.Effect<A, PeerHubError>,
  ): Promise<A> =>
    Effect.runPromise(
      requireSession.pipe(Effect.flatMap(({ hubUrl, session }) => call(hubUrl, session))),
    );

  const startBroker = Effect.tryPromise({
    try: async () => {
      if (broker !== null) return;
      const created = new CoordinationBroker({
        socketPath: coordinationSocket,
        scriptsDir: coordinationDir,
        logPath: coordinationLog,
        environment: environmentId,
        placeOf,
        branchOf: async (root) => {
          const name = await run("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"]).catch(
            () => "",
          );
          return name === "" || name === "HEAD" ? undefined : name;
        },
        herdrTitle: (pane) => currentState().herdr?.find((agent) => agent.paneId === pane)?.title,
        nameOf: nameIn,
        email: () => currentState().persisted.email,
        policy: () => currentState().persisted.coordination?.policy ?? "coordinate",
        report: (workspace, sessions) =>
          withHub((hubUrl, session) =>
            hubApi.reportCoordination(hubUrl, session, workspace, {
              environment: environmentId,
              sessions,
            }),
          ),
        view: (workspace) =>
          withHub((hubUrl, session) => hubApi.coordination(hubUrl, session, workspace)),
        note: (workspace, project, overlap, text, author) =>
          withHub((hubUrl, session) =>
            hubApi.noteOverlap(hubUrl, session, workspace, project, overlap, {
              ...(author === undefined ? {} : { session: author }),
              text,
            }),
          ),
        resolve: (workspace, project, overlap, resolution, author) =>
          withHub((hubUrl, session) =>
            hubApi.resolveOverlap(hubUrl, session, workspace, project, overlap, {
              ...(author === undefined ? {} : { session: author }),
              resolution,
            }),
          ),
        workspaces: () => {
          const s = currentState();
          return s.persisted.email === null ? [] : s.persisted.workspaces.map((w) => w.slug);
        },
        notify: (title, body) => void Herdr.notifyHerdr(title, body),
        changed: () => void Effect.runFork(publish.pipe(Effect.ignore)),
        contextsDir: coordinationContexts,
        taskOf: (workspace, project, key, texts) => {
          const s = currentState();
          const assigned = s.persisted.assignments?.[key];
          if (
            assigned !== undefined &&
            assigned.workspace === workspace &&
            assigned.project === project
          ) {
            return assigned.task;
          }
          return taskNamed(s.work.get(sharedKey(workspace, project))?.tasks ?? [], texts);
        },
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
        contextVersions: (workspace, project, scope) =>
          withHub((hubUrl, session) =>
            hubApi.contextVersions(hubUrl, session, workspace, project, scope),
          ),
        readContextVersion: (workspace, project, scope, version) =>
          withHub((hubUrl, session) =>
            hubApi.contextVersion(hubUrl, session, workspace, project, scope, version),
          ),
        keepContext: (workspace, project, scope, agentSession, release) =>
          withHub((hubUrl, session) =>
            hubApi.keepContext(hubUrl, session, workspace, project, scope, {
              environment: environmentId,
              session: agentSession,
              ...(release ? { release: true } : {}),
            }),
          ),
        writeContext: (workspace, project, scope, agentSession, baseVersion, text) =>
          withHub((hubUrl, session) =>
            hubApi.writeContext(hubUrl, session, workspace, project, scope, {
              environment: environmentId,
              session: agentSession,
              baseVersion,
              text,
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
    const current = (yield* Ref.get(stateRef)).persisted.coordination ?? {
      enabled: false,
      policy: "coordinate" as const,
    };
    // Hooks run Peer's scripts, which coordination writes: installing them turns it on.
    const next = {
      enabled: input.claudeHooks === true ? true : (input.enabled ?? current.enabled),
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
          const groups = claudeHookGroups({
            hook: NodePath.join(coordinationDir, "hook"),
            wait: NodePath.join(coordinationDir, "wait"),
          });
          await writeJsonSettings(
            claudeSettingsPath,
            withContextAccess(
              withClaudeHooks(settings, groups, coordinationDir, install),
              coordinationContexts,
              install,
            ),
          );
          claudeHooksInstalled = install;
        },
        catch: (failure) =>
          hubError(
            `Claude Code's settings could not change: ${failure instanceof Error ? failure.message : String(failure)}`,
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
      if (!/^(peer|herdr):/.test(input.thread)) {
        return yield* hubError("Only this computer's threads and herdr agents can be placed.");
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
        repoId: kebab(NodePath.basename(root)) || "app",
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
        repoId: kebab(name) || "app",
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
      const id = kebab(name);
      if (!safeId(id)) return yield* hubError("Give the project a name with letters or digits.");
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
  const followHub = Effect.gen(function* () {
    const listeners = yield* FiberMap.make<string>();
    const listening = new Set<string>();
    const workChanged = yield* Queue.unbounded<string>();

    const onPing = (slug: string, ping: HubApi.HubPing) =>
      Effect.gen(function* () {
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
    setSharedCapacity,
    projectUsage,
    createTask,
    updateTask,
    deleteTask,
    assignThread,
    focusAgent,
    watchAgent,
    promptAgent,
    shareThread,
    observeThread,
    readContext,
    contextVersions,
    readContextVersion,
    restoreContext,
    shareProject,
    unshareProject,
  });
});

export const layer = Layer.effect(PeerHub, make);
