import type {
  EnvironmentId,
  PeerHubStatus,
  PeerPersonalCapacityPolicy,
  PeerProjectState,
  PeerWorkspaceState,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { RefreshCwIcon, UsersIcon } from "lucide-react";
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
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspacePicker,
  WorkspaceSignIn,
  failureMessage,
  usePeerHubStatus,
} from "../workspaces/WorkspaceAccess";
import { GitHubConnect } from "../workspaces/GitHubConnect";
import { useOpenWorkspaceProject } from "../workspaces/useOpenWorkspaceProject";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";

const PERSONAL_POLICY: Record<PeerPersonalCapacityPolicy, string> = {
  any: "Your own subscription or seat works here.",
  commercial:
    "Client work: only Team, Enterprise or API logins (commercial terms) — or the shared capacity.",
  none: "Shared capacity only.",
};

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  const message = failureMessage(result);
  if (message === null) return;
  toastManager.add(stackedThreadToast({ type: "error", title, description: message }));
}

/**
 * The workspaces this environment belongs to, Slack-style: sign in with a
 * work email, join or create workspaces, and work on their projects with
 * their tools, knowledge and shared capacity.
 */
export function WorkspacesSettingsPanel() {
  const { environments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection title="Workspaces" variant="plain">
        {environments.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UsersIcon />
              </EmptyMedia>
              <EmptyTitle>No environments available</EmptyTitle>
              <EmptyDescription>Connect an environment to join a workspace.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="space-y-8">
            {environments.map((environment) => (
              <EnvironmentWorkspaces
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

function EnvironmentWorkspaces({
  environment,
  showEnvironmentHeading,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showEnvironmentHeading: boolean;
}) {
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const status = usePeerHubStatus(connected ? environment.environmentId : null);
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
          title={connected ? "Loading workspaces…" : "This environment is not connected."}
        />
      ) : status.signedIn ? (
        <SignedIn environmentId={environment.environmentId} status={status} />
      ) : (
        <SettingsRow
          title="Sign in"
          description="Sign in with your work email to join your team’s workspace, or to create one. Workspaces share projects, tools, knowledge and AI capacity."
        >
          <div className="max-w-md pb-3">
            <WorkspaceSignIn environmentId={environment.environmentId} status={status} />
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function SignedIn({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  useRelativeTimeTick(60_000);
  const sync = useAtomCommand(serverEnvironment.peerHubSync, { reportFailure: false });
  const signOut = useAtomCommand(serverEnvironment.peerHubSignOut, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<AtomCommandResult<unknown, unknown>>, title: string) => {
    setBusy(true);
    try {
      reportFailure(title, await action());
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SettingsRow
        title={`Signed in as ${status.email ?? "you"}`}
        description={[
          status.hubUrl,
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
              onClick={() => void run(() => sync({ environmentId, input: {} }), "Could not sync")}
            >
              <RefreshCwIcon className="size-3.5" />
              {status.syncing ? "Syncing…" : "Sync"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(() => signOut({ environmentId, input: {} }), "Could not sign out")
              }
            >
              Sign out
            </Button>
          </div>
        }
      />
      {status.error ? <SettingsRow title="Last sync failed" description={status.error} /> : null}
      <SettingsRow
        title="GitHub"
        description={
          status.github.account !== null
            ? `Workspace repositories on GitHub clone as ${status.github.account}, through GitHub CLI.`
            : "Connect GitHub so workspace repositories on GitHub clone with your account."
        }
      >
        <div className="pb-3">
          <GitHubConnect environmentId={environmentId} github={status.github} />
        </div>
      </SettingsRow>
      <SettingsRow
        title="How capacity works"
        description="Your own subscriptions stay on this machine and only run your own work. A workspace’s shared capacity is its API pool, billed to one project with your allocation."
      />
      {status.workspaces.map((workspace) => (
        <WorkspaceSection
          key={workspace.slug}
          environmentId={environmentId}
          workspace={workspace}
          workspaceRoot={status.workspaceRoot}
        />
      ))}
      <SettingsRow
        title={status.workspaces.length === 0 ? "Join a workspace" : "Join or create a workspace"}
        description={
          status.joinable.length === 0 ? undefined : "Your address qualifies for these workspaces."
        }
      >
        <div className="max-w-xl pb-3">
          <WorkspacePicker environmentId={environmentId} status={status} />
        </div>
      </SettingsRow>
    </>
  );
}

function WorkspaceSection({
  environmentId,
  workspace,
  workspaceRoot,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: PeerWorkspaceState;
  readonly workspaceRoot: string;
}) {
  const leave = useAtomCommand(serverEnvironment.peerHubLeaveWorkspace, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const knowledge = workspace.companyKnowledge;
  const admin = workspace.role !== "member";
  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {workspace.name}
            {workspace.role === "member" ? null : (
              <Badge variant="secondary">{workspace.role}</Badge>
            )}
          </span>
        }
        description={[
          workspace.allowedDomains.length > 0
            ? `Open to ${workspace.allowedDomains.map((d) => `@${d}`).join(", ")}`
            : "Invite only",
          workspace.revision ? `configuration ${workspace.revision}` : null,
          `projects under ${workspaceRoot}/${workspace.slug}`,
        ]
          .filter(Boolean)
          .join(" · ")}
        control={
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void leave({ environmentId, input: { workspace: workspace.slug } })
                .then((result) => reportFailure(`Could not leave ${workspace.name}`, result))
                .finally(() => setBusy(false));
            }}
          >
            Leave
          </Button>
        }
      />
      {workspace.error ? (
        <SettingsRow title="Could not refresh" description={workspace.error} />
      ) : null}
      {admin ? <InviteRow environmentId={environmentId} workspace={workspace} /> : null}
      {knowledge === null ? null : (
        <SettingsRow
          title={<span className="pl-4 text-muted-foreground">Shared knowledge</span>}
          description={`${knowledge.repository} → ${knowledge.path}${knowledge.error ? ` (${knowledge.error})` : ""}`}
          status={<CheckoutBadge state={knowledge.state} />}
        />
      )}
      {workspace.projects.length === 0 ? (
        <SettingsRow
          title={<span className="pl-4 text-muted-foreground">No projects</span>}
          description={
            admin
              ? "Declare projects in the workspace configuration and apply it with `peerhub workspace apply`."
              : "The workspace lists no projects for you yet. Ask a lead to add you to one."
          }
        />
      ) : (
        workspace.projects.map((project) => (
          <WorkspaceProject
            key={project.project.id}
            environmentId={environmentId}
            workspace={workspace}
            state={project}
          />
        ))
      )}
    </>
  );
}

function InviteRow({
  environmentId,
  workspace,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: PeerWorkspaceState;
}) {
  const invite = useAtomCommand(serverEnvironment.peerHubInvite, { reportFailure: false });
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <SettingsRow
      title={<span className="pl-4 text-muted-foreground">Invite</span>}
      description="People outside the workspace's domains join by invite: they sign in with that address and see the workspace."
      control={
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || email.trim() === "") return;
            setBusy(true);
            void invite({
              environmentId,
              input: { workspace: workspace.slug, email: email.trim() },
            })
              .then((result) => {
                reportFailure(`Could not invite ${email.trim()}`, result);
                if (result._tag === "Success") {
                  toastManager.add({ type: "success", title: `Invited ${email.trim()}` });
                  setEmail("");
                }
              })
              .finally(() => setBusy(false));
          }}
        >
          <Input
            size="sm"
            className="w-56"
            type="email"
            placeholder="colleague@example.com"
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
            aria-label={`Invite to ${workspace.name}`}
          />
          <Button size="sm" variant="outline" type="submit" disabled={busy || email.trim() === ""}>
            Invite
          </Button>
        </form>
      }
    />
  );
}

function CheckoutBadge({
  state,
}: {
  readonly state: PeerProjectState["repositories"][number]["state"];
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

function WorkspaceProject({
  environmentId,
  workspace,
  state,
}: {
  readonly environmentId: EnvironmentId;
  readonly workspace: PeerWorkspaceState;
  readonly state: PeerProjectState;
}) {
  const { project } = state;
  const currency = workspace.currency;
  const opener = useOpenWorkspaceProject({
    environmentId,
    workspace: workspace.slug,
    projectId: project.id,
    name: project.name,
  });
  const setShared = useAtomCommand(serverEnvironment.peerHubSetSharedCapacity, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const usage = useEnvironmentQuery(
    showUsage
      ? serverEnvironment.peerHubProjectUsage({
          environmentId,
          input: { workspace: workspace.slug, projectId: project.id },
        })
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
  const input = { workspace: workspace.slug, projectId: project.id };

  const toggleShared = async (enabled: boolean) => {
    setBusy(true);
    try {
      reportFailure(
        `Could not change ${project.name}'s shared capacity`,
        await setShared({ environmentId, input: { ...input, enabled } }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2 pl-4">
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
            <Button
              size="sm"
              disabled={busy || cloning || opener.opening}
              onClick={() => void opener.open()}
            >
              {cloning || opener.opening
                ? missingRepos.length > 0
                  ? "Cloning…"
                  : "Opening…"
                : missingRepos.length > 0
                  ? "Clone & open"
                  : "Open"}
            </Button>
          ) : (
            <Badge variant="success">in sidebar</Badge>
          )
        }
      />
      {state.repositories.map((repo) => (
        <SettingsRow
          key={repo.id}
          title={<span className="pl-8 text-muted-foreground">{repo.id}</span>}
          description={
            repo.error
              ? `${repo.url} — ${repo.error}`
              : `${repo.url} (${repo.branch}) → ${repo.path}`
          }
          status={<CheckoutBadge state={repo.state} />}
        />
      ))}
      <SettingsRow
        title={<span className="pl-8 text-muted-foreground">Tools</span>}
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
        title={<span className="pl-8 text-muted-foreground">Capacity</span>}
        description={
          shared === undefined
            ? PERSONAL_POLICY[project.capacity.personal]
            : `${PERSONAL_POLICY[project.capacity.personal]} Shared capacity: ${shared.budget.amount} ${currency}/${shared.budget.period}${shared.allocation === undefined ? "" : `, your share ${shared.allocation} ${currency}`}.${state.sharedCapacity.error ? ` ${state.sharedCapacity.error}` : ""}`
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
                aria-label={`Use ${project.name}'s shared capacity on this machine`}
                onCheckedChange={(checked) => void toggleShared(checked)}
              />
            </div>
          )
        }
      />
      {showUsage && shared !== undefined ? (
        <SettingsRow
          title={
            <span className="pl-12 text-muted-foreground">Spent this {shared.budget.period}</span>
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
          title={<span className="pl-8 text-muted-foreground">Working now</span>}
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
