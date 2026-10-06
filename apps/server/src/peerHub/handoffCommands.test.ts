import { describe, expect, it } from "@effect/vitest";
import { publishesWork } from "./handoffCommands.ts";

describe("publication boundary", () => {
  it("recognizes direct publication after directory and environment options", () => {
    for (const command of [
      "git push",
      "cd '/tmp/a b' && git -C . push origin HEAD",
      "env GH_HOST=x gh -R a/b pr create --title 'a'",
      "/opt/bin/git -c x=y push",
      "git status\ngit push",
      "command -- git push origin HEAD",
      "command -p env -i GH_HOST=x gh pr create",
      "env -u TOKEN -C '/tmp/a b' git push",
    ])
      expect(publishesWork(command)).toBe(true);
  });
  it("does not block discussion, inspection, or configuring push", () => {
    for (const command of [
      'echo "git push"',
      "git config alias.publish push",
      "gh pr view",
      "git pushx",
      "printf '%s' 'gh pr create'",
      "git log --grep=push",
      "command -v git push",
      "env -u git push",
    ])
      expect(publishesWork(command)).toBe(false);
  });
});
