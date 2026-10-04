/**
 * cloneFailure — why `git clone` of a workspace repository failed, in words a
 * person can act on. git names the cause, often on its first line above
 * generic advice, but rarely the fix; and Peer runs it without a terminal, so
 * git cannot ask for a password either.
 *
 * @module peerHub/cloneFailure
 */

export interface CloneTarget {
  readonly url: string;
  readonly branch: string;
}

/** The host a remote address names, if it names one (local paths do not). */
export function remoteHost(url: string): string | undefined {
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)/.exec(url);
  if (scp !== null) return scp[1];
  try {
    const host = new URL(url).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

export interface GitHubCloneTarget extends CloneTarget {
  /** `owner/repo` */
  readonly nameWithOwner: string;
  /** GitHub CLI's account the clone signed in with; null when git used its own sign-in. */
  readonly account: string | null;
  /** GitHub CLI is installed, so Peer can sign in to GitHub. */
  readonly cli: boolean;
}

/**
 * A failed clone from github.com: GitHub answers "not found" for a private
 * repository the account may not open, so a refusal of any kind means the
 * account, and signing in with one that can open it fixes it.
 */
export function explainGitHubCloneFailure(
  output: string,
  target: GitHubCloneTarget,
): { readonly message: string; readonly signIn: boolean } {
  const refused =
    /could not read (username|password)|terminal prompts disabled|authentication failed|repository not found|repository '[^']*' not found|permission denied \(publickey/i.test(
      output,
    );
  if (!refused) return { message: explainCloneFailure(output, target), signIn: false };
  const repository = target.nameWithOwner;
  if (target.account !== null) {
    return {
      signIn: true,
      message: `GitHub account ${target.account} cannot open ${repository}. Ask its owner to add ${target.account}, or connect the GitHub account that can.`,
    };
  }
  return {
    signIn: true,
    message: target.cli
      ? `Connect GitHub with an account that can open ${repository}.`
      : `To clone ${repository}, install GitHub CLI (brew install gh) and connect GitHub here, or sign git in to GitHub with an account that can open it.`,
  };
}

/** What to tell the person when `git clone` of `target` printed `output` and failed. */
export function explainCloneFailure(output: string, target: CloneTarget): string {
  const host = remoteHost(target.url);
  const server = host ?? "the repository's server";
  const text = output.trim();
  const says = (pattern: RegExp) => pattern.test(text);

  if (says(/could not read (username|password)|terminal prompts disabled|authentication failed/i)) {
    const signIn =
      host === "github.com"
        ? 'run "gh auth login" in Terminal'
        : "clone the repository once in Terminal";
    return `Git on this computer is not signed in to ${server}. To sign in, ${signIn} with an account that can open the repository, then try again.`;
  }
  if (says(/permission denied \(publickey/i)) {
    return `${server} did not accept this computer's SSH key. Add the key to your account there, then try again.`;
  }
  if (says(/host key verification failed/i)) {
    const user = /^(?:ssh:\/\/)?([^@/:\s]+)@/.exec(target.url)?.[1];
    const login = user === undefined ? server : `${user}@${server}`;
    return `This computer has not connected to ${server} over SSH before. Run "ssh -T ${login}" in Terminal once and accept its key, then try again.`;
  }
  if (says(/repository not found|repository '[^']*' not found/i)) {
    return `${server} has no repository at ${target.url} that your account can open. Ask its owner for access, then try again.`;
  }
  if (says(/remote branch .+ not found/i)) {
    return `The repository has no branch "${target.branch}" yet. Once it is pushed, try again.`;
  }
  if (says(/could not resolve host|failed to connect|connection (timed out|refused)/i)) {
    return `This computer could not reach ${server}. Check the connection, then try again.`;
  }
  const occupied = /destination path '(.+)' already exists/i.exec(text);
  if (occupied !== null) {
    return `Something else is already at ${occupied[1]}. Move it away, then try again.`;
  }
  if (says(/xcrun: error|invalid active developer path|no developer tools/i)) {
    return 'Git needs Apple\'s command line tools. Run "xcode-select --install" in Terminal, then try again.';
  }
  if (says(/spawn git enoent/i)) {
    return "Git is not installed on this computer. Install it, then try again.";
  }
  // Anything else: git's own verdict, without its prefix.
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const verdict = lines.find((line) => /^fatal:/i.test(line)) ?? lines.at(-1) ?? "git clone failed";
  return verdict.replace(/^(fatal|error):\s*/i, "").slice(0, 300);
}
