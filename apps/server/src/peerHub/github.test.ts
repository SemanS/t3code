import { assert, describe, it } from "@effect/vitest";

import { activeGitHubAccount, gitHubRepository, parseDeviceCode } from "./github.ts";

describe("gitHubRepository", () => {
  it("reads owner/repo from every way people write a GitHub repository", () => {
    for (const address of [
      "SemanS/vocabulift",
      "https://github.com/SemanS/vocabulift",
      "https://github.com/SemanS/vocabulift.git",
      "https://github.com/SemanS/vocabulift/tree/main/src",
      "git@github.com:SemanS/vocabulift.git",
      "ssh://git@github.com/SemanS/vocabulift.git",
    ]) {
      assert.deepStrictEqual(
        gitHubRepository(address),
        {
          nameWithOwner: "SemanS/vocabulift",
          name: "vocabulift",
          httpsUrl: "https://github.com/SemanS/vocabulift.git",
        },
        address,
      );
    }
  });

  it("leaves other hosts and local paths to git", () => {
    for (const address of [
      "https://gitlab.com/acme/app.git",
      "git@bitbucket.org:acme/app.git",
      "/Users/ana/code/app",
      "file:///srv/git/app.git",
      "https://github.com/SemanS",
    ]) {
      assert.isNull(gitHubRepository(address), address);
    }
  });
});

describe("activeGitHubAccount", () => {
  it("takes the active signed-in account, as git's credential helper does", () => {
    const status = JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: false, host: "github.com", login: "maruska-lab" },
          { state: "success", active: true, host: "github.com", login: "SemanS" },
        ],
      },
    });
    assert.strictEqual(activeGitHubAccount(status), "SemanS");
    assert.isNull(activeGitHubAccount(JSON.stringify({ hosts: {} })));
    const expired = status.replace(
      '"state":"success","active":true',
      '"state":"error","active":true',
    );
    assert.isNull(activeGitHubAccount(expired));
  });
});

describe("parseDeviceCode", () => {
  it("reads what gh auth login --web asks for, as gh 2.92 prints it without a terminal", () => {
    assert.isNull(parseDeviceCode(""));
    assert.deepStrictEqual(
      parseDeviceCode(
        "\n! First copy your one-time code: FF39-FB8B\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
      ),
      { userCode: "FF39-FB8B", verificationUri: "https://github.com/login/device" },
    );
  });
});
