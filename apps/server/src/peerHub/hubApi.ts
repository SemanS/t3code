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
  type PeerWorkStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

const Ok = Schema.Struct({});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

const SESSION_ENDED = "Your session with the hub ended. Sign in again.";

/** The hub no longer accepts the stored session (signed out elsewhere, expired). */
export const isSessionEnded = (error: PeerHubError) => error.detail === SESSION_ENDED;

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
  };
});
