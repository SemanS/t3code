/**
 * hubPolicy — what the Hotovo Hub decides for one thread: which agent tools
 * it gets and which provider instances may run it.
 *
 * The HotovoHub service publishes the provisioned state here; adapters and
 * the runtime policy read it synchronously, the way they read
 * `McpProviderSession`. Everything below is pure apart from that one slot,
 * so the rules are testable without a server.
 *
 * Capacity rules (see the hub's docs/architecture.md):
 * - Personal capacity (any instance the hub did not provision: the owner's
 *   own Claude/Codex login) runs only in its owner's environment, and only in
 *   projects whose policy accepts it. "commercial" accepts seats under
 *   commercial terms (Team, Enterprise, API keys); "none" accepts none.
 * - Shared capacity (an instance the hub provisioned with a gateway key) is
 *   billed to one project, so it runs that project's threads and nothing else.
 *
 * @module hotovo/hubPolicy
 */
import type {
  HotovoHarness,
  HotovoHubMcpServer,
  HotovoHubProject,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface HubBoundProject {
  readonly project: HotovoHubProject;
  /** Local checkout of the repository this T3 project is rooted at. */
  readonly repositoryPath: string;
}

export interface HubPolicyState {
  readonly hubName: string;
  /** T3 project id → the hub project and repository it was provisioned for. */
  readonly projects: ReadonlyMap<string, HubBoundProject>;
  /** Realpath of a checkout → the same, for projects added by hand. */
  readonly roots: ReadonlyMap<string, HubBoundProject>;
  /** Provider instance id → hub project id it is billed to. */
  readonly sharedInstances: ReadonlyMap<string, string>;
  readonly companyKnowledgePath: string | null;
}

let current: HubPolicyState | null = null;
const threadProjects = new Map<ThreadId, ProjectId>();

export function setHubPolicyState(next: HubPolicyState | null): void {
  current = next;
}

export function readHubPolicyState(): HubPolicyState | null {
  return current;
}

/** Remembered when a provider session opens, so adapters can resolve a thread's project. */
export function bindThreadProject(threadId: ThreadId, projectId: ProjectId): void {
  threadProjects.set(threadId, projectId);
}

function hubProjectFor(
  state: HubPolicyState,
  input: { readonly projectId: string; readonly workspaceRoot?: string | null | undefined },
): HubBoundProject | undefined {
  return (
    state.projects.get(input.projectId) ??
    (input.workspaceRoot ? state.roots.get(input.workspaceRoot) : undefined)
  );
}

const HARNESS_BY_DRIVER: Readonly<Record<string, HotovoHarness>> = {
  claudeAgent: "claude",
  codex: "codex",
  cursor: "cursor",
  grok: "grok",
  opencode: "opencode",
  antigravity: "antigravity",
};

export function harnessForDriver(driver: string): HotovoHarness | undefined {
  return HARNESS_BY_DRIVER[driver];
}

/**
 * Auth types providers report for logins under commercial terms. Claude
 * reports its raw subscription type ("team", "enterprise") or "apiKey";
 * Codex reports "apiKey" or "chatgpt" with the plan in the label.
 */
const COMMERCIAL_AUTH_TYPES = new Set([
  "apikey",
  "team",
  "enterprise",
  "business",
  "bedrock",
  "amazonbedrock",
  "vertex",
]);

function isCommercialAuth(auth: {
  readonly type?: string | undefined;
  readonly label?: string | undefined;
}): boolean {
  if (auth.type !== undefined && COMMERCIAL_AUTH_TYPES.has(auth.type.toLowerCase())) return true;
  return auth.label !== undefined && /\b(team|enterprise|business|edu)\b/i.test(auth.label);
}

export interface CapacityCheckInput {
  readonly projectId: string;
  readonly workspaceRoot?: string | null | undefined;
  readonly instanceId: string;
  readonly driver: string;
  /** The instance's reported login, when known. */
  readonly auth?:
    | { readonly type?: string | undefined; readonly label?: string | undefined }
    | undefined;
}

/** Undefined when the instance may run this project's thread, else why not. */
export function capacityRejection(
  state: HubPolicyState | null,
  input: CapacityCheckInput,
): string | undefined {
  if (state === null) return undefined;
  const bound = hubProjectFor(state, input);
  const sharedFor = state.sharedInstances.get(input.instanceId);

  if (sharedFor !== undefined) {
    if (bound === undefined) {
      return `This provider is ${state.hubName} company capacity billed to project "${sharedFor}". It only runs that project's threads.`;
    }
    if (bound.project.id !== sharedFor) {
      return `This provider is company capacity billed to "${sharedFor}", not "${bound.project.name}". Pick ${bound.project.name}'s company capacity or your own subscription.`;
    }
    return undefined;
  }

  if (bound === undefined) return undefined;
  const { project } = bound;
  const harness = harnessForDriver(input.driver);
  switch (project.capacity.personal) {
    case "any":
      return undefined;
    case "none":
      return `${project.name} runs on company capacity only. Turn on its company capacity in Settings → Hotovo Hub and pick that provider.`;
    case "commercial": {
      const commercial =
        input.auth !== undefined &&
        (input.auth.type !== undefined || input.auth.label !== undefined)
          ? isCommercialAuth(input.auth)
          : harness !== undefined && project.capacity.personalHarnesses.includes(harness);
      if (commercial) return undefined;
      const login = input.auth?.label ?? "this login";
      return `${project.name} is client work under commercial terms: use a Team, Enterprise or API login, or the project's company capacity. ${login} is a personal plan.`;
    }
  }
}

/** Resolves ${project.root}, ${company.knowledge} and ${secret:NAME} in a tool value. */
export function resolveToolValue(
  value: string,
  context: {
    readonly projectRoot: string;
    readonly companyKnowledge: string | null;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    if (key === "project.root") return context.projectRoot;
    if (key === "company.knowledge") return context.companyKnowledge ?? match;
    if (key.startsWith("secret:")) return context.env[key.slice("secret:".length)] ?? "";
    return match;
  });
}

