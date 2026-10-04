/**
 * hubApi — the Peer Hub's HTTP API. Signing in mails a one-time code to the
 * person's address; every later call carries the session it returns.
 *
 * @module peerHub/hubApi
 */
import {
  PeerAgentView,
  PeerFoundWorkspace,
  PeerHubError,
  PeerHubProjectUsage,
  PeerManifest,
  PeerTask,
  PeerWorkThread,
  PeerWorkspaceRole,
  PeerWorkStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const SignInStarted = Schema.Struct({
  email: Schema.String,
  sent: Schema.Boolean,
  /** Only from a hub running with PEERHUB_MAIL=echo (local development and tests). */
  code: Schema.optional(Schema.String),
});

const SignInFinished = Schema.Struct({
  session: Schema.String,
  email: Schema.String,
  expiresAt: Schema.String,
});

const WorkspaceSummary = Schema.Struct({
  slug: Schema.String,
  name: Schema.String,
  allowedDomains: Schema.Array(Schema.String),
});

const Me = Schema.Struct({
  email: Schema.String,
  workspaces: Schema.Array(Schema.Struct({ ...WorkspaceSummary.fields, role: PeerWorkspaceRole })),
  joinable: Schema.Array(
    Schema.Struct({
      ...WorkspaceSummary.fields,
      joinReason: Schema.Literals(["domain", "invite"]),
    }),
  ),
});
export type HubMe = typeof Me.Type;

const CredentialsResponse = Schema.Struct({
  project: Schema.String,
  baseUrl: Schema.String,
  apiKey: Schema.String,
  keyId: Schema.String,
  models: Schema.Array(Schema.Struct({ id: Schema.String, harness: Schema.Array(Schema.String) })),
});

const WorkResponse = Schema.Struct({
  projects: Schema.Record(
    Schema.String,
    Schema.Struct({
      areas: Schema.Array(Schema.String),
      tasks: Schema.Array(PeerTask),
      threads: Schema.Array(PeerWorkThread),
    }),
  ),
});
export type HubWork = typeof WorkResponse.Type;

export interface ReportedThread {
  readonly id: string;
  readonly project: string;
  readonly task?: string;
  readonly title: string;
  readonly status: PeerWorkStatus;
  readonly harness?: string;
  readonly branch?: string;
  readonly source: "peer" | "herdr";
  /** Its owner lets the project's members watch it live. */
  readonly observable?: boolean;
}

const HubCoordSession = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  email: Schema.String,
  environment: Schema.String,
  label: Schema.String,
  agent: Schema.optional(Schema.String),
  task: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  status: PeerWorkStatus,
  intent: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
  claims: Schema.Array(Schema.String),
  seenAt: Schema.String,
  /** When its agent last did something; a hub from before activity times has none. */
  activeAt: Schema.optional(Schema.String),
});
export type HubCoordSession = typeof HubCoordSession.Type;

const HubOverlap = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  sessions: Schema.Array(Schema.String),
  files: Schema.Array(Schema.String),
  state: Schema.Literals(["open", "resolved"]),
  resolution: Schema.optional(Schema.String),
  resolvedFiles: Schema.optional(Schema.Array(Schema.String)),
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      session: Schema.optional(Schema.String),
      email: Schema.String,
      text: Schema.String,
      at: Schema.String,
    }),
  ),
  openedAt: Schema.String,
  updatedAt: Schema.String,
});
export type HubOverlap = typeof HubOverlap.Type;

const HubFinding = Schema.Struct({
  id: Schema.String,
  project: Schema.String,
  task: Schema.optional(Schema.String),
  text: Schema.String,
  email: Schema.String,
  session: Schema.String,
  environment: Schema.String,
  at: Schema.String,
});
export type HubFinding = typeof HubFinding.Type;

const HubContextKeeper = Schema.Struct({
  session: Schema.String,
  email: Schema.String,
  environment: Schema.String,
  since: Schema.String,
});
export type HubContextKeeper = typeof HubContextKeeper.Type;

