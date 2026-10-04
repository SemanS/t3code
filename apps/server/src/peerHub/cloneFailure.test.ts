import { assert, describe, it } from "@effect/vitest";

import { explainCloneFailure, explainGitHubCloneFailure, remoteHost } from "./cloneFailure.ts";

const GITHUB = { url: "https://github.com/acme/app", branch: "main" };
const GITHUB_SSH = { url: "git@github.com:acme/app.git", branch: "main" };

// What git 2.50 prints for each failure, as captured from real clones.
const SSH_ADVICE =
  "fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

describe("explainCloneFailure", () => {
  it("tells someone without a sign-in how to sign in", () => {
    const github = explainCloneFailure(
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      GITHUB,
    );
    assert.include(github, "not signed in to github.com");
    assert.include(github, "gh auth login");
    const elsewhere = explainCloneFailure(
      "fatal: Authentication failed for 'https://bitbucket.org/acme/app.git/'",
      { url: "https://bitbucket.org/acme/app.git", branch: "main" },
    );
    assert.include(elsewhere, "not signed in to bitbucket.org");
    assert.include(elsewhere, "clone the repository once in Terminal");
  });

  it("finds SSH causes above git's generic advice", () => {
    assert.include(
      explainCloneFailure(
        `Load key "/dev/null": invalid format\ngit@github.com: Permission denied (publickey).\n${SSH_ADVICE}`,
        GITHUB_SSH,
      ),
      "did not accept this computer's SSH key",
    );
    assert.include(
      explainCloneFailure(
        `No ED25519 host key is known for github.com and you have requested strict checking.\nHost key verification failed.\n${SSH_ADVICE}`,
        GITHUB_SSH,
      ),
      'Run "ssh -T git@github.com"',
    );
  });

  it("names a branch nobody pushed and a repository the account cannot open", () => {
    assert.include(
      explainCloneFailure("fatal: Remote branch krk-812 not found in upstream origin", {
        ...GITHUB,
        branch: "krk-812",
      }),
      'no branch "krk-812"',
    );
    assert.include(
      explainCloneFailure(
        "remote: Repository not found.\nfatal: repository 'https://github.com/acme/app/' not found",
        GITHUB,
      ),
      "Ask its owner for access",
    );
  });

  it("keeps git's verdict for causes it does not know", () => {
    assert.strictEqual(
      explainCloneFailure("fatal: early EOF\nfatal: index-pack failed", GITHUB),
      "early EOF",
    );
  });
});

describe("explainGitHubCloneFailure", () => {
  const target = { ...GITHUB, nameWithOwner: "acme/app", account: "ana-dev", cli: true };
  const notFound =
    "remote: Repository not found.\nfatal: repository 'https://github.com/acme/app.git/' not found";

  it("names the GitHub account that may not open a private repository", () => {
    const failure = explainGitHubCloneFailure(notFound, target);
    assert.isTrue(failure.signIn);
    assert.include(failure.message, "GitHub account ana-dev cannot open acme/app");
  });

  it("asks to connect GitHub, or to install GitHub CLI first", () => {
    const prompt =
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
    assert.include(
      explainGitHubCloneFailure(prompt, { ...target, account: null }).message,
      "Connect GitHub",
    );
    assert.include(
      explainGitHubCloneFailure(prompt, { ...target, account: null, cli: false }).message,
      "brew install gh",
    );
  });

  it("explains other failures as any clone", () => {
    const failure = explainGitHubCloneFailure(
      "fatal: Remote branch krk-812 not found in upstream origin",
      { ...target, branch: "krk-812" },
    );
    assert.isFalse(failure.signIn);
    assert.include(failure.message, 'no branch "krk-812"');
  });
});

describe("remoteHost", () => {
  it("reads the host from every address form and none from local paths", () => {
    assert.strictEqual(remoteHost("https://github.com/acme/app"), "github.com");
    assert.strictEqual(remoteHost("git@github.com:acme/app.git"), "github.com");
    assert.strictEqual(remoteHost("bitbucket.org:acme/app.git"), "bitbucket.org");
    assert.strictEqual(remoteHost("ssh://git@bitbucket.org/acme/app.git"), "bitbucket.org");
    assert.strictEqual(remoteHost("file:///srv/git/app.git"), undefined);
    assert.strictEqual(remoteHost("/Users/ana/code/app"), undefined);
  });
});
