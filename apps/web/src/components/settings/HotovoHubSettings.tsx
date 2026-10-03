import type {
  EnvironmentId,
  HotovoHubProjectState,
  HotovoHubStatus,
  HotovoPersonalCapacityPolicy,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Building2Icon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTime } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const DEFAULT_HUB_URL = "http://127.0.0.1:8787";

const PERSONAL_POLICY: Record<HotovoPersonalCapacityPolicy, string> = {
  any: "Your own subscription or seat works here.",
  commercial:
    "Client work: only Team, Enterprise or API logins (commercial terms) — or company capacity.",
  none: "Company capacity only.",
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );
}

/**
 * The company hub this environment provisions from: sign-in, the member's
 * projects with their repositories, tools and capacity, and who else is
 * working on them.
 */
export function HotovoHubSettingsPanel() {
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Hotovo Hub" variant="plain">
        {environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Building2Icon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to sign in to the hub.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((environment) => (
              <HubEnvironmentSection
                key={environment.environmentId}
                environment={environment}
                showEnvironmentHeading={environments.length > 1}
              />
            ))}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function HubEnvironmentSection({
  environment,
  showEnvironmentHeading,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const status = useEnvironmentQuery(
    connected
      ? serverEnvironment.hotovoHubLive({ environmentId: environment.environmentId, input: {} })
      : null,
  ).data;
  return (
    <SettingsSection
      title={environment.label}
      hideTitle={!showEnvironmentHeading}
      icon={
        <EnvironmentMachineIcon
          kind={resolveEnvironmentMachineKind(environment.serverConfig)}
          className="size-3.5"
        />
      }
    >
      {!connected || status === null ? (
        <SettingsRow
          title={connected ? "Loading hub status…" : "This environment is not connected."}
        />
      ) : status.signedIn ? (
        <SignedInHub environmentId={environment.environmentId} status={status} />
      ) : (
        <HubSignIn environmentId={environment.environmentId} status={status} />
      )}
    </SettingsSection>
  );
}

function HubSignIn({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: HotovoHubStatus;
}) {
  const signIn = useAtomCommand(serverEnvironment.hotovoHubSignIn, { label: "sign in to the hub" });
  const [hubUrl, setHubUrl] = useState(status.hubUrl ?? DEFAULT_HUB_URL);
  const [kind, setKind] = useState<"github" | "bitbucket">("github");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (method: "github-cli" | "token") => {
    setBusy(true);
    try {
      const result = await signIn({
        environmentId,
        input: {
          hubUrl: hubUrl.trim(),
          method,
          kind,
          ...(method === "token" ? { token: token.trim() } : {}),
        },
      });
      if (result._tag === "Failure") reportFailure("Could not sign in to the hub", result);
      else setToken("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        title="Hub address"
        description="Where your company's hub runs. Your account decides which projects you get."
        control={
          <Input
            size="sm"
            className="w-64"
            value={hubUrl}
            disabled={busy}
            onChange={(event) => setHubUrl(event.target.value)}
            aria-label="Hub address"
          />
        }
      />
      <SettingsRow
        title="Sign in with the GitHub CLI"
        description="Uses this machine's `gh auth login`. The hub checks who you are and forgets the token."
        control={
          <Button
            size="sm"
            disabled={busy || hubUrl.trim() === ""}
            onClick={() => void submit("github-cli")}
          >
            Sign in
          </Button>
        }
      />
      <SettingsRow
        title="Sign in with a token"
        description="A GitHub token, or a Bitbucket OAuth token for Hotovo's Bitbucket workspace."
        control={
          <div className="flex items-center gap-2">
            <ToggleGroup
              aria-label="Account"
              variant="segmented"
              value={[kind]}
              onValueChange={(next) => {
                const value = next[0];
                if (value === "github" || value === "bitbucket") setKind(value);
              }}
            >
              <Toggle value="github">GitHub</Toggle>
              <Toggle value="bitbucket">Bitbucket</Toggle>
            </ToggleGroup>
            <Input
              size="sm"
              type="password"
              autoComplete="off"
              className="w-48"
              placeholder="Token"
              value={token}
              disabled={busy}
              onChange={(event) => setToken(event.target.value)}
              aria-label="Token"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || token.trim() === "" || hubUrl.trim() === ""}
              onClick={() => void submit("token")}
            >
              Sign in
            </Button>
          </div>
        }
      />
      {status.error ? <SettingsRow title="Last error" description={status.error} /> : null}
    </>
  );
}

function SignedInHub({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: HotovoHubStatus;
}) {
  useRelativeTimeTick(60_000);
  const sync = useAtomCommand(serverEnvironment.hotovoHubSync, { label: "sync with the hub" });
  const signOut = useAtomCommand(serverEnvironment.hotovoHubSignOut, {
    label: "sign out of the hub",
  });
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<AtomCommandResult<unknown, unknown>>, title: string) => {
    setBusy(true);
    try {
      reportFailure(title, await action());
    } finally {
      setBusy(false);
    }
  };
  const knowledge = status.companyKnowledge;
  return (
    <>
      <SettingsRow
        title={`Signed in as ${status.member?.name ?? "a hub member"}`}
        description={[
          status.account,
          status.hub?.displayName,
          status.hub?.revision ? `registry ${status.hub.revision}` : null,
          status.lastSyncAt ? `synced ${formatRelativeTime(status.lastSyncAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        control={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || status.syncing}
              onClick={() =>
                void run(() => sync({ environmentId, input: {} }), "Could not sync with the hub")
              }
            >
              <RefreshCwIcon className="size-3.5" />
              {status.syncing ? "Syncing…" : "Sync"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(
                  () => signOut({ environmentId, input: {} }),
                  "Could not sign out of the hub",
                )
              }
            >
              Sign out
            </Button>
          </div>
        }
      />
      {status.error ? <SettingsRow title="Last sync failed" description={status.error} /> : null}
      <SettingsRow
        title="How capacity works"
        description="Your own subscriptions stay on this machine and only run your own work. Company capacity is the company's API pool, billed to one project with your allocation."
      />
      <SettingsRow
        title="Company knowledge"
        description={
          knowledge === null
            ? "This hub shares no company knowledge."
            : `${knowledge.repository} → ${knowledge.path}${knowledge.error ? ` (${knowledge.error})` : ""}`
        }
        status={knowledge === null ? null : <CheckoutBadge state={knowledge.state} />}
      />
      <SettingsRow
        title="Workspace"
        description={`Hub projects are checked out under ${status.workspaceRoot}`}
      />
      {status.projects.length === 0 ? (
        <SettingsRow
          title="No projects"
          description="The hub lists no projects for you yet. Ask a lead to add you to one."
        />
      ) : (
        status.projects.map((project) => (
          <HubProject
            key={project.project.id}
            environmentId={environmentId}
            state={project}
            currency={status.hub?.currency ?? "EUR"}
          />
        ))
      )}
    </>
  );
}

function CheckoutBadge({
  state,
}: {
  readonly state: HotovoHubProjectState["repositories"][number]["state"];
}) {
  const variant =
    state === "ready"
      ? "success"
      : state === "cloning"
        ? "info"
        : state === "error"
          ? "error"
          : "outline";
  return <Badge variant={variant}>{state === "missing" ? "not checked out" : state}</Badge>;
}

function HubProject({
  environmentId,
  state,
  currency,
}: {
  readonly environmentId: EnvironmentId;
  readonly state: HotovoHubProjectState;
  readonly currency: string;
}) {
  const { project } = state;
  const openProject = useAtomCommand(serverEnvironment.hotovoHubOpenProject, {
    label: "open a hub project",
  });
  const setShared = useAtomCommand(serverEnvironment.hotovoHubSetSharedCapacity, {
    label: "change company capacity",
  });
  const [busy, setBusy] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const usage = useEnvironmentQuery(
    showUsage
      ? serverEnvironment.hotovoHubProjectUsage({ environmentId, input: { projectId: project.id } })
      : null,
  );
  const missingRepos = state.repositories.filter(
    (repo) => repo.state === "missing" || repo.state === "error",
  );
  const unregistered = state.repositories.filter(
    (repo) => repo.state === "ready" && repo.projectId === undefined,
  );
  const cloning = state.repositories.some((repo) => repo.state === "cloning");
  const shared = project.capacity.shared;

  const open = async () => {
    setBusy(true);
    try {
      const result = await openProject({ environmentId, input: { projectId: project.id } });
      if (result._tag === "Failure") reportFailure(`Could not open ${project.name}`, result);
    } finally {
      setBusy(false);
    }
  };
  const toggleShared = async (enabled: boolean) => {
    setBusy(true);
    try {
      const result = await setShared({ environmentId, input: { projectId: project.id, enabled } });
      if (result._tag === "Failure")
        reportFailure(`Could not change ${project.name}'s company capacity`, result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {project.name}
            {project.client ? <Badge variant="outline">{project.client}</Badge> : null}
            {project.role === "lead" ? <Badge variant="secondary">lead</Badge> : null}
          </span>
        }
        description={
          project.description ??
          `${project.members.length} member${project.members.length === 1 ? "" : "s"}`
        }
        control={
          project.repositories.length === 0 ? (
            <Badge variant="outline">no repositories yet</Badge>
          ) : missingRepos.length > 0 || unregistered.length > 0 ? (
            <Button size="sm" disabled={busy || cloning} onClick={() => void open()}>
              {cloning ? "Cloning…" : missingRepos.length > 0 ? "Clone & open" : "Open"}
            </Button>
          ) : (
            <Badge variant="success">in sidebar</Badge>
          )
        }
      />
      {state.repositories.map((repo) => (
        <SettingsRow
          key={repo.id}
          title={<span className="pl-4 text-muted-foreground">{repo.id}</span>}
          description={
            repo.error
              ? `${repo.url} — ${repo.error}`
              : `${repo.url} (${repo.branch}) → ${repo.path}`
          }
          status={<CheckoutBadge state={repo.state} />}
        />
      ))}
      <SettingsRow
        title={<span className="pl-4 text-muted-foreground">Tools</span>}
        description={
          state.tools.length === 0
            ? "No shared tools."
            : state.tools
                .map((tool) =>
                  tool.missing.length === 0
                    ? tool.name
                    : `${tool.name} (missing ${tool.missing.map((m) => m.command).join(", ")}${tool.missing[0]?.install ? `: ${tool.missing[0].install}` : ""})`,
                )
                .join(" · ")
        }
      />
      <SettingsRow
        title={<span className="pl-4 text-muted-foreground">Capacity</span>}
        description={
          shared === undefined
            ? PERSONAL_POLICY[project.capacity.personal]
            : `${PERSONAL_POLICY[project.capacity.personal]} Company capacity: ${shared.budget.amount} ${currency}/${shared.budget.period}${shared.allocation === undefined ? "" : `, your share ${shared.allocation} ${currency}`}.${state.sharedCapacity.error ? ` ${state.sharedCapacity.error}` : ""}`
        }
        control={
          shared === undefined ? null : (
            <div className="flex items-center gap-2">
              <Button size="xs" variant="ghost" onClick={() => setShowUsage((value) => !value)}>
                {showUsage ? "Hide usage" : "Usage"}
              </Button>
              <Switch
                checked={state.sharedCapacity.enabled}
                disabled={busy}
                aria-label={`Use ${project.name}'s company capacity on this machine`}
                onCheckedChange={(checked) => void toggleShared(checked)}
              />
            </div>
          )
        }
      />
      {showUsage && shared !== undefined ? (
        <SettingsRow
          title={
            <span className="pl-8 text-muted-foreground">Spent this {shared.budget.period}</span>
          }
          description={
            usage.data === null
              ? (usage.error ?? "Loading…")
              : usage.data.shared === null
                ? "The gateway reports no spend yet."
                : `${usage.data.shared.spent} of ${usage.data.shared.budget} ${usage.data.currency}: ${usage.data.shared.members
                    .map(
                      (m) =>
                        `${m.name} ${m.spent}${m.allocation === null ? "" : `/${m.allocation}`}`,
                    )
                    .join(", ")}`
          }
        />
      ) : null}
      {state.peers.length > 0 ? (
        <SettingsRow
          title={<span className="pl-4 text-muted-foreground">Working now</span>}
          description={state.peers
            .map((peer) =>
              peer.threads.length === 0
                ? `${peer.name} (idle)`
                : `${peer.name}: ${peer.threads
                    .map(
                      (thread) =>
                        `“${thread.title}” ${thread.status}${thread.branch ? ` on ${thread.branch}` : ""}`,
                    )
                    .join("; ")}`,
            )
            .join(" · ")}
        />
      ) : null}
    </>
  );
}
