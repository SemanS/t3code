/**
 * hubApi — the Peer Hub's HTTP API. Signing in mails a one-time code to the
 * person's address; every later call carries the session it returns.
 *
 * @module peerHub/hubApi
 */
import {
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

const CoordView = Schema.Struct({
  sessions: Schema.Array(HubCoordSession),
  overlaps: Schema.Array(HubOverlap),
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
}

const Ok = Schema.Struct({});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const SESSION_ENDED = "Your session with the hub ended. Sign in again.";

/** The hub no longer accepts the stored session (signed out elsewhere, expired). */
export const isSessionEnded = (error: PeerHubError) => error.detail === SESSION_ENDED;

/** What a workspace's event stream pings about; `resync` follows pings it missed. */
export type HubChange = "work" | "coord" | "projects" | "resync";

export interface HubPing {
  readonly change: HubChange;
  /** The environment whose report caused it, so that environment can skip its own echo. */
  readonly origin: string | null;
}

const CHANGES: ReadonlySet<string> = new Set<HubChange>(["work", "coord", "projects", "resync"]);
const PingData = Schema.Struct({ origin: Schema.optional(Schema.NullOr(Schema.String)) });
const decodePingData = Schema.decodeUnknownOption(Schema.fromJsonString(PingData));

const NO_EVENTS = "The hub sends no change events.";
/** The hub predates push (or the workspace is not the caller's): ask again much later. */
export const isWithoutEvents = (error: PeerHubError) => error.detail === NO_EVENTS;

const isPeerHubError = Schema.is(PeerHubError);

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
              Stream.map((event): HubPing | null =>
                CHANGES.has(event.event)
                  ? {
                      change: event.event as HubChange,
                      origin: Option.getOrUndefined(decodePingData(event.data))?.origin ?? null,
                    }
                  : null,
              ),
              Stream.filter((ping): ping is HubPing => ping !== null),
            ),
          ),
          Stream.unwrap,
        ),
  };
});
