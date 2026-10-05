import { type PeerProject, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, assert, describe, it } from "@effect/vitest";

import {
  bindThreadProject,
  capacityRejection,
  claudeHubMcpServers,
  codexHubMcpServers,
  hubInstructionsForThread,
  projectAcceptsPersonal,
  resolveToolValue,
  setHubPolicyState,
  type HubPolicyState,
} from "./hubPolicy.ts";

const ACME = { slug: "acme", name: "Acme" };

function project(
  overrides: Partial<PeerProject["capacity"]> & { readonly id?: string } = {},
): PeerProject {
  const { id = "kirkwood", ...capacity } = overrides;
  return {
    id,
    name: id === "kirkwood" ? "Kirkwood" : "PitchPlace",
    role: "member",
    members: [{ email: "ana@acme.test", name: "Ana" }],
    repositories: [{ id: "app", url: "git@example.test:app.git", branch: "main" }],
    knowledge: { kontext: true, company: true },
    tools: [
      {
        id: "kontext",
        name: "kontext",
        mcp: { transport: "stdio", command: "kontext", args: ["mcp"], env: {} },
        requires: [],
      },
      {
        id: "company-knowledge",
        name: "Acme knowledge",
        mcp: {
          transport: "stdio",
          command: "kontext",
          args: ["mcp"],
          env: { KONTEXT_DIR: "${company.knowledge}" },
        },
        requires: [],
      },
      {
        id: "atlassian",
        name: "Atlassian",
        mcp: { transport: "sse", url: "https://mcp.example.test/sse", headers: {} },
        requires: [],
      },
      {
        id: "tracker",
        name: "Tracker",
        mcp: {
          transport: "http",
          url: "https://tracker.example.test/mcp",
          headers: { Authorization: "Bearer ${secret:TRACKER_TOKEN}" },
        },
        requires: [],
      },
    ],
    capacity: { personal: "any", personalHarnesses: ["claude"], ...capacity },
  };
}

function state(
  projects: ReadonlyArray<readonly [string, PeerProject]>,
  options: {
    readonly shared?: ReadonlyArray<readonly [string, string]>;
    readonly knowledge?: string | null;
  } = {},
): HubPolicyState {
  const bound = new Map(
    projects.map(([projectId, p]) => [
      projectId,
      { workspace: ACME, project: p, repositoryPath: `/work/acme/${p.id}/app` },
    ]),
  );
  const knowledge = options.knowledge === undefined ? "/hub/acme/knowledge" : options.knowledge;
  return {
    projects: bound,
    roots: new Map([...bound.values()].map((entry) => [entry.repositoryPath, entry])),
    sharedInstances: new Map(
      (options.shared ?? []).map(([instanceId, projectId]) => [
        instanceId,
        { workspace: ACME, projectId },
      ]),
    ),
    knowledgePaths: new Map(knowledge === null ? [] : [["acme", knowledge]]),
  };
}

afterEach(() => setHubPolicyState(null));

describe("projectAcceptsPersonal", () => {
  it("accepts the member's own login only where the project does", () => {
    const hub = state([
      ["t3-kw", project()],
      ["t3-cm", project({ id: "commercial", personal: "commercial" })],
      ["t3-none", project({ id: "closed", personal: "none" })],
    ]);
    assert.isTrue(projectAcceptsPersonal(hub, "acme", "kirkwood"));
    assert.isFalse(projectAcceptsPersonal(hub, "acme", "commercial"));
    assert.isFalse(projectAcceptsPersonal(hub, "acme", "closed"));
  });

  it("does not, for a project it does not know or before the workspace is provisioned", () => {
    assert.isFalse(projectAcceptsPersonal(null, "acme", "kirkwood"));
    const hub = state([["t3-kw", project()]]);
    assert.isFalse(projectAcceptsPersonal(hub, "acme", "elsewhere"));
    assert.isFalse(projectAcceptsPersonal(hub, "other", "kirkwood"));
  });
});

