/**
 * gitSafety — what a workspace may hand to `git clone` on a member's computer.
 *
 * Repository addresses and branches come from the hub, so a workspace admin
 * writes them. git treats `<transport>::<address>` as a helper to run
 * (`ext::sh -c …` runs a command) and a leading `-` as an option, so only
 * plain https, http, ssh, git and file addresses, scp-style `user@host:path`
 * and absolute paths pass, and branches are refs, never options.
 *
 * @module peerHub/gitSafety
 */

/** Protocols git may use for anything Peer runs, submodules included. */
export const GIT_ALLOWED_PROTOCOLS = "file:git:http:https:ssh";

export function isSafeGitRemote(url: string): boolean {
  if (url === "" || url.length > 500 || url !== url.trim()) return false;
  if (url.startsWith("-") || url.includes("::") || /[\s\p{Cc}]/u.test(url)) return false;
  return (
    /^(https?|ssh|git):\/\/[^/]/i.test(url) ||
    /^file:\/\/\//i.test(url) ||
    /^([A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[^:/\\][^:]*$/.test(url) ||
    url.startsWith("/")
  );
}

export function isSafeGitRef(ref: string): boolean {
  return (
    /^[A-Za-z0-9._/-]{1,200}$/.test(ref) &&
    !ref.startsWith("-") &&
    !ref.startsWith("/") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".lock") &&
    !ref.includes("..") &&
    !ref.includes("//")
  );
}