/** A task's (or a project's) shared context and who keeps it, without its text. */
const HubContext = Schema.Struct({
  project: Schema.String,
  scope: Schema.String,
  version: Schema.Number,
  keeper: Schema.optional(HubContextKeeper),
  updatedAt: Schema.String,
  updatedBy: Schema.optional(Schema.String),
  updatedSession: Schema.optional(Schema.String),
  restoredFrom: Schema.optional(Schema.Number),
  gist: Schema.optional(Schema.String),
  bytes: Schema.optional(Schema.Number),
});
export type HubContext = typeof HubContext.Type;

/** A kept version of a shared context, without its text. */
const HubContextVersion = Schema.Struct({
  version: Schema.Number,
  at: Schema.String,
  by: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  restoredFrom: Schema.optional(Schema.Number),
  bytes: Schema.Number,
  added: Schema.Number,
  dropped: Schema.Number,
});
export type HubContextVersion = typeof HubContextVersion.Type;

const HubContextVersionText = Schema.Struct({
  version: Schema.Number,
  at: Schema.String,
  by: Schema.optional(Schema.String),
  session: Schema.optional(Schema.String),
  restoredFrom: Schema.optional(Schema.Number),
  added: Schema.Array(Schema.String),
  dropped: Schema.Array(Schema.String),
  text: Schema.String,
});
export type HubContextVersionText = typeof HubContextVersionText.Type;

const HubContextText = Schema.Struct({ ...HubContext.fields, text: Schema.String });
export type HubContextText = typeof HubContextText.Type;

/** Why the hub would not let a session keep or write a context. */
export type ContextRefusal =
  | { readonly refused: "kept"; readonly keeper: HubContextKeeper | undefined }
  | { readonly refused: "stale"; readonly current: HubContextText };

const KeeperDetails = Schema.Struct({ keeper: Schema.optional(Schema.NullOr(HubContextKeeper)) });
const decodeKeeperDetails = Schema.decodeUnknownOption(KeeperDetails);
const decodeContextText = Schema.decodeUnknownOption(HubContextText);

const CoordView = Schema.Struct({
  sessions: Schema.Array(HubCoordSession),
  overlaps: Schema.Array(HubOverlap),
  /** A hub from before findings has none. */
  findings: Schema.optional(Schema.Array(HubFinding)),
  /** Nor before shared contexts. */
  contexts: Schema.optional(Schema.Array(HubContext)),
  at: Schema.String,
});
export type HubCoordView = typeof CoordView.Type;

/** One agent session as this environment reports it for coordination. */
export interface ReportedSession {
  readonly id: string;
  readonly project: string;
  readonly label: string;
  readonly agent?: string;
  readonly task?: string;
  readonly branch?: string;
  readonly status: PeerWorkStatus;
  readonly intent?: string;
  readonly files: ReadonlyArray<string>;
  readonly claims: ReadonlyArray<string>;
  /** The "For the team" lines of its working context. */
  readonly findings?: ReadonlyArray<string>;
  /** When its agent last did something: an idle keeper gives way to an agent at work. */
  readonly activeAt?: string;
}

const Ok = Schema.Struct({});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  }),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const SESSION_ENDED = "Your session with the hub ended. Sign in again.";

/** The hub no longer accepts the stored session (signed out elsewhere, expired). */
export const isSessionEnded = (error: PeerHubError) => error.detail === SESSION_ENDED;

/**
 * What a workspace's event stream pings about; `observe` asks a computer to
 * send a shared thread's view, `resync` follows pings it missed.
 */
export type HubChange = "work" | "coord" | "projects" | "observe" | "resync";

export interface HubPing {
  readonly change: HubChange;
  /** The environment whose report caused it, so that environment can skip its own echo. */
  readonly origin: string | null;
  /** For `observe`: the computer and the thread someone watches. */
  readonly environment?: string;
  readonly thread?: string;
}

const CHANGES: ReadonlySet<string> = new Set<HubChange>([
  "work",
  "coord",
  "projects",
  "observe",
  "resync",
]);
const PingData = Schema.Struct({
  origin: Schema.optional(Schema.NullOr(Schema.String)),
  environment: Schema.optional(Schema.String),
  thread: Schema.optional(Schema.String),
});
const decodePingData = Schema.decodeUnknownOption(Schema.fromJsonString(PingData));

const NO_EVENTS = "The hub sends no change events.";
/** The hub predates push (or the workspace is not the caller's): ask again much later. */
export const isWithoutEvents = (error: PeerHubError) => error.detail === NO_EVENTS;

