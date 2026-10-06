# Team agents

Sign in and open a project in **Settings → Workspaces** on the environment that runs your agents.
Install [herdr](https://herdr.dev/docs/install/) there and start it. A remote browser or phone uses
that environment's runtime, repositories, and agent logins.

On macOS with Homebrew, install it with `brew install herdr`, then run `herdr`. For a headless
environment, run `herdr server` under your usual process supervisor. Other platforms and manual
downloads are covered in the install guide. Peer shows the prerequisite until that environment's
herdr server is running; it does not install a global runtime automatically.

In **Work**, choose **Start agent on task**, select Claude Code or Codex, and review the first prompt.
Peer creates a separate git worktree and a `feature/` branch containing the task's issue key when it
has one. It assigns the agent to the task before sending the prompt. On mobile, open **Settings →
Peer workspaces**, select a task, then start the agent. Projects requiring approved commercial or
shared capacity use a Peer thread with an allowed provider instead of this local CLI launch.

If an agent needs a trust or approval answer, open it in herdr and answer there. If launch or prompt
delivery could not be confirmed, inspect herdr before retrying. The task checkout stays available so
an uncertain launch cannot discard work. Stopping an agent does not close its task or erase its saved
handoff context.

Enable coordination in **Settings → Workspaces**. For Claude Code 2.1.291 or newer, enable **Peer
Mod**; it replaces Peer's Claude hooks. Codex uses Peer hooks and asks you to trust them. Changing the
adapter takes effect for newly started sessions; existing sessions keep their adapter. Turn the Mod
off to remove it from new sessions. On mobile, the same Mod control is in **Peer workspaces**.

Each herdr agent shows the coordination its running session actually supports:

- **A · action enforced:** a live Claude Mod checks tracked edits with the hub before they run.
- **B · hooks active:** a live session runs Peer hooks; blocking depends on the hook deadline.
- **C · observed after work:** Peer reports uncommitted paths after completed work. It cannot prevent
  overlaps or attribute every change to one agent.

Task history shows the hub's coordination events. Peer sends short coordination updates when an
idle agent needs to answer an overlap; shared context waits for the agent to read it. A prompt queued
in herdr is not evidence that the agent read or used the update.

Agents use `peer context` to read shared work with an exact version, and `peer log` to inspect its
coordination history. If an input changed, read its current context before accepting it with
`peer ack <task>`. A declared task cannot enter review or finish while its shared inputs are stale.
The task's history lets team members check these changes without opening another agent's private
conversation. Saved context survives its author's session; a new keeper can continue the work.
