import { assert, describe, it } from "@effect/vitest";

import { isSafeGitRef, isSafeGitRemote } from "./gitSafety.ts";

describe("isSafeGitRemote", () => {
  it("accepts the addresses teams clone from", () => {
    for (const url of [
      "https://github.com/acme/app.git",
      "ssh://git@bitbucket.org/acme/app.git",
      "git@bitbucket.org:acme/app.git",
      "bitbucket.org:acme/app.git",
      "file:///srv/git/app.git",
      "/Users/ana/code/app",
    ]) {
      assert.isTrue(isSafeGitRemote(url), url);
    }
  });

  it("refuses transport helpers and options that would run code", () => {
    for (const url of [
      "ext::sh -c touch% /tmp/pwned",
      "fd::17",
      "--upload-pack=touch /tmp/pwned",
      "-u touch",
      "https://example.test/app.git --config=core.sshCommand=x",
      " https://example.test/app.git",
      "",
    ]) {
      assert.isFalse(isSafeGitRemote(url), url);
    }
  });
});

describe("isSafeGitRef", () => {
  it("accepts branch names and refuses options and odd refs", () => {
    assert.isTrue(isSafeGitRef("main"));
    assert.isTrue(isSafeGitRef("feature/KRK-812_split.payments"));
    for (const ref of ["--orphan", "-b", "a..b", "a b", "/main", "main/", "x.lock", ""]) {
      assert.isFalse(isSafeGitRef(ref), ref);
    }
  });
});