function resolvedToolServers(
  state: HubPolicyState,
  bound: HubBoundProject,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, HotovoHubMcpServer> {
  const context = {
    projectRoot: bound.repositoryPath,
    companyKnowledge: state.companyKnowledgePath,
    env,
  };
  const servers: Record<string, HotovoHubMcpServer> = {};
  for (const tool of bound.project.tools) {
    const mcp = tool.mcp;
    if (mcp.transport === "stdio") {
      // Company knowledge needs its checkout; without it the server would answer from the wrong repo.
      const env = Object.fromEntries(
        Object.entries(mcp.env).map(([name, value]) => [name, resolveToolValue(value, context)]),
      );
      if (Object.values(env).some((value) => value.includes("${company.knowledge}"))) continue;
      servers[tool.id] = {
        transport: "stdio",
        command: resolveToolValue(mcp.command, context),
        args: mcp.args.map((arg) => resolveToolValue(arg, context)),
        env,
      };
    } else {
      servers[tool.id] = {
        transport: mcp.transport,
        url: resolveToolValue(mcp.url, context),
        headers: Object.fromEntries(
          Object.entries(mcp.headers).map(([name, value]) => [
            name,
            resolveToolValue(value, context),
          ]),
        ),
      };
    }
  }
  return servers;
}

function boundProjectForThread(
  threadId: ThreadId,
): { state: HubPolicyState; bound: HubBoundProject } | undefined {
  const state = current;
  const projectId = threadProjects.get(threadId);
  if (state === null || projectId === undefined) return undefined;
  const bound = hubProjectFor(state, { projectId });
  return bound === undefined ? undefined : { state, bound };
}

type ClaudeMcpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

/** The hub project's tools as Claude Agent SDK `mcpServers` entries. */
export function claudeHubMcpServers(threadId: ThreadId): Record<string, ClaudeMcpServer> {
  const found = boundProjectForThread(threadId);
  if (found === undefined) return {};
  const servers: Record<string, ClaudeMcpServer> = {};
  for (const [id, server] of Object.entries(resolvedToolServers(found.state, found.bound))) {
    servers[id] =
      server.transport === "stdio"
        ? { type: "stdio", command: server.command, args: [...server.args], env: { ...server.env } }
        : { type: server.transport, url: server.url, headers: { ...server.headers } };
  }
  return servers;
}

/**
 * The hub project's tools as Codex `mcp_servers` entries. Codex speaks stdio
 * and streamable HTTP; SSE-only servers are left out.
 */
export function codexHubMcpServers(threadId: ThreadId): Record<string, Record<string, unknown>> {
  const found = boundProjectForThread(threadId);
  if (found === undefined) return {};
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [id, server] of Object.entries(resolvedToolServers(found.state, found.bound))) {
    if (server.transport === "stdio") {
      servers[id] = { command: server.command, args: [...server.args], env: { ...server.env } };
    } else if (server.transport === "http") {
      servers[id] = { url: server.url, http_headers: { ...server.headers } };
    }
  }
  return servers;
}

/** A short system-prompt addition naming the project and its knowledge tools. */
export function hubInstructionsForThread(threadId: ThreadId): string {
  const found = boundProjectForThread(threadId);
  if (found === undefined) return "";
  const { project } = found.bound;
  const tools = new Set(project.tools.map((tool) => tool.id));
  const lines = [
    "",
    `## ${found.state.hubName} project: ${project.name}`,
    `This workspace belongs to the ${found.state.hubName} hub project "${project.name}".`,
  ];
  if (tools.has("kontext")) {
    lines.push(
      "Before changing code, call the kontext MCP tool ctx_brief with the paths you will touch; it returns the decisions and conventions the team approved for them.",
    );
  }
  if (tools.has("company-knowledge")) {
    lines.push(
      "Company-wide conventions are on the company-knowledge MCP server (the same kontext tools, answering from the company store).",
    );
  }
  return `${lines.join("\n")}\n`;
}
