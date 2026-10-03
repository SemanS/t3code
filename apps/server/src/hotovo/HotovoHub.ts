// @effect-diagnostics nodeBuiltinImport:off - git/gh subprocesses and checkout probes against the member's own disk.
/**
 * HotovoHub — this environment's link to the company hub.
 *
 * The member signs in once; the hub then tells this environment which
 * projects to check out, which agent tools and knowledge they use, and what
 * company AI capacity each one has. Provisioning stays local: repositories are
 * cloned with the member's own git credentials, projects are ordinary T3
 * projects, and shared capacity becomes an ordinary provider instance holding
 * a per-member, per-project gateway key.
 *
 * Personal capacity never passes through here. The hub never sees provider
 * logins, and `hubPolicy` keeps hub-provisioned (shared) instances on their
 * own project and personal ones on projects that accept them.
 *
 * @module hotovo/HotovoHub
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  HotovoHubError,
  HotovoHubManifest,
  HotovoHubStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HotovoHubPeerThread,
  type HotovoHubProject,
  type HotovoHubProjectInput,
  type HotovoHubProjectState,
  type HotovoHubProjectUsage,
  type HotovoHubSharedCapacityInput,
  type HotovoHubSignInInput,
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
import { harnessForDriver, setHubPolicyState, type HubBoundProject } from "./hubPolicy.ts";

const SESSION_SECRET = "hotovo-hub-session";
const PRESENCE_INTERVAL = "60 seconds";
const MANIFEST_INTERVAL = "10 minutes";
const GIT_TIMEOUT_MS = 15 * 60 * 1000;

const PersistedState = Schema.Struct({
  hubUrl: Schema.NullOr(Schema.String),
  account: Schema.NullOr(Schema.String),
  manifest: Schema.NullOr(HotovoHubManifest),
  lastSyncAt: Schema.NullOr(Schema.String),
  /** Hub project id → provider instances this environment provisioned for its shared capacity. */
  sharedInstances: Schema.Record(Schema.String, Schema.Array(Schema.String)),
});
type PersistedState = typeof PersistedState.Type;

const decodePersisted = Schema.decodeUnknownOption(Schema.fromJsonString(PersistedState));
const encodePersisted = Schema.encodeSync(Schema.fromJsonString(PersistedState));
const encodeStatus = Schema.encodeSync(Schema.fromJsonString(HotovoHubStatus));

const EMPTY_PERSISTED: PersistedState = {
  hubUrl: null,
  account: null,
  manifest: null,
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
  /** Checkout path → an in-flight clone or its failure. */
  readonly checkouts: ReadonlyMap<string, Transient>;
  readonly sharedErrors: ReadonlyMap<string, string>;
  readonly peers: ReadonlyMap<string, HubApi.HubPresence["peers"]>;
}

export class HotovoHub extends Context.Service<
  HotovoHub,
  {
    readonly status: Effect.Effect<HotovoHubStatus>;
    /** The current status followed by every change. */
    readonly streamStatus: Stream.Stream<HotovoHubStatus>;
    readonly signIn: (
      input: HotovoHubSignInInput,
    ) => Effect.Effect<HotovoHubStatus, HotovoHubError>;
    readonly signOut: Effect.Effect<HotovoHubStatus, HotovoHubError>;
    readonly sync: Effect.Effect<HotovoHubStatus, HotovoHubError>;
    /** Clones the project's repositories (in the background) and registers them as projects. */
    readonly openProject: (
      input: HotovoHubProjectInput,
    ) => Effect.Effect<HotovoHubStatus, HotovoHubError>;
    readonly setSharedCapacity: (
      input: HotovoHubSharedCapacityInput,
    ) => Effect.Effect<HotovoHubStatus, HotovoHubError>;
    readonly projectUsage: (
      input: HotovoHubProjectInput,
    ) => Effect.Effect<HotovoHubProjectUsage, HotovoHubError>;
  }
