import type { EnvironmentId, PeerGitHubState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { failureMessage } from "./WorkspaceAccess";

function openGitHub(url: string) {
  void ensureLocalApi()
    .shell.openExternal(url)
    .catch(() => undefined);
}

/**
 * Connects GitHub from the app: Peer has GitHub CLI sign in, shows the
 * one-time code and opens GitHub's page to enter it. Workspace repositories
 * on github.com then clone with that account. `onConnected` runs once a
 * sign-in started here has finished with an account.
 */
export function GitHubConnect({
  environmentId,
  github,
  onConnected,
}: {
  readonly environmentId: EnvironmentId;
  readonly github: PeerGitHubState;
  readonly onConnected?: () => void;
}) {
  const connect = useAtomCommand(serverEnvironment.peerHubConnectGitHub, {
    reportFailure: false,
  });
  const cancel = useAtomCommand(serverEnvironment.peerHubCancelGitHubSignIn, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  // A sign-in this control started and has not seen finish.
  const started = useRef(false);

  useEffect(() => {
    if (!started.current || github.signIn !== null) return;
    started.current = false;
    if (github.error === null && github.account !== null) onConnected?.();
  }, [github.account, github.error, github.signIn, onConnected]);

  const start = async () => {
    setBusy(true);
    try {
      const result = await connect({ environmentId, input: {} });
      const failure = failureMessage(result);
      if (failure !== null) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not connect GitHub",
            description: failure,
          }),
        );
        return;
      }
      if (result._tag !== "Success" || result.value.github.signIn === null) return;
      started.current = true;
      openGitHub(result.value.github.signIn.verificationUri);
    } finally {
      setBusy(false);
    }
  };

  if (github.signIn !== null) {
    const { userCode, verificationUri } = github.signIn;
    return (
      <div className="flex flex-col gap-1.5 rounded-md border border-border p-2 text-xs text-muted-foreground">
        <span>Enter this code on GitHub to connect it:</span>
        <span className="font-mono text-base font-semibold tracking-widest text-foreground select-all">
          {userCode}
        </span>
        <div className="flex flex-wrap gap-1">
          <Button size="xs" onClick={() => openGitHub(verificationUri)}>
            Open GitHub
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void navigator.clipboard?.writeText(userCode).catch(() => undefined)}
          >
            Copy code
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              started.current = false;
              void cancel({ environmentId, input: {} });
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (!github.cli) {
    return (
      <span className="text-xs text-muted-foreground">
        To connect GitHub here, install GitHub CLI first: brew install gh
      </span>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      <Button size="xs" variant="outline" disabled={busy} onClick={() => void start()}>
        {busy
          ? "Connecting…"
          : github.account === null
            ? "Connect GitHub"
            : "Connect another account"}
      </Button>
      {github.error !== null ? (
        <span className="text-xs text-destructive">Signing in failed: {github.error}</span>
      ) : null}
    </div>
  );
}
