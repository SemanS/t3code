import type { EnvironmentId, PeerHubStatus } from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ArrowRightIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import {
  companyDomainOf,
  isValidWorkspaceSlug,
  looksLikeEmail,
  slugFromName,
} from "./workspaceAccess.logic";

/** An environment's link to its Peer Hub: who is signed in, their workspaces, what they may join. */
export function usePeerHubStatus(environmentId: EnvironmentId | null): PeerHubStatus | null {
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.peerHubLive({ environmentId, input: {} }),
  ).data;
}

/** What a failed hub command shows inline; null when it succeeded or was interrupted. */
export function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const cause = squashAtomCommandFailure(result);
  return cause instanceof Error ? cause.message : String(cause);
}

/** Runs one hub command at a time and keeps its failure for display. */
function useHubAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
    setBusy(true);
    setError(null);
    try {
      const message = failureMessage(await action());
      setError(message);
      return message === null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ErrorLine({ id, message }: { readonly id: string; readonly message: string | null }) {
  if (message === null) return null;
  return (
    <Alert id={id} variant="error" className="mt-3">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

/**
 * Email sign-in: the hub mails a 6-digit code to the address, and the code
 * signs this environment in. Nothing else identifies a person to a workspace.
 */
export function WorkspaceSignIn({
  environmentId,
  status,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
}) {
  const startSignIn = useAtomCommand(serverEnvironment.peerHubStartSignIn, {
    reportFailure: false,
  });
  const finishSignIn = useAtomCommand(serverEnvironment.peerHubFinishSignIn, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(serverEnvironment.peerHubSignOut, { reportFailure: false });
  const { busy, error, run } = useHubAction();
  const [email, setEmail] = useState(status.pendingSignIn?.email ?? "");
  const [hubUrl, setHubUrl] = useState(status.hubUrl);
  const [code, setCode] = useState("");
  const pending = status.pendingSignIn;

  if (pending !== null) {
    const submitCode = () => {
      if (busy || code.length !== 6) return;
      void run(() => finishSignIn({ environmentId, input: { code } }));
    };
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitCode();
        }}
      >
        <label htmlFor="peer-sign-in-code" className="block text-sm text-muted-foreground">
          Enter the 6-digit code we emailed to{" "}
          <span className="font-medium text-foreground">{pending.email}</span>.
        </label>
        <div className="mt-2 flex items-center gap-2">
          <Input
            id="peer-sign-in-code"
            className="w-40"
            size="lg"
            nativeInput
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            aria-invalid={error !== null}
            aria-describedby={error ? "peer-sign-in-error" : undefined}
            readOnly={busy}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
          />
          <Button type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </div>
        {pending.echoedCode ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Development hub: the code is {pending.echoedCode}.
          </p>
        ) : null}
        <ErrorLine id="peer-sign-in-error" message={error} />
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setCode("");
              void run(() => startSignIn({ environmentId, input: { email: pending.email } }));
            }}
          >
            Send a new code
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => {
              setCode("");
              void run(() => cancel({ environmentId, input: {} }));
            }}
          >
            Use a different address
          </Button>
        </div>
      </form>
    );
  }

  const submitEmail = () => {
    if (busy || !looksLikeEmail(email)) return;
    const trimmedHub = hubUrl.trim();
    void run(() =>
      startSignIn({
        environmentId,
        input: {
          email: email.trim(),
          ...(trimmedHub === "" || trimmedHub === status.hubUrl ? {} : { hubUrl: trimmedHub }),
        },
      }),
    );
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submitEmail();
      }}
    >
      <label htmlFor="peer-sign-in-email" className="block text-sm text-muted-foreground">
        Your work email
      </label>
      <div className="mt-2 flex items-center gap-2">
        <Input
          id="peer-sign-in-email"
          className="min-w-0 flex-1"
          size="lg"
          nativeInput
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@company.com"
          aria-invalid={error !== null}
          aria-describedby={error ? "peer-sign-in-error" : undefined}
          readOnly={busy}
          value={email}
          onChange={(event) => setEmail(event.currentTarget.value)}
        />
        <Button type="submit" disabled={busy || !looksLikeEmail(email)}>
          {busy ? "Sending…" : "Continue"}
          <ArrowRightIcon className="size-3.5" />
        </Button>
      </div>
      <ErrorLine id="peer-sign-in-error" message={error} />
      <Collapsible className="mt-3">
        <CollapsibleTrigger
          type="button"
          className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className="size-3.5 group-data-panel-open:rotate-90" />
          Hub: {status.hubUrl}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="pt-2">
            <label htmlFor="peer-hub-url" className="block text-xs text-muted-foreground">
              Companies that run their own Peer Hub give you its address.
            </label>
            <Input
              id="peer-hub-url"
              className="mt-1.5"
              size="sm"
              nativeInput
              autoCapitalize="none"
              spellCheck={false}
              readOnly={busy}
              value={hubUrl}
              onChange={(event) => setHubUrl(event.currentTarget.value)}
            />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </form>
  );
}