const isPeerHubError = Schema.is(PeerHubError);
const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(PeerAgentView));
const Watchers = Schema.Struct({ watchers: Schema.Number });

/** The hub's keep-alive comes every 20 s; this long without a byte means the stream is gone. */
const EVENTS_SILENT_AFTER = "70 seconds";

const segment = (value: string) => encodeURIComponent(value);

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const request = <S extends Schema.Top & { readonly DecodingServices: never }, Missing = never>(
    schema: S,
    input: {
      readonly hubUrl: string;
      readonly path: string;
      readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly session?: string | undefined;
      readonly body?: unknown;
      /** What a 404 means instead of an error, e.g. "no such workspace". */
      readonly notFound?: { readonly value: Missing };
      /** What a 409 means instead of an error, from its code and details; undefined: an error. */
      readonly conflict?: (code: string, details: unknown) => Missing | undefined;
    },
  ): Effect.Effect<S["Type"] | Missing, PeerHubError> =>
    Effect.gen(function* () {
      const url = `${input.hubUrl.replace(/\/+$/, "")}${input.path}`;
      const base =
        input.method === "POST"
          ? HttpClientRequest.post(url)
          : input.method === "PUT"
            ? HttpClientRequest.put(url)
            : input.method === "PATCH"
              ? HttpClientRequest.patch(url)
              : input.method === "DELETE"
                ? HttpClientRequest.delete(url)
                : HttpClientRequest.get(url);
      const withAuth =
        input.session === undefined
          ? base
          : base.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${input.session}`));
      const prepared =
        input.body === undefined
          ? withAuth
          : withAuth.pipe(HttpClientRequest.bodyJsonUnsafe(input.body));
      const response = yield* client.execute(prepared).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(
          () => new PeerHubError({ detail: `Could not reach the hub at ${input.hubUrl}.` }),
        ),
      );
      const json = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new PeerHubError({
              detail: `The hub answered ${input.path} with something other than JSON.`,
            }),
        ),
      );
      if (response.status === 404 && input.notFound !== undefined) return input.notFound.value;
      if (response.status < 200 || response.status >= 300) {
        const decoded = decodeErrorBody(json);
        if (response.status === 409 && input.conflict !== undefined && decoded._tag === "Some") {
          const meant = input.conflict(decoded.value.error.code, decoded.value.error.details);
          if (meant !== undefined) return meant;
        }
        if (
          response.status === 401 &&
          decoded._tag === "Some" &&
          decoded.value.error.code === "unauthenticated"
        ) {
          return yield* new PeerHubError({ detail: SESSION_ENDED });
        }
        return yield* new PeerHubError({
          detail:
            decoded._tag === "Some"
              ? decoded.value.error.message
              : `The hub refused ${input.path} (HTTP ${response.status}).`,
        });
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          () =>
            new PeerHubError({
              detail: `The hub's answer to ${input.path} has an unexpected shape.`,
            }),
        ),
      );
    });

  const workspacePath = (slug: string, rest = "") => `/v1/workspaces/${segment(slug)}${rest}`;
  const projectPath = (slug: string, projectId: string, rest: string) =>
    workspacePath(slug, `/projects/${segment(projectId)}${rest}`);

  return {
    startSignIn: (hubUrl: string, email: string) =>
      request(SignInStarted, {
        hubUrl,
        path: "/v1/auth/email/start",
        method: "POST",
        body: { email },
      }),

    finishSignIn: (hubUrl: string, email: string, code: string) =>
      request(SignInFinished, {
        hubUrl,
        path: "/v1/auth/email/verify",
        method: "POST",
        body: { email, code },
      }),

    signOut: (hubUrl: string, session: string) =>
      request(Ok, { hubUrl, path: "/v1/auth/signout", method: "POST", session, body: {} }),

    me: (hubUrl: string, session: string) => request(Me, { hubUrl, path: "/v1/me", session }),

    createWorkspace: (
      hubUrl: string,
      session: string,
      body: {
        readonly slug: string;
        readonly name: string;
        readonly allowedDomains: ReadonlyArray<string>;
      },
    ) =>
      request(WorkspaceSummary, {
        hubUrl,
        path: "/v1/workspaces",
        method: "POST",
        session,
        body,
      }),

    /** A workspace by its short name, or null when there is none. */
    findWorkspace: (hubUrl: string, session: string, slug: string) =>
      request(PeerFoundWorkspace, {
        hubUrl,
        path: workspacePath(slug),
        session,
        notFound: { value: null },
      }),

    join: (hubUrl: string, session: string, slug: string) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, "/join"),
        method: "POST",
        session,
        body: {},
      }),

    leave: (hubUrl: string, session: string, slug: string) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, "/leave"),
        method: "POST",
        session,
        body: {},
      }),

    invite: (
      hubUrl: string,
      session: string,
      slug: string,
      body: { readonly email: string; readonly role: "admin" | "member" },
    ) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, "/invites"),
        method: "POST",
        session,
        body,
      }),

    manifest: (hubUrl: string, session: string, slug: string) =>
      request(PeerManifest, { hubUrl, path: workspacePath(slug, "/manifest"), session }),

    issueCredentials: (
      hubUrl: string,
      session: string,
      slug: string,
      projectId: string,
      environment: string,
    ) =>
      request(CredentialsResponse, {
        hubUrl,
        path: projectPath(slug, projectId, "/credentials"),
        method: "POST",
        session,
        body: { environment },
      }),

    revokeCredentials: (
      hubUrl: string,
      session: string,
      slug: string,
      projectId: string,
      environment: string,
    ) =>
      request(Ok, {
        hubUrl,
        path: projectPath(
          slug,
          projectId,
          `/credentials?environment=${encodeURIComponent(environment)}`,
        ),
        method: "DELETE",
        session,
      }),

    projectUsage: (hubUrl: string, session: string, slug: string, projectId: string) =>
      request(PeerHubProjectUsage, {
        hubUrl,
        path: projectPath(slug, projectId, "/usage"),
        session,
      }),

    /** Every project of the workspace the caller is on: areas, tasks and recent threads. */
    work: (hubUrl: string, session: string, slug: string) =>
      request(WorkResponse, { hubUrl, path: workspacePath(slug, "/work"), session }),

    /** This environment's threads, replacing what it reported before. */
    reportThreads: (
      hubUrl: string,
      session: string,
      slug: string,
      body: { readonly environment: string; readonly threads: ReadonlyArray<ReportedThread> },
    ) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, "/threads"),
        method: "PUT",
        session,
        body,
      }),

    /** The agent sessions at work on the caller's projects and their overlaps. */
    coordination: (hubUrl: string, session: string, slug: string) =>
      request(CoordView, { hubUrl, path: workspacePath(slug, "/coord"), session }),

    /** This environment's agent sessions, replacing what it reported before; answers the view. */
    reportCoordination: (
      hubUrl: string,
      session: string,
      slug: string,
      body: { readonly environment: string; readonly sessions: ReadonlyArray<ReportedSession> },
    ) =>
      request(CoordView, {
        hubUrl,
        path: workspacePath(slug, "/coord"),
        method: "PUT",
        session,
        body,
      }),

    noteOverlap: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      overlap: string,
      body: { readonly session?: string; readonly text: string },
    ) =>
      request(HubOverlap, {
        hubUrl,
        path: workspacePath(slug, `/coord/${segment(project)}/${segment(overlap)}/notes`),
        method: "POST",
        session,
        body,
      }),

    resolveOverlap: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      overlap: string,
      body: { readonly session?: string; readonly resolution: string },
    ) =>
      request(HubOverlap, {
        hubUrl,
        path: workspacePath(slug, `/coord/${segment(project)}/${segment(overlap)}/resolve`),
        method: "POST",
        session,
        body,
      }),

    /** A task's shared context with its text, or null when it has none. */
    readContext: (hubUrl: string, session: string, slug: string, project: string, scope: string) =>
      request(HubContextText, {
        hubUrl,
        path: workspacePath(slug, `/contexts/${segment(project)}/${segment(scope)}`),
        session,
        notFound: { value: null },
      }),

    /** The versions of a shared context the hub keeps, newest first. */
    contextVersions: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      scope: string,
    ) =>
      request(Schema.Array(HubContextVersion), {
        hubUrl,
        path: workspacePath(slug, `/contexts/${segment(project)}/${segment(scope)}/versions`),
        session,
        notFound: { value: [] },
      }),

    /** One kept version with its text, or null when the hub no longer keeps it. */
    contextVersion: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      scope: string,
      version: number,
    ) =>
      request(HubContextVersionText, {
        hubUrl,
        path: workspacePath(
          slug,
          `/contexts/${segment(project)}/${segment(scope)}/versions/${Math.trunc(version)}`,
        ),
        session,
        notFound: { value: null },
      }),

    /** Brings an older version back as a new one, by the person signed in here. */
    restoreContext: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      scope: string,
      version: number,
    ) =>
      request(HubContextText, {
        hubUrl,
        path: workspacePath(slug, `/contexts/${segment(project)}/${segment(scope)}/restore`),
        method: "POST",
        session,
        body: { version: Math.trunc(version) },
      }),

    /**
     * Asks for an agent session to keep a shared context (or, with `release`,
     * gives it up): the context with its text, or who keeps it instead.
     */
    keepContext: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      scope: string,
      body: { readonly environment: string; readonly session: string; readonly release?: boolean },
    ) =>
      request(HubContextText, {
        hubUrl,
        path: workspacePath(slug, `/contexts/${segment(project)}/${segment(scope)}/keeper`),
        method: "POST",
        session,
        body,
        conflict: (code, details): ContextRefusal | undefined => {
          const keeper = decodeKeeperDetails(details);
          return code === "kept" && keeper._tag === "Some"
            ? { refused: "kept", keeper: keeper.value.keeper ?? undefined }
            : undefined;
        },
      }),

    /** A new version from the session keeping a context, written on `baseVersion`. */
    writeContext: (
      hubUrl: string,
      session: string,
      slug: string,
      project: string,
      scope: string,
      body: {
        readonly environment: string;
        readonly session: string;
        readonly baseVersion: number;
        readonly text: string;
      },
    ) =>
      request(HubContextText, {
        hubUrl,
        path: workspacePath(slug, `/contexts/${segment(project)}/${segment(scope)}`),
        method: "PUT",
        session,
        body,
        conflict: (code, details): ContextRefusal | undefined => {
          if (code === "stale") {
            const current = decodeContextText(details);
            return current._tag === "Some"
              ? { refused: "stale", current: current.value }
              : undefined;
          }
          const keeper = decodeKeeperDetails(details);
          return code === "not_keeper" && keeper._tag === "Some"
            ? { refused: "kept", keeper: keeper.value.keeper ?? undefined }
            : undefined;
        },
      }),

    createTask: (
      hubUrl: string,
      session: string,
      slug: string,
      projectId: string,
      body: { readonly title: string; readonly key?: string; readonly area?: string },
    ) =>
      request(PeerTask, {
        hubUrl,
        path: projectPath(slug, projectId, "/tasks"),
        method: "POST",
        session,
        body,
      }),

    updateTask: (
      hubUrl: string,
      session: string,
      slug: string,
      projectId: string,
      taskId: string,
      body: {
        readonly title?: string;
        readonly area?: string;
        readonly status?: "open" | "done";
      },
    ) =>
      request(PeerTask, {
        hubUrl,
        path: projectPath(slug, projectId, `/tasks/${segment(taskId)}`),
        method: "PATCH",
        session,
        body,
      }),

    deleteTask: (
      hubUrl: string,
      session: string,
      slug: string,
      projectId: string,
      taskId: string,
    ) =>
      request(Ok, {
        hubUrl,
        path: projectPath(slug, projectId, `/tasks/${segment(taskId)}`),
        method: "DELETE",
        session,
      }),

    /** Shares a repository with the whole workspace as a project. */
    shareProject: (
      hubUrl: string,
      session: string,
      slug: string,
      body: {
        readonly id: string;
        readonly name: string;
        readonly repositories: ReadonlyArray<{
          readonly id: string;
          readonly url: string;
          readonly branch: string;
        }>;
        readonly areas: ReadonlyArray<string>;
      },
    ) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, "/projects"),
        method: "POST",
        session,
        body,
      }),

    unshareProject: (hubUrl: string, session: string, slug: string, projectId: string) =>
      request(Ok, {
        hubUrl,
        path: workspacePath(slug, `/projects/${segment(projectId)}`),
        method: "DELETE",
        session,
      }),

    /**
     * The workspace's change pings as they come. Ends when the hub closes the
     * stream (it does every 15 minutes); fails when the hub refuses it or the
     * stream goes silent past the hub's keep-alive.
     */
    events: (hubUrl: string, session: string, slug: string): Stream.Stream<HubPing, PeerHubError> =>
      client
        .execute(
          HttpClientRequest.get(
            `${hubUrl.replace(/\/+$/, "")}${workspacePath(slug, "/events")}`,
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${session}`),
            HttpClientRequest.setHeader("Accept", "text/event-stream"),
          ),
        )
        .pipe(
          Effect.mapError(
            () => new PeerHubError({ detail: `Could not reach the hub at ${hubUrl}.` }),
          ),
          Effect.filterOrFail(
            (response) => response.status === 200,
            (response) =>
              new PeerHubError({
                detail:
                  response.status === 404
                    ? NO_EVENTS
                    : response.status === 401
                      ? SESSION_ENDED
                      : `The hub refused its event stream (HTTP ${response.status}).`,
              }),
          ),
          Effect.map((response) =>
            response.stream.pipe(
              Stream.timeoutOrElse({
                duration: EVENTS_SILENT_AFTER,
                orElse: () =>
                  Stream.fail(new PeerHubError({ detail: "The hub's event stream went silent." })),
              }),
              Stream.decodeText,
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError((error) =>
                isPeerHubError(error)
                  ? error
                  : new PeerHubError({ detail: "The hub's event stream broke off." }),
              ),
              Stream.map((event): HubPing | null => {
                if (!CHANGES.has(event.event)) return null;
                const data = Option.getOrUndefined(decodePingData(event.data));
                return {
                  change: event.event as HubChange,
                  origin: data?.origin ?? null,
                  ...(data?.environment === undefined ? {} : { environment: data.environment }),
                  ...(data?.thread === undefined ? {} : { thread: data.thread }),
                };
              }),
              Stream.filter((ping): ping is HubPing => ping !== null),
            ),
          ),
          Stream.unwrap,
        ),

    /**
     * A colleague's shared thread as the hub relays it while you watch: each
     * view its owner's Peer sends. Ends when the hub closes the stream; fails
     * when the thread is not shared with you (any more).
     */
    observe: (
      hubUrl: string,
      session: string,
      slug: string,
      environment: string,
      thread: string,
    ): Stream.Stream<PeerAgentView, PeerHubError> =>
      client
        .execute(
          HttpClientRequest.get(
            `${hubUrl.replace(/\/+$/, "")}${workspacePath(
              slug,
              `/observe/${segment(environment)}/${segment(thread)}`,
            )}`,
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${session}`),
            HttpClientRequest.setHeader("Accept", "text/event-stream"),
          ),
        )
        .pipe(
          Effect.mapError(
            () => new PeerHubError({ detail: `Could not reach the hub at ${hubUrl}.` }),
          ),
          Effect.filterOrFail(
            (response) => response.status === 200,
            (response) =>
              new PeerHubError({
                detail:
                  response.status === 404
                    ? "That thread is not shared with you, or no longer runs."
                    : response.status === 401
                      ? SESSION_ENDED
                      : `The hub refused to relay that thread (HTTP ${response.status}).`,
              }),
          ),
          Effect.map((response) =>
            response.stream.pipe(
              Stream.timeoutOrElse({
                duration: EVENTS_SILENT_AFTER,
                orElse: () =>
                  Stream.fail(new PeerHubError({ detail: "The relayed thread went silent." })),
              }),
              Stream.decodeText,
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError((error) =>
                isPeerHubError(error)
                  ? error
                  : new PeerHubError({ detail: "The relayed thread broke off." }),
              ),
              Stream.filter((event) => event.event === "view"),
              Stream.map((event) => Option.getOrUndefined(decodeView(event.data))),
              Stream.filter((view): view is PeerAgentView => view !== undefined),
            ),
          ),
          Stream.unwrap,
        ),

    /** Sends a shared thread's view to whoever watches it; how many do. */
    publishView: (
      hubUrl: string,
      session: string,
      slug: string,
      environment: string,
      thread: string,
      view: unknown,
    ) =>
      request(Watchers, {
        hubUrl,
        path: workspacePath(slug, `/observe/${segment(environment)}/${segment(thread)}`),
        method: "PUT",
        session,
        body: view,
      }).pipe(Effect.map((answer) => answer.watchers)),
  };
});