>()("t3/hotovo/HotovoHub") {}

/** Hub projects are checked out under ~/Hotovo/<project>/<repository> unless HOTOVO_WORKSPACE says otherwise. */
function resolveWorkspaceRoot(): string {
  const configured = process.env.HOTOVO_WORKSPACE?.trim();
  if (configured) return NodePath.resolve(configured.replace(/^~(?=$|\/)/, NodeOS.homedir()));
  return NodePath.join(NodeOS.homedir(), "Hotovo");
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

const hubError = (detail: string) => new HotovoHubError({ detail });

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

  const statePath = NodePath.join(config.stateDir, "hotovo-hub.json");
  const hubHome = NodePath.join(config.baseDir, "hub");
  const knowledgePath = NodePath.join(hubHome, "knowledge");
  const workspaceRoot = resolveWorkspaceRoot();
  const repoPath = (projectId: string, repoId: string) =>
    NodePath.join(workspaceRoot, projectId, repoId);

  const loadPersisted = Effect.tryPromise(() => NodeFSP.readFile(statePath, "utf8")).pipe(
    Effect.map((text) => Option.getOrElse(decodePersisted(text), () => EMPTY_PERSISTED)),
    Effect.orElseSucceed(() => EMPTY_PERSISTED),
  );

  const stateRef = yield* Ref.make<RuntimeState>({
    persisted: yield* loadPersisted,
    syncing: false,
    error: null,
    checkouts: new Map(),
    sharedErrors: new Map(),
    peers: new Map(),
  });
  const knowledgeRef = yield* Ref.make<Transient | null>(null);
  const statusRef = yield* Ref.make<HotovoHubStatus | null>(null);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<HotovoHubStatus>(),
    PubSub.shutdown,
  );
  // Mutations of hub state run one at a time; background clones only touch their own checkout.
  const lock = yield* Semaphore.make(1);

  const persist = (persisted: PersistedState) =>
    Effect.tryPromise(async () => {
      await NodeFSP.mkdir(NodePath.dirname(statePath), { recursive: true });
      const temp = `${statePath}.${process.pid}.tmp`;
      await NodeFSP.writeFile(temp, `${encodePersisted(persisted)}\n`, { mode: 0o600 });
      await NodeFSP.rename(temp, statePath);
    }).pipe(Effect.mapError(() => hubError("Could not save the hub state.")));

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

  const requireSession = Effect.gen(function* () {
    const { persisted } = yield* Ref.get(stateRef);
    const session = yield* readSession;
    if (persisted.hubUrl === null || Option.isNone(session)) {
      return yield* hubError("Sign in to the hub first.");
    }
    return { hubUrl: persisted.hubUrl, session: session.value };
  });

  const projectState = (
    project: HotovoHubProject,
    s: RuntimeState,
    me: { readonly member: string | null },
  ): Effect.Effect<{
    readonly state: HotovoHubProjectState;
    readonly bound: ReadonlyArray<readonly [string, ProjectId | undefined, HubBoundProject]>;
  }> =>
    Effect.gen(function* () {
      const bound: Array<readonly [string, ProjectId | undefined, HubBoundProject]> = [];
      const repositories = [];
      for (const repo of project.repositories) {
        const path = repoPath(project.id, repo.id);
        const transient = s.checkouts.get(path);
        const ready = hasGitCheckout(path);
        const t3Project = ready
          ? yield* projects.getByWorkspaceRoot(path).pipe(Effect.orElseSucceed(() => Option.none()))
          : Option.none();
        const projectId = Option.isSome(t3Project) ? t3Project.value.id : undefined;
        if (ready) bound.push([path, projectId, { project, repositoryPath: path }]);
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
      const instanceIds = s.persisted.sharedInstances[project.id] ?? [];
      const names = new Map(project.members.map((m) => [m.id, m.name]));
      const sharedError = s.sharedErrors.get(project.id);
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
          peers: (s.peers.get(project.id) ?? [])
            .filter((peer) => !(peer.member === me.member && peer.environment === environmentId))
            .map((peer) => ({ ...peer, name: names.get(peer.member) ?? peer.member })),
        },
      };
    });

  /** Rebuilds the status, publishes it when it changed, and hands the policy its new state. */
  const publish = Effect.gen(function* () {
    const s = yield* Ref.get(stateRef);
    const session = yield* readSession;
    const manifest = s.persisted.manifest;
    const me = { member: manifest?.member.id ?? null };
    const projectStates: HotovoHubProjectState[] = [];
    const byProject = new Map<string, HubBoundProject>();
    const byRoot = new Map<string, HubBoundProject>();
    for (const project of manifest?.projects ?? []) {
      const { state, bound } = yield* projectState(project, s, me);
      projectStates.push(state);
      for (const [path, projectId, entry] of bound) {
        byRoot.set(path, entry);
        byRoot.set(realpathOrSelf(path), entry);
        if (projectId !== undefined) byProject.set(projectId, entry);
      }
    }
    const knowledgeRepo = manifest?.knowledge.company;
    const knowledgeTransient = yield* Ref.get(knowledgeRef);
    const knowledgeReady = knowledgeRepo !== undefined && hasGitCheckout(knowledgePath);
    const sharedInstances = new Map<string, string>();
    for (const [projectId, ids] of Object.entries(s.persisted.sharedInstances)) {
      for (const id of ids) sharedInstances.set(id, projectId);
    }
    setHubPolicyState(
      manifest === null
        ? null
        : {
            hubName: manifest.hub.displayName,
            projects: byProject,
            roots: byRoot,
            sharedInstances,
            companyKnowledgePath: knowledgeReady ? knowledgePath : null,
          },
    );

    const status: HotovoHubStatus = {
      hubUrl: s.persisted.hubUrl,
      signedIn: Option.isSome(session) && s.persisted.hubUrl !== null,
      account: s.persisted.account,
      member:
        manifest === null
          ? null
          : { id: manifest.member.id, name: manifest.member.name, roles: manifest.member.roles },
      hub:
        manifest === null
          ? null
          : {
              name: manifest.hub.name,
              displayName: manifest.hub.displayName,
              currency: manifest.hub.currency,
              ...(manifest.hub.revision === undefined ? {} : { revision: manifest.hub.revision }),
            },
      workspaceRoot,
      companyKnowledge:
        knowledgeRepo === undefined
          ? null
          : {
              repository: knowledgeRepo.repository,
              path: knowledgePath,
              state: knowledgeTransient?.state ?? (knowledgeReady ? "ready" : "missing"),
              ...(knowledgeTransient?.error === undefined
                ? {}
                : { error: knowledgeTransient.error }),
            },
      projects: projectStates,
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

  /** Clones the company knowledge repository, or fast-forwards it. */
  const refreshKnowledge = (repository: { readonly repository: string; readonly branch: string }) =>
    Effect.gen(function* () {
      const exists = hasGitCheckout(knowledgePath);
      if (!exists) yield* Ref.set(knowledgeRef, { state: "cloning" });
      yield* publish;
      const result = yield* Effect.tryPromise(async () => {
        if (exists) {
          await run("git", ["-C", knowledgePath, "pull", "--ff-only", "--quiet"], {
            timeoutMs: GIT_TIMEOUT_MS,
          });
        } else {
          await NodeFSP.mkdir(NodePath.dirname(knowledgePath), { recursive: true });
          await run(
            "git",
            [
              "clone",
              "--quiet",
              "--branch",
              repository.branch,
              repository.repository,
              knowledgePath,
            ],
            {
              timeoutMs: GIT_TIMEOUT_MS,
            },
          );
        }
      }).pipe(Effect.result);
      // A failed pull keeps the last good checkout usable.
      yield* Ref.set(
        knowledgeRef,
        result._tag === "Success" || exists
          ? null
          : {
              state: "error",
              error:
                result.failure instanceof Error ? result.failure.message : String(result.failure),
            },
      );
    });

  const removeSharedInstances = (projectId: string) =>
    Effect.gen(function* () {
      const ids = (yield* Ref.get(stateRef)).persisted.sharedInstances[projectId] ?? [];
      for (const id of ids) {
        yield* settings
          .updateProviderInstance({ operation: "remove", instanceId: ProviderInstanceId.make(id) })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* updatePersisted((p) => {
        const { [projectId]: _removed, ...rest } = p.sharedInstances;
        return { ...p, sharedInstances: rest };
      });
    });

  const syncNow = Effect.gen(function* () {
    const { hubUrl, session } = yield* requireSession;
    yield* updateRuntime((s) => ({ ...s, syncing: true }));
    yield* publish;
    const result = yield* hubApi.manifest(hubUrl, session).pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* updateRuntime((s) => ({ ...s, syncing: false, error: result.failure.detail }));
      yield* publish;
      return yield* result.failure;
    }
    const manifest = result.success;
    const syncedAt = DateTime.formatIso(yield* DateTime.now);
    yield* updatePersisted((p) => ({ ...p, manifest, lastSyncAt: syncedAt }));
    yield* updateRuntime((s) => ({ ...s, syncing: false, error: null }));

    // Shared capacity the hub no longer grants goes away here too.
    const stillShared = new Set(
      manifest.projects.filter((p) => p.capacity.shared !== undefined).map((p) => p.id),
    );
    for (const projectId of Object.keys((yield* Ref.get(stateRef)).persisted.sharedInstances)) {
      if (!stillShared.has(projectId)) yield* removeSharedInstances(projectId);
    }

    const company = manifest.knowledge.company;
    if (company !== undefined) yield* background(refreshKnowledge(company));
    yield* background(refreshPresence);
    return yield* publish;
  });

  /** Reports this environment's active hub threads and reads everyone else's. */
  const refreshPresence = Effect.gen(function* () {
    const sessionInfo = yield* requireSession.pipe(Effect.option);
    if (Option.isNone(sessionInfo)) return;
    const { hubUrl, session } = sessionInfo.value;
    const s = yield* Ref.get(stateRef);
    const manifest = s.persisted.manifest;
    if (manifest === null) return;

    const sharedInstances = new Map<string, string>();
    for (const [projectId, ids] of Object.entries(s.persisted.sharedInstances)) {
      for (const id of ids) sharedInstances.set(id, projectId);
    }
    const currentSettings = yield* settings.getSettings.pipe(Effect.option);
    const driverOf = (instanceId: string) =>
      Option.match(currentSettings, {
        onNone: () => instanceId,
        onSome: (value) =>
          value.providerInstances[instanceId as ProviderInstanceId]?.driver ?? instanceId,
      });

    const roots = new Map<string, string>();
    for (const project of manifest.projects) {
      for (const repo of project.repositories) {
        const t3 = yield* projects
          .getByWorkspaceRoot(repoPath(project.id, repo.id))
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isSome(t3)) roots.set(t3.value.id, project.id);
      }
    }
    const shell = yield* projections
      .getShellSnapshot({ location: "active", unsettledOnly: true })
      .pipe(Effect.option);
    const threadsByProject = new Map<string, HotovoHubPeerThread[]>();
    if (Option.isSome(shell)) {
      for (const thread of shell.value.threads) {
        const hubProject = roots.get(thread.projectId);
        if (hubProject === undefined || thread.status === "idle") continue;
        const harness = harnessForDriver(driverOf(thread.providerInstanceId));
        const list = threadsByProject.get(hubProject) ?? [];
        list.push({
          title: thread.title.slice(0, 300),
          status: thread.activityRunStatus ?? thread.status,
          ...(thread.branch === null ? {} : { branch: thread.branch }),
          ...(harness === undefined ? {} : { harness }),
          capacity: sharedInstances.has(thread.providerInstanceId) ? "shared" : "personal",
        });
        threadsByProject.set(hubProject, list);
      }
    }
    yield* hubApi
      .reportPresence(hubUrl, session, {
        environment: environmentId,
        projects: manifest.projects.map((p) => ({
          id: p.id,
          threads: threadsByProject.get(p.id) ?? [],
        })),
      })
      .pipe(Effect.ignoreCause({ log: true }));

    const peers = new Map<string, HubApi.HubPresence["peers"]>();
    for (const project of manifest.projects) {
      const presence = yield* hubApi
        .projectPresence(hubUrl, session, project.id)
        .pipe(Effect.option);
      if (Option.isSome(presence)) peers.set(project.id, presence.value.peers);
    }
    yield* updateRuntime((current) => ({ ...current, peers }));
  });

  const signIn: HotovoHub["Service"]["signIn"] = Effect.fn("HotovoHub.signIn")(function* (input) {
    const hubUrl = input.hubUrl.replace(/\/+$/, "");
    let kind: "github" | "bitbucket" = input.kind ?? "github";
    let token = input.token?.trim() ?? "";
    if (input.method === "github-cli") {
      kind = "github";
      token = yield* Effect.tryPromise(() => run("gh", ["auth", "token"])).pipe(
        Effect.mapError(() =>
          hubError(
            "The GitHub CLI has no login on this machine. Run `gh auth login`, or paste a token instead.",
          ),
        ),
      );
    }
    if (token === "") return yield* hubError("Enter a token to sign in with.");
    const session = yield* hubApi.signIn(hubUrl, kind, token);
    yield* secrets
      .set(SESSION_SECRET, Buffer.from(session.session, "utf8"))
      .pipe(Effect.mapError(() => hubError("Could not store the hub session.")));
    yield* updatePersisted((p) => ({ ...p, hubUrl, account: session.account }));
    return yield* syncNow;
  }, lock.withPermits(1));

  const signOut: HotovoHub["Service"]["signOut"] = Effect.gen(function* () {
    const { persisted } = yield* Ref.get(stateRef);
    const session = yield* readSession;
    for (const projectId of Object.keys(persisted.sharedInstances)) {
      if (persisted.hubUrl !== null && Option.isSome(session)) {
        yield* hubApi
          .revokeCredentials(persisted.hubUrl, session.value, projectId, environmentId)
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* removeSharedInstances(projectId);
    }
    if (persisted.hubUrl !== null && Option.isSome(session)) {
      yield* hubApi
        .signOut(persisted.hubUrl, session.value)
        .pipe(Effect.ignoreCause({ log: true }));
    }
    yield* secrets.remove(SESSION_SECRET).pipe(Effect.ignoreCause({ log: true }));
    // Keep the hub address so signing back in is one click.
    yield* updatePersisted(() => ({ ...EMPTY_PERSISTED, hubUrl: persisted.hubUrl }));
    yield* updateRuntime((s) => ({ ...s, error: null, peers: new Map(), sharedErrors: new Map() }));
    return yield* publish;
  }).pipe(lock.withPermits(1));

  const sync: HotovoHub["Service"]["sync"] = syncNow.pipe(lock.withPermits(1));

  const findProject = (projectId: string) =>
    Effect.gen(function* () {
      const manifest = (yield* Ref.get(stateRef)).persisted.manifest;
      const project = manifest?.projects.find((p) => p.id === projectId);
      if (project === undefined)
        return yield* hubError(`The hub gives you no project "${projectId}".`);
      return project;
    });

  const cloneAndRegister = (project: HotovoHubProject) =>
    Effect.gen(function* () {
      for (const repo of project.repositories) {
        const path = repoPath(project.id, repo.id);
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
            commandId: CommandId.make(`hotovo-open:${NodeCrypto.randomUUID()}`),
            projectId: ProjectId.make(
              `hotovo-${project.id}-${repo.id}-${NodeCrypto.randomBytes(3).toString("hex")}`,
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

  const openProject: HotovoHub["Service"]["openProject"] = Effect.fn("HotovoHub.openProject")(
    function* (input) {
      const project = yield* findProject(input.projectId);
      if (project.repositories.length === 0) {
        return yield* hubError(`${project.name} declares no repositories yet.`);
      }
      // Clones can take minutes; the status stream reports progress.
      yield* background(cloneAndRegister(project));
      return yield* publish;
    },
  );

  const enableSharedCapacity = (project: HotovoHubProject) =>
    Effect.gen(function* () {
      const { hubUrl, session } = yield* requireSession;
      const shared = project.capacity.shared;
      if (shared === undefined) return yield* hubError(`${project.name} has no company capacity.`);
      const credentials = yield* hubApi.issueCredentials(
        hubUrl,
        session,
        project.id,
        environmentId,
      );
      const claudeModels = credentials.models
        .filter((m) => m.harness.includes("claude"))
        .map((m) => m.id);
      if (claudeModels.length === 0) {
        yield* hubApi
          .revokeCredentials(hubUrl, session, project.id, environmentId)
          .pipe(Effect.ignoreCause({ log: true }));
        return yield* hubError(
          `${project.name}'s company capacity has no Claude models for this app yet.`,
        );
      }
      const pick = (family: string) => claudeModels.find((id) => id.includes(family));
      const homePath = NodePath.join(hubHome, "claude", project.id);
      yield* Effect.tryPromise(() =>
        NodeFSP.mkdir(homePath, { recursive: true, mode: 0o700 }),
      ).pipe(
        Effect.mapError(() =>
          hubError("Could not create the company capacity's config directory."),
        ),
      );
      const instanceId = ProviderInstanceId.make(`hotovo-${project.id}-claude`.slice(0, 64));
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
            displayName: `${project.name} · ${(yield* Ref.get(stateRef)).persisted.manifest?.hub.displayName ?? "Hub"} API`,
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
        .pipe(Effect.mapError(() => hubError("Could not save the company capacity provider.")));
      yield* updatePersisted((p) => ({
        ...p,
        sharedInstances: { ...p.sharedInstances, [project.id]: [instanceId] },
      }));
    });

  const setSharedCapacity: HotovoHub["Service"]["setSharedCapacity"] = Effect.fn(
    "HotovoHub.setSharedCapacity",
  )(function* (input) {
    const project = yield* findProject(input.projectId);
    const clearError = updateRuntime((s) => {
      const sharedErrors = new Map(s.sharedErrors);
      sharedErrors.delete(project.id);
      return { ...s, sharedErrors };
    });
    if (input.enabled) {
      const result = yield* enableSharedCapacity(project).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* updateRuntime((s) => ({
          ...s,
          sharedErrors: new Map(s.sharedErrors).set(project.id, result.failure.detail),
        }));
        yield* publish;
        return yield* result.failure;
      }
      yield* clearError;
    } else {
      const { persisted } = yield* Ref.get(stateRef);
      const session = yield* readSession;
      if (persisted.hubUrl !== null && Option.isSome(session)) {
        yield* hubApi
          .revokeCredentials(persisted.hubUrl, session.value, project.id, environmentId)
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* removeSharedInstances(project.id);
      yield* clearError;
    }
    return yield* publish;
  }, lock.withPermits(1));

  const projectUsage: HotovoHub["Service"]["projectUsage"] = Effect.fn("HotovoHub.projectUsage")(
    function* (input) {
      const { hubUrl, session } = yield* requireSession;
      return yield* hubApi.projectUsage(hubUrl, session, input.projectId);
    },
  );

  // Keep the manifest fresh and colleagues' presence current.
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

  return HotovoHub.of({
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
    signIn,
    signOut,
    sync,
    openProject,
    setSharedCapacity,
    projectUsage,
  });
});

export const layer = Layer.effect(HotovoHub, make);
