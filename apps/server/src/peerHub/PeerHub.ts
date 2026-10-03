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
  PeerHubError,
  PeerHubStatus,
  PeerJoinableWorkspace,
  PeerManifest,
  PeerWorkspaceRole,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type PeerHubCreateWorkspaceInput,
  type PeerFoundWorkspace,
  type PeerHubFindWorkspaceInput,
  type PeerHubFinishSignInInput,
  type PeerHubInviteInput,
  type PeerHubProjectInput,
  type PeerHubProjectUsage,
  type PeerHubSharedCapacityInput,
  type PeerHubStartSignInInput,
  type PeerHubWorkspaceInput,
  type PeerPresenceThread,
  type PeerProject,
  type PeerProjectState,
  type PeerWorkspaceState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Settings from "../serverSettings.ts";
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
const PRESENCE_INTERVAL = "60 seconds";
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
  /** "workspace/project" → colleagues working on it. */
  readonly peers: ReadonlyMap<string, HubApi.HubPresence["peers"]>;
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
    readonly setSharedCapacity: (
      input: PeerHubSharedCapacityInput,
    ) => Effect.Effect<PeerHubStatus, PeerHubError>;
    readonly projectUsage: (
      input: PeerHubProjectInput,
    ) => Effect.Effect<PeerHubProjectUsage, PeerHubError>;
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
  return searchPath().some((dir) => NodeFS.existsSync(NodePath.join(dir, command)));
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
        },
      },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error((stderr || error.message).trim().split("\n").slice(-3).join(" ")));
        else resolve(stdout.trim());
      },
    );
  });
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
    peers: new Map(),
  });
  const statusRef = yield* Ref.make<PeerHubStatus | null>(null);
  const changes = yield* Effect.acquireRelease(PubSub.unbounded<PeerHubStatus>(), PubSub.shutdown);
  // Mutations of hub state run one at a time; background clones only touch their own checkout.
  const lock = yield* Semaphore.make(1);

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
        const path = repoPath(workspace.slug, project.id, repo.id);
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
          ...(projectId === undefined ? {} : { projectId }),
        });
      }
      const key = sharedKey(workspace.slug, project.id);
      const instanceIds = s.persisted.sharedInstances[key] ?? [];
      const names = new Map(project.members.map((m) => [m.email, m.name]));
      const sharedError = s.sharedErrors.get(key);
      const me = s.persisted.email;
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
          peers: (s.peers.get(key) ?? [])
            .filter((peer) => !(peer.email === me && peer.environment === environmentId))
            .map((peer) => ({ ...peer, name: names.get(peer.email) ?? peer.email })),
        },
      };
    });

  /** Rebuilds the status, publishes it when it changed, and hands the policy its new state. */
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
      if (!exists) yield* setKnowledge({ state: "cloning" });
      yield* publish;
      const result = yield* Effect.tryPromise(async () => {
        if (exists) {
          await run("git", ["-C", path, "pull", "--ff-only", "--quiet"], {
            timeoutMs: GIT_TIMEOUT_MS,
          });
        } else {
          await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
          await run(
            "git",
            ["clone", "--quiet", "--branch", repository.branch, repository.repository, path],
            { timeoutMs: GIT_TIMEOUT_MS },
          );
        }
      }).pipe(Effect.result);
      // A failed pull keeps the last good checkout usable.
      yield* setKnowledge(
        result._tag === "Success" || exists
          ? null
          : {
              state: "error",
              error:
                result.failure instanceof Error ? result.failure.message : String(result.failure),
            },
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
    yield* background(refreshPresence);
    return yield* publish;
  });

  /** Reports this environment's active workspace threads and reads everyone else's. */
  const refreshPresence = Effect.gen(function* () {
    const sessionInfo = yield* requireSession.pipe(Effect.option);
    if (Option.isNone(sessionInfo)) return;
    const { hubUrl, session } = sessionInfo.value;
    const s = yield* Ref.get(stateRef);

    const sharedInstances = new Set(Object.values(s.persisted.sharedInstances).flat());
    const currentSettings = yield* settings.getSettings.pipe(Effect.option);
    const driverOf = (instanceId: string) =>
      Option.match(currentSettings, {
        onNone: () => instanceId,
        onSome: (value) =>
          value.providerInstances[instanceId as ProviderInstanceId]?.driver ?? instanceId,
      });
    const shell = yield* projections
      .getShellSnapshot({ location: "active", unsettledOnly: true })
      .pipe(Effect.option);

    const peers = new Map<string, HubApi.HubPresence["peers"]>();
    for (const workspace of s.persisted.workspaces) {
      const manifest = workspace.manifest;
      if (manifest === null) continue;
      // T3 project id → workspace project id, for the threads running here.
      const roots = new Map<string, string>();
      for (const project of manifest.projects) {
        if (!safeId(project.id)) continue;
        for (const repo of project.repositories) {
          if (!safeId(repo.id)) continue;
          const t3 = yield* projects
            .getByWorkspaceRoot(repoPath(workspace.slug, project.id, repo.id))
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(t3)) roots.set(t3.value.id, project.id);
        }
      }
      const threadsByProject = new Map<string, PeerPresenceThread[]>();
      if (Option.isSome(shell)) {
        for (const thread of shell.value.threads) {
          const projectId = roots.get(thread.projectId);
          if (projectId === undefined || thread.status === "idle") continue;
          const harness = harnessForDriver(driverOf(thread.providerInstanceId));
          const list = threadsByProject.get(projectId) ?? [];
          list.push({
            title: thread.title.slice(0, 300),
            status: thread.activityRunStatus ?? thread.status,
            ...(thread.branch === null ? {} : { branch: thread.branch }),
            ...(harness === undefined ? {} : { harness }),
            capacity: sharedInstances.has(thread.providerInstanceId) ? "shared" : "personal",
          });
          threadsByProject.set(projectId, list);
        }
      }
      yield* hubApi
        .reportPresence(hubUrl, session, workspace.slug, {
          environment: environmentId,
          projects: manifest.projects.map((p) => ({
            id: p.id,
            threads: threadsByProject.get(p.id) ?? [],
          })),
        })
        .pipe(Effect.ignoreCause({ log: true }));
      for (const project of manifest.projects) {
        const presence = yield* hubApi
          .projectPresence(hubUrl, session, workspace.slug, project.id)
          .pipe(Effect.option);
        if (Option.isSome(presence)) {
          peers.set(sharedKey(workspace.slug, project.id), presence.value.peers);
        }
      }
    }
    yield* updateRuntime((current) => ({ ...current, peers }));
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
    }));
    yield* updateRuntime((s) => ({
      ...s,
      error: null,
      workspaceErrors: new Map(),
      peers: new Map(),
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
      for (const repo of project.repositories) {
        if (!safeId(repo.id)) continue;
        const path = repoPath(workspace.slug, project.id, repo.id);
        if (!hasGitCheckout(path)) {
          yield* updateRuntime((s) => ({
            ...s,
            checkouts: new Map(s.checkouts).set(path, { state: "cloning" }),
          }));
          yield* publish;
          const cloned = yield* Effect.tryPromise(async () => {
            await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
            await run("git", ["clone", "--quiet", "--branch", repo.branch, repo.url, path], {
              timeoutMs: GIT_TIMEOUT_MS,
            });
          }).pipe(Effect.result);
          if (cloned._tag === "Failure") {
            const error =
              cloned.failure instanceof Error ? cloned.failure.message : String(cloned.failure);
            yield* updateRuntime((s) => ({
              ...s,
              checkouts: new Map(s.checkouts).set(path, { state: "error", error }),
            }));
            continue;
          }
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
            Effect.tap(() =>
              updateRuntime((s) => {
                const checkouts = new Map(s.checkouts);
                checkouts.delete(path);
                return { ...s, checkouts };
              }),
            ),
            Effect.catch((cause) =>
              updateRuntime((s) => ({
                ...s,
                checkouts: new Map(s.checkouts).set(path, { state: "error", error: cause.message }),
              })),
            ),
          );
      }
    });

  const openProject: PeerHub["Service"]["openProject"] = Effect.fn("PeerHub.openProject")(
    function* (input) {
      const { workspace, project } = yield* findProject(input.workspace, input.projectId);
      if (project.repositories.length === 0) {
        return yield* hubError(`${project.name} declares no repositories yet.`);
      }
      // Clones can take minutes; the status stream reports progress.
      yield* background(cloneAndRegister(workspace, project));
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
    Effect.sleep(PRESENCE_INTERVAL).pipe(
      Effect.andThen(refreshPresence),
      Effect.andThen(publish),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);
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
    setSharedCapacity,
    projectUsage,
  });
});

export const layer = Layer.effect(PeerHub, make);