describe("capacityRejection", () => {
  it("lets anything run outside workspace projects and before sign-in", () => {
    assert.isUndefined(
      capacityRejection(null, { projectId: "p", instanceId: "claudeAgent", driver: "claudeAgent" }),
    );
    const hub = state([["t3-kw", project()]]);
    assert.isUndefined(
      capacityRejection(hub, {
        projectId: "other",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
      }),
    );
  });

  it("keeps shared capacity on the project it is billed to", () => {
    const hub = state(
      [
        ["t3-kw", project()],
        ["t3-pp", project({ id: "pitchplace" })],
      ],
      { shared: [["peer-acme-kirkwood-claude", "kirkwood"]] },
    );
    const shared = { instanceId: "peer-acme-kirkwood-claude", driver: "claudeAgent" };
    assert.isUndefined(capacityRejection(hub, { projectId: "t3-kw", ...shared }));
    assert.match(
      capacityRejection(hub, { projectId: "t3-pp", ...shared }) ?? "",
      /billed to "kirkwood", not "PitchPlace"/,
    );
    assert.match(
      capacityRejection(hub, { projectId: "unrelated", ...shared }) ?? "",
      /only runs that project's threads/,
    );
  });

  it("tells apart same-named projects of different workspaces", () => {
    const hub: HubPolicyState = {
      ...state([["t3-kw", project()]]),
      sharedInstances: new Map([
        [
          "peer-globex-kirkwood-claude",
          { workspace: { slug: "globex", name: "Globex" }, projectId: "kirkwood" },
        ],
      ]),
    };
    assert.match(
      capacityRejection(hub, {
        projectId: "t3-kw",
        instanceId: "peer-globex-kirkwood-claude",
        driver: "claudeAgent",
      }) ?? "",
      /Globex capacity billed to "kirkwood"/,
    );
  });

  it("matches a hand-added project by its checkout path", () => {
    const hub = state([["t3-kw", project({ personal: "none" })]]);
    const rejection = capacityRejection(hub, {
      projectId: "added-by-hand",
      workspaceRoot: "/work/acme/kirkwood/app",
      instanceId: "claudeAgent",
      driver: "claudeAgent",
    });
    assert.match(rejection ?? "", /shared capacity only/);
  });

  it("refuses personal logins in a shared-capacity-only project", () => {
    const hub = state([["t3-kw", project({ personal: "none" })]]);
    assert.match(
      capacityRejection(hub, {
        projectId: "t3-kw",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
      }) ?? "",
      /Kirkwood runs on Acme's shared capacity only/,
    );
  });

  it("accepts only commercial logins in a commercial project", () => {
    const hub = state([["t3-kw", project({ personal: "commercial", personalHarnesses: [] })]]);
    const base = { projectId: "t3-kw", instanceId: "claudeAgent", driver: "claudeAgent" };
    assert.match(
      capacityRejection(hub, {
        ...base,
        auth: { type: "max", label: "Claude Max Subscription" },
      }) ?? "",
      /Claude Max Subscription is a personal plan/,
    );
    assert.isUndefined(
      capacityRejection(hub, {
        ...base,
        auth: { type: "team", label: "Claude Team Subscription" },
      }),
    );
    assert.isUndefined(
      capacityRejection(hub, { ...base, auth: { type: "apiKey", label: "Claude API Key" } }),
    );
    assert.isUndefined(
      capacityRejection(hub, {
        ...base,
        instanceId: "codex",
        driver: "codex",
        auth: { type: "chatgpt", label: "ChatGPT Business" },
      }),
    );
  });

  it("falls back to the member's declared seats when the login is unknown", () => {
    const declared = state([
      ["t3-kw", project({ personal: "commercial", personalHarnesses: ["claude"] })],
    ]);
    assert.isUndefined(
      capacityRejection(declared, {
        projectId: "t3-kw",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
      }),
    );
    assert.isDefined(
      capacityRejection(declared, { projectId: "t3-kw", instanceId: "codex", driver: "codex" }),
    );
  });
});

describe("agent tools", () => {
  it("resolves project, knowledge and secret placeholders", () => {
    const context = {
      projectRoot: "/work/kw",
      companyKnowledge: "/hub/acme/knowledge",
      env: { TOKEN: "s3cret" },
    };
    assert.equal(resolveToolValue("${project.root}/x", context), "/work/kw/x");
    assert.equal(resolveToolValue("${company.knowledge}", context), "/hub/acme/knowledge");
    assert.equal(resolveToolValue("Bearer ${secret:TOKEN}", context), "Bearer s3cret");
    assert.equal(resolveToolValue("${secret:MISSING}", context), "");
    assert.equal(resolveToolValue("${unknown}", context), "${unknown}");
  });

  it("gives a bound thread its project's tools in each harness's format", () => {
    const threadId = ThreadId.make("thread-1");
    setHubPolicyState(state([["t3-kw", project()]]));
    bindThreadProject(threadId, ProjectId.make("t3-kw"));
    process.env.TRACKER_TOKEN = "t0ken";
    try {
      const claude = claudeHubMcpServers(threadId);
      assert.deepEqual(Object.keys(claude), [
        "kontext",
        "company-knowledge",
        "atlassian",
        "tracker",
      ]);
      assert.deepEqual(claude["company-knowledge"], {
        type: "stdio",
        command: "kontext",
        args: ["mcp"],
        env: { KONTEXT_DIR: "/hub/acme/knowledge" },
      });
      assert.deepEqual(claude.tracker, {
        type: "http",
        url: "https://tracker.example.test/mcp",
        headers: { Authorization: "Bearer t0ken" },
      });
      // Codex has no SSE transport.
      assert.deepEqual(Object.keys(codexHubMcpServers(threadId)), [
        "kontext",
        "company-knowledge",
        "tracker",
      ]);
      assert.match(hubInstructionsForThread(threadId), /Acme project "Kirkwood"[\s\S]*ctx_brief/);
    } finally {
      delete process.env.TRACKER_TOKEN;
    }
  });

  it("leaves out company knowledge until its checkout exists", () => {
    const threadId = ThreadId.make("thread-2");
    setHubPolicyState(state([["t3-kw", project()]], { knowledge: null }));
    bindThreadProject(threadId, ProjectId.make("t3-kw"));
    assert.notInclude(Object.keys(claudeHubMcpServers(threadId)), "company-knowledge");
  });

  it("gives threads outside workspace projects nothing", () => {
    const threadId = ThreadId.make("thread-3");
    setHubPolicyState(state([["t3-kw", project()]]));
    bindThreadProject(threadId, ProjectId.make("somewhere-else"));
    assert.deepEqual(claudeHubMcpServers(threadId), {});
    assert.equal(hubInstructionsForThread(threadId), "");
  });
});
