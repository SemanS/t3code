// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - GitHub CLI runs as a child process on the person's own computer, and a sign-in that never offers a code gives up after a while.
/**
 * github — GitHub on this computer, through GitHub CLI (`gh`). Workspace
 * repositories on github.com clone with gh's active account, whatever else
 * git keeps (an old password in the keychain, another account), so a
 * failure can name the account; and signing in happens from the app with a
 * one-time code. Peer never sees a token: gh keeps it and hands it to git
 * as a credential helper.
 *
 * @module peerHub/github
 */
import * as NodeChildProcess from "node:child_process";

import { parseGitHubAuthStatus } from "../sourceControl/gitHubAuthStatus.ts";

/** A repository on github.com. */
export interface GitHubRepository {
  /** `owner/repo` */
  readonly nameWithOwner: string;
  readonly name: string;
  /** What Peer clones: https, so GitHub CLI's sign-in applies. */
  readonly httpsUrl: string;
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * The github.com repository an address names: https, ssh and scp-style
 * addresses, a page of it pasted from the browser, or `owner/repo`.
 */
export function gitHubRepository(address: string): GitHubRepository | null {
  const text = address.trim();
  let path: string | null = null;
  const scp = /^(?:[^@/\s]+@)?github\.com:([^\s]+)$/i.exec(text);
  if (scp !== null) {
    path = scp[1] ?? null;
  } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) {
    path = text;
  } else {
    try {
      const url = new URL(text);
      const github = url.hostname.toLowerCase() === "github.com";
      if (github && ["https:", "http:", "ssh:", "git:"].includes(url.protocol)) path = url.pathname;
    } catch {
      return null;
    }
  }
  if (path === null) return null;
  const [owner, repo] = path.replace(/^\/+/, "").split("/");
  const name = repo?.replace(/\.git$/i, "");
  if (!owner || !name || !SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  return {
    nameWithOwner: `${owner}/${name}`,
    name,
    httpsUrl: `https://github.com/${owner}/${name}.git`,
  };
}

/** GitHub CLI's active account on github.com, from `gh auth status --json hosts`. */
export function activeGitHubAccount(statusJson: string): string | null {
  const { accounts } = parseGitHubAuthStatus(statusJson);
  return (
    accounts.find(
      (account) => account.host === "github.com" && account.active && account.authenticated,
    )?.account ?? null
  );
}

/** git options that sign a command in to github.com with GitHub CLI's account and nothing else. */
export function gitHubCredentialOptions(gh: string): ReadonlyArray<string> {
  return ["-c", "credential.helper=", "-c", `credential.helper=${gitHubCredentialHelper(gh)}`];
}

/** The helper git runs; `gh auth setup-git` writes the same one. */
export function gitHubCredentialHelper(gh: string): string {
  return `!'${gh.replaceAll("'", "'\\''")}' auth git-credential`;
}

export interface DeviceCode {
  readonly userCode: string;
  readonly verificationUri: string;
}

/** The code `gh auth login --web` asks the person to enter, and where, once it has printed them. */
export function parseDeviceCode(output: string): DeviceCode | null {
  const userCode = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
  if (userCode === undefined) return null;
  const verificationUri =
    /continue in your web browser:\s*(https:\/\/\S+)/i.exec(output)?.[1] ??
    "https://github.com/login/device";
  return { userCode: userCode.toUpperCase(), verificationUri };
}

export interface GitHubSignIn extends DeviceCode {
  /** Settles when gh exits: signed in, or why not. */
  readonly done: Promise<void>;
  readonly cancel: () => void;
}

/**
 * Starts `gh auth login --web` and answers with the code the person enters
 * at GitHub; gh then waits for them and stores the account it gets.
 */
export function startGitHubSignIn(
  gh: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<GitHubSignIn> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      gh,
      [
        "auth",
        "login",
        "--hostname",
        "github.com",
        "--git-protocol",
        "https",
        "--web",
        "--skip-ssh-key",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let announced = false;
    const lastLine = () =>
      output
        .split("\n")
        .map((line) => line.trim())
        .findLast((line) => line !== "") ?? "";
    const done = new Promise<void>((settle, fail) => {
      child.once("error", fail);
      child.once("exit", (code, signal) => {
        if (code === 0) settle();
        else fail(new Error(lastLine() || `GitHub CLI stopped (${signal ?? code})`));
      });
    });
    // Nobody may be waiting for it any more (a cancelled sign-in); never let it go unhandled.
    done.catch(() => undefined);
    const timer = setTimeout(() => {
      if (announced) return;
      child.kill("SIGTERM");
      reject(new Error("GitHub CLI did not offer a code to sign in with."));
    }, timeoutMs);
    const read = (chunk: string) => {
      output += chunk;
      if (announced) return;
      const code = parseDeviceCode(output);
      if (code === null) return;
      announced = true;
      clearTimeout(timer);
      resolve({ ...code, done, cancel: () => child.kill("SIGTERM") });
    };
    child.stdout.setEncoding("utf8").on("data", read);
    child.stderr.setEncoding("utf8").on("data", read);
    done.then(
      () => {
        clearTimeout(timer);
        if (!announced) reject(new Error("GitHub CLI finished without offering a code."));
      },
      (error: unknown) => {
        clearTimeout(timer);
        if (!announced) reject(error);
      },
    );
  });
}
