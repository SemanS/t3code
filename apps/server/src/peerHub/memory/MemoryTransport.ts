import { PeerManifest, type PeerMemoryScope } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export class MemoryError extends Schema.TaggedError<MemoryError>()("MemoryError", {
  code: Schema.Literals(["unavailable", "not_found", "conflict", "invalid", "local"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface MemoryIdentity {
  readonly hubUrl: string;
  readonly email: string;
  readonly token: string;
  readonly environmentId: string;
}
export class MemoryAuth extends Context.Service<
  MemoryAuth,
  {
    readonly identity: Effect.Effect<MemoryIdentity, MemoryError>;
    readonly repository: (
      scope: PeerMemoryScope,
      repositoryId: string,
    ) => Effect.Effect<
      {
        readonly root: string;
        readonly branch: string;
      },
      MemoryError
    >;
  }
>()("t3/peerHub/memory/MemoryTransport/MemoryAuth") {}

export class MemoryTransport extends Context.Service<
  MemoryTransport,
  {
    readonly identity: Effect.Effect<MemoryIdentity, MemoryError>;
    readonly authorize: (
      identity: MemoryIdentity,
      scope: PeerMemoryScope,
    ) => Effect.Effect<void, MemoryError>;
    readonly request: <S extends Schema.Top & { readonly DecodingServices: never }>(
      identity: MemoryIdentity,
      scope: PeerMemoryScope,
      method: "GET" | "POST" | "PUT",
      path: string,
      schema: S,
      body?: unknown,
    ) => Effect.Effect<S["Type"], MemoryError>;
  }
>()("t3/peerHub/memory/MemoryTransport") {}

const ErrorResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const decodeError = Schema.decodeUnknownOption(ErrorResponse);
const prefix = (scope: PeerMemoryScope) =>
  `/v1/workspaces/${encodeURIComponent(scope.workspace)}/projects/${encodeURIComponent(scope.project)}/memory`;

const make = Effect.gen(function* () {
  const auth = yield* MemoryAuth;
  const client = yield* HttpClient.HttpClient;
  const request: MemoryTransport["Service"]["request"] = (
    identity,
    scope,
    method,
    path,
    schema,
    body,
  ) =>
    Effect.gen(function* () {
      const url = `${identity.hubUrl.replace(/\/+$/, "")}${path.startsWith("/v1/") ? path : `${prefix(scope)}${path}`}`;
      const base =
        method === "POST"
          ? HttpClientRequest.post(url)
          : method === "PUT"
            ? HttpClientRequest.put(url)
            : HttpClientRequest.get(url);
      const authenticated = base.pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${identity.token}`),
      );
      const response = yield* client
        .execute(
          body === undefined
            ? authenticated
            : authenticated.pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        )
        .pipe(
          Effect.timeout("20 seconds"),
          Effect.mapError(
            (cause) =>
              new MemoryError({
                code: "unavailable",
                detail:
                  "Peer Memory is unavailable. The operation stays local until the hub accepts it.",
                cause,
              }),
          ),
        );
      const json = yield* response.json.pipe(
        Effect.mapError(
          (cause) =>
            new MemoryError({
              code: "unavailable",
              detail: "Peer Memory returned an unreadable response.",
              cause,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const error = decodeError(json);
        const code =
          response.status === 401 || response.status === 403 || response.status === 404
            ? "not_found"
            : response.status === 409
              ? "conflict"
              : response.status >= 500
                ? "unavailable"
                : "invalid";
        return yield* new MemoryError({
          code,
          detail:
            code === "not_found"
              ? "This memory scope is unavailable to the signed-in person."
              : Option.isSome(error)
                ? error.value.error.message
                : `Peer Memory refused the operation (HTTP ${response.status}).`,
        });
      }
      return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError(
          (cause) =>
            new MemoryError({
              code: "invalid",
              detail: "Peer Memory returned an incompatible response.",
              cause,
            }),
        ),
      );
    });
  const authorize = Effect.fn("MemoryTransport.authorize")(function* (
    identity: MemoryIdentity,
    scope: PeerMemoryScope,
  ) {
    // The manifest is read from today's hub ACL, including for historical queries and cache hits.
    const manifest = yield* request(
      identity,
      scope,
      "GET",
      `/v1/workspaces/${encodeURIComponent(scope.workspace)}/manifest`,
      PeerManifest,
    );
    if (
      manifest.workspace.slug !== scope.workspace ||
      manifest.member.email !== identity.email ||
      (scope.project !== "company" &&
        !manifest.projects.some((project) => project.id === scope.project))
    ) {
      return yield* new MemoryError({
        code: "not_found",
        detail: "This memory scope is unavailable to the signed-in person.",
      });
    }
  });
  return MemoryTransport.of({ identity: auth.identity, authorize, request });
});

export const layer = Layer.effect(MemoryTransport, make);