/**
 * Joining and creating workspaces, the way Slack offers them: those the
 * address qualifies for (its domain, or an invite), and a new one of your own.
 */
export function WorkspacePicker({
  environmentId,
  status,
  onJoined,
}: {
  readonly environmentId: EnvironmentId;
  readonly status: PeerHubStatus;
  readonly onJoined?: (slug: string) => void;
}) {
  const join = useAtomCommand(serverEnvironment.peerHubJoinWorkspace, { reportFailure: false });
  const { busy, error, run } = useHubAction();
  const [joining, setJoining] = useState<string | null>(null);
  const [creating, setCreating] = useState(status.joinable.length === 0);

  return (
    <div>
      {status.joinable.length > 0 ? (
        <ul className="space-y-2">
          {status.joinable.map((workspace) => (
            <li
              key={workspace.slug}
              className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium break-words">{workspace.name}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {workspace.reason === "invite"
                    ? "You were invited."
                    : `Anyone with an ${workspace.allowedDomains.map((d) => `@${d}`).join(" or ")} address can join.`}
                </span>
              </span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setJoining(workspace.slug);
                  void run(() =>
                    join({ environmentId, input: { workspace: workspace.slug } }),
                  ).then((joined) => {
                    setJoining(null);
                    if (joined) onJoined?.(workspace.slug);
                  });
                }}
              >
                {joining === workspace.slug ? "Joining…" : "Join"}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No workspace is open to {status.email ?? "your address"} yet. Ask a colleague for an
          invite, or create your team’s workspace.
        </p>
      )}
      <ErrorLine id="peer-join-error" message={error} />
      <div className="mt-4">
        {creating ? (
          <CreateWorkspaceForm
            environmentId={environmentId}
            email={status.email}
            onCreated={(slug) => onJoined?.(slug)}
          />
        ) : (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <PlusIcon className="size-3.5" />
            Create a workspace
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateWorkspaceForm({
  environmentId,
  email,
  onCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly email: string | null;
  readonly onCreated: (slug: string) => void;
}) {
  const create = useAtomCommand(serverEnvironment.peerHubCreateWorkspace, {
    reportFailure: false,
  });
  const { busy, error, run } = useHubAction();
  const domain = companyDomainOf(email);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [openToDomain, setOpenToDomain] = useState(domain !== null);
  const effectiveSlug = slugEdited ? slug : slugFromName(name);
  const valid = name.trim().length > 0 && isValidWorkspaceSlug(effectiveSlug);

  return (
    <form
      className="rounded-lg border border-border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !valid) return;
        void run(() =>
          create({
            environmentId,
            input: {
              slug: effectiveSlug,
              name: name.trim(),
              allowedDomains: openToDomain && domain !== null ? [domain] : [],
            },
          }),
        ).then((created) => {
          if (created) onCreated(effectiveSlug);
        });
      }}
    >
      <p className="text-sm font-medium">Create a workspace</p>
      <label htmlFor="peer-workspace-name" className="mt-3 block text-xs text-muted-foreground">
        Name
      </label>
      <Input
        id="peer-workspace-name"
        className="mt-1.5"
        nativeInput
        placeholder="Your team or company"
        readOnly={busy}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <label htmlFor="peer-workspace-slug" className="mt-3 block text-xs text-muted-foreground">
        Short name (lowercase, used in links and folders)
      </label>
      <Input
        id="peer-workspace-slug"
        className="mt-1.5"
        size="sm"
        nativeInput
        autoCapitalize="none"
        spellCheck={false}
        aria-invalid={effectiveSlug !== "" && !isValidWorkspaceSlug(effectiveSlug)}
        readOnly={busy}
        value={effectiveSlug}
        onChange={(event) => {
          setSlugEdited(true);
          setSlug(event.currentTarget.value.toLowerCase());
        }}
      />
      {domain !== null ? (
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
          <Checkbox
            checked={openToDomain}
            onCheckedChange={(checked) => setOpenToDomain(checked)}
          />
          Anyone with an @{domain} address can join
        </label>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          People join by invite. Sign in with a company address to let your whole domain in.
        </p>
      )}
      <ErrorLine id="peer-create-error" message={error} />
      <div className="mt-3 flex justify-end">
        <Button type="submit" size="sm" disabled={busy || !valid}>
          {busy ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  );
}

/** The person's workspaces as a compact list (role and project count). */
export function WorkspaceList({ status }: { readonly status: PeerHubStatus }) {
  if (status.workspaces.length === 0) return null;
  return (
    <ul className="space-y-2">
      {status.workspaces.map((workspace) => (
        <li
          key={workspace.slug}
          className="flex items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium break-words">{workspace.name}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {workspace.projects.length === 0
                ? "No projects for you yet."
                : `${workspace.projects.length} project${workspace.projects.length === 1 ? "" : "s"}: ${workspace.projects.map((p) => p.project.name).join(", ")}`}
            </span>
          </span>
          {workspace.role === "member" ? null : <Badge variant="outline">{workspace.role}</Badge>}
        </li>
      ))}
    </ul>
  );
}
