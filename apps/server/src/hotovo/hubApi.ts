/**
 * hubApi — the hub service's HTTP API. Every call carries the member's hub
 * session; a provider token is sent once, to sign in, and never stored.
 *
 * @module hotovo/hubApi
 */
import {
  HotovoHubError,
  HotovoHubManifest,
  HotovoHubPeerThread,
  HotovoHubProjectUsage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const SessionResponse = Schema.Struct({
  session: Schema.String,
  member: Schema.String,
  account: Schema.String,
  expiresAt: Schema.String,
});

const CredentialsResponse = Schema.Struct({
  project: Schema.String,
  baseUrl: Schema.String,
  apiKey: Schema.String,
  keyId: Schema.String,
  models: Schema.Array(Schema.Struct({ id: Schema.String, harness: Schema.Array(Schema.String) })),
});

const PresenceResponse = Schema.Struct({
  project: Schema.String,
  peers: Schema.Array(
    Schema.Struct({
      member: Schema.String,
      environment: Schema.String,
      threads: Schema.Array(HotovoHubPeerThread),
      seenAt: Schema.String,
    }),
  ),
});
export type HubPresence = typeof PresenceResponse.Type;

const Ok = Schema.Struct({});
const ErrorBody = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodeErrorBody = Schema.decodeUnknownOption(ErrorBody);

export const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;

  const request = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    input: {
      readonly hubUrl: string;
      readonly path: string;
      readonly method?: "GET" | "POST" | "DELETE";
      readonly session?: string | undefined;
      readonly body?: unknown;
    },
  ): Effect.Effect<S["Type"], HotovoHubError> =>
    Effect.gen(function* () {
      const url = `${input.hubUrl.replace(/\/+$/, "")}${input.path}`;
      const base =
        input.method === "POST"
          ? HttpClientRequest.post(url)
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
          () => new HotovoHubError({ detail: `Could not reach the hub at ${input.hubUrl}.` }),
        ),
      );
      const json = yield* response.json.pipe(
        Effect.mapError(
          () =>
            new HotovoHubError({
              detail: `The hub answered ${input.path} with something other than JSON.`,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const decoded = decodeErrorBody(json);
        return yield* new HotovoHubError({
          detail:
            decoded._tag === "Some"
              ? decoded.value.error.message
              : `The hub refused ${input.path} (HTTP ${response.status}).`,
        });
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          () =>
            new HotovoHubError({
              detail: `The hub's answer to ${input.path} has an unexpected shape.`,
            }),
        ),
      );
    });

  return {
    signIn: (hubUrl: string, kind: "github" | "bitbucket", token: string) =>
      request(SessionResponse, {
        hubUrl,
        path: "/v1/auth/token",
        method: "POST",
        body: { kind, token },
      }),

    signOut: (hubUrl: string, session: string) =>
      request(Ok, { hubUrl, path: "/v1/auth/signout", method: "POST", session, body: {} }),

    manifest: (hubUrl: string, session: string) =>
      request(HotovoHubManifest, { hubUrl, path: "/v1/me/manifest", session }),

    issueCredentials: (hubUrl: string, session: string, projectId: string, environment: string) =>
      request(CredentialsResponse, {
        hubUrl,
        path: `/v1/projects/${encodeURIComponent(projectId)}/credentials`,
        method: "POST",
        session,
        body: { environment },
      }),

    revokeCredentials: (hubUrl: string, session: string, projectId: string, environment: string) =>
      request(Ok, {
        hubUrl,
        path: `/v1/projects/${encodeURIComponent(projectId)}/credentials?environment=${encodeURIComponent(environment)}`,
        method: "DELETE",
        session,
      }),

    projectUsage: (hubUrl: string, session: string, projectId: string) =>
      request(HotovoHubProjectUsage, {
        hubUrl,
        path: `/v1/projects/${encodeURIComponent(projectId)}/usage`,
        session,
      }),

    projectPresence: (hubUrl: string, session: string, projectId: string) =>
      request(PresenceResponse, {
        hubUrl,
        path: `/v1/projects/${encodeURIComponent(projectId)}/presence`,
        session,
      }),

    reportPresence: (
      hubUrl: string,
      session: string,
      body: {
        readonly environment: string;
        readonly projects: ReadonlyArray<{
          readonly id: string;
          readonly threads: ReadonlyArray<HotovoHubPeerThread>;
        }>;
      },
    ) => request(Ok, { hubUrl, path: "/v1/presence", method: "POST", session, body }),
  };
});
