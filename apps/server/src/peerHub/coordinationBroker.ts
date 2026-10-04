// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off preferSchemaOverJson:off - a local socket for agents' hooks and CLI, debounced syncs, wall-clock TTLs, and a JSON-lines log for experiments.
/**
 * CoordinationBroker — the local end of coordination. Agents' hooks and the
 * `peer` CLI talk to it over a Unix socket only this user can open. It keeps
 * the agent sessions of this computer, reports them to the hub and answers
 * hooks from the last view, so a hook waits on the network only when an
 * agent is about to touch a file another agent changed. Every event goes to
 * a JSON-lines log, so a run can be read back exactly.
 *
 * @module peerHub/coordinationBroker
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import type { PeerCoordinationPolicy, PeerWorkStatus } from "@t3tools/contracts";

import {
  announcementKey,
  contestKey,
  coordinationScripts,
  decideEdit,
  editedFile,
  emptyMemory,
  isPlainCliCall,
  newsFor,
  repositoryPath,
  shortId,
  statusText,
  touches,
  type CoordinationView,
  type SessionMemory,
} from "./coordination.ts";
import type { HubCoordSession, HubCoordView, HubOverlap, ReportedSession } from "./hubApi.ts";

export interface CheckoutPlace {
  readonly workspace: string;
  readonly project: string;
  /** The repository's working tree the agent is in. */
  readonly root: string;
}

export interface BrokerDeps {
  readonly socketPath: string;
  readonly scriptsDir: string;
  readonly logPath: string;
  readonly environment: string;
  /** The workspace project a directory belongs to, or null outside them. */
  readonly placeOf: (cwd: string) => Promise<CheckoutPlace | null>;
  readonly branchOf: (root: string) => Promise<string | undefined>;
  /** What herdr calls the agent in a pane. */
  readonly herdrTitle: (paneId: string) => string | undefined;
  readonly nameOf: (workspace: string, email: string) => string;
  readonly email: () => string | null;
  readonly policy: () => PeerCoordinationPolicy;
  readonly report: (
    workspace: string,
    sessions: ReadonlyArray<ReportedSession>,
  ) => Promise<HubCoordView>;
  readonly view: (workspace: string) => Promise<HubCoordView>;
  readonly note: (
    workspace: string,
    project: string,
    overlap: string,
    text: string,
    session: string | undefined,
  ) => Promise<HubOverlap>;
  readonly resolve: (
    workspace: string,
    project: string,
    overlap: string,
    resolution: string,
    session: string | undefined,
  ) => Promise<HubOverlap>;
  /** Workspaces whose overlaps people here should see. */
  readonly workspaces: () => ReadonlyArray<string>;
  /** Shows a notification in herdr on this computer. */
  readonly notify: (title: string, body: string) => void;
  /** What people see changed. */
  readonly changed: () => void;
}

interface LocalSession {
  readonly id: string;
  readonly agent: string;
  readonly workspace: string;
  readonly project: string;
  readonly root: string;
  cwd: string;
  pane: string | undefined;
  label: string;
  labelFromPrompt: boolean;
  branch: string | undefined;
  status: PeerWorkStatus;
  files: string[];
  claims: string[];
  intent: string | undefined;
  lastActivity: number;
  readonly memory: SessionMemory;
  /** Files whose edit its person was asked about: the edit happening means they approved. */
  readonly asked: Map<string, ReadonlyArray<string>>;
}

interface Waiter {
  readonly session: string;
  readonly since: number;
  readonly answer: (text: string) => void;
}

/** A session that did nothing for this long ended. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const ACTIVE_SYNC_MS = 3000;
const IDLE_SYNC_MS = 20_000;
const DEBOUNCE_MS = 300;
/** A view older than this is refreshed before deciding an edit. */
const FRESH_MS = 500;
const WAIT_MS = 25 * 60 * 1000;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 200;

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

export class CoordinationBroker {
  private server: NodeHttp.Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly views = new Map<string, HubCoordView>();
  private readonly viewAt = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly announcedToPeople = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  private readonly ignoredCwds = new Map<string, number>();
  private lastCli: { readonly session: string; readonly at: number } | null = null;
  private dirtySince: number | null = null;
  private lastSync = 0;
  private syncing: Promise<void> | null = null;
  private logQueue: Promise<void> = Promise.resolve();
  /** What agents are told to type; their Bash hook points it at the script. */
  readonly cli = "peer";
  readonly scripts: { readonly hook: string; readonly wait: string; readonly peer: string };

  private readonly deps: BrokerDeps;

  constructor(deps: BrokerDeps) {
    this.deps = deps;
    this.scripts = {
      hook: NodePath.join(deps.scriptsDir, "hook"),
      wait: NodePath.join(deps.scriptsDir, "wait"),
      peer: NodePath.join(deps.scriptsDir, "peer"),
    };
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    if (this.server !== null) return;
    await NodeFSP.mkdir(this.deps.scriptsDir, { recursive: true });
    const texts = coordinationScripts(this.deps.socketPath);
    for (const [name, text] of Object.entries(texts)) {
      const path = NodePath.join(this.deps.scriptsDir, name);
      await NodeFSP.writeFile(path, text, { mode: 0o755 });
      await NodeFSP.chmod(path, 0o755);
    }
    await NodeFSP.mkdir(NodePath.dirname(this.deps.socketPath), { recursive: true });
    await NodeFSP.rm(this.deps.socketPath, { force: true });
    const server = NodeHttp.createServer((request, response) => {
      void this.route(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.deps.socketPath, () => resolve());
    });
    // Only this user's processes may talk to it.
    await NodeFSP.chmod(this.deps.socketPath, 0o600);
    this.server = server;
    this.timer = setInterval(() => void this.tick(), 500);
    this.log("broker.started", { socket: this.deps.socketPath, policy: this.deps.policy() });
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const waiter of this.waiters) waiter.answer("");
    this.waiters.clear();
    // Tell the hub this computer's agents are no longer coordinated.
    this.sessions.clear();
    for (const workspace of this.reported) {
      await this.deps.report(workspace, []).catch(() => undefined);
    }
    this.reported.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
    }
    await NodeFSP.rm(this.deps.socketPath, { force: true });
    this.log("broker.stopped", {});
    await this.logQueue;
  }

  // ---- what people see ----

  snapshot(): {
    readonly sessions: ReadonlyArray<
      HubCoordSession & { readonly workspace: string; readonly local: boolean }
    >;
    readonly overlaps: ReadonlyArray<HubOverlap & { readonly workspace: string }>;
  } {
    const sessions = [];
    const overlaps = [];
    for (const [workspace, view] of this.views) {
      for (const session of this.merged(workspace, view).sessions) {
        sessions.push({ ...session, workspace, local: this.sessions.has(session.id) });
      }
      for (const overlap of view.overlaps) overlaps.push({ ...overlap, workspace });
    }
    return { sessions, overlaps };
  }

  /** A person's note on an overlap, from Peer. */
  async personNote(workspace: string, project: string, overlap: string, text: string) {
    const updated = await this.deps.note(workspace, project, overlap, text, undefined);
    this.log("note.person", { workspace, project, overlap, text });
    this.applyOverlap(workspace, updated);
  }

  async personResolve(workspace: string, project: string, overlap: string, resolution: string) {
    const updated = await this.deps.resolve(workspace, project, overlap, resolution, undefined);
    this.log("resolve.person", { workspace, project, overlap, resolution });
    this.applyOverlap(workspace, updated);
  }

  // ---- log ----

  private log(event: string, fields: Record<string, unknown>) {
    const line = `${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`;
    this.logQueue = this.logQueue
      .then(async () => {
        await NodeFSP.mkdir(NodePath.dirname(this.deps.logPath), { recursive: true });
        const size = await NodeFSP.stat(this.deps.logPath).then(
          (stat) => stat.size,
          () => 0,
        );
        if (size > LOG_ROTATE_BYTES) {
          await NodeFSP.rename(this.deps.logPath, `${this.deps.logPath}.1`).catch(() => undefined);
        }
        await NodeFSP.appendFile(this.deps.logPath, line);
      })
      .catch(() => undefined);
  }

  // ---- sessions ----

  private nameOf(workspace: string) {
    return (email: string) => this.deps.nameOf(workspace, email);
  }

  private asHub(session: LocalSession): HubCoordSession {
    return {
      id: session.id,
      project: session.project,
      email: this.deps.email() ?? "",
      environment: this.deps.environment,
      label: session.label,
      agent: session.agent,
      ...(session.branch === undefined ? {} : { branch: session.branch }),
      status: session.status,
      ...(session.intent === undefined ? {} : { intent: session.intent }),
      files: session.files,
      claims: session.claims,
      seenAt: new Date(session.lastActivity).toISOString(),
    };
  }

  /** The hub's view with this computer's sessions as they are now, not as last reported. */
  private merged(workspace: string, view: HubCoordView | undefined): CoordinationView {
    const local = [...this.sessions.values()].filter((s) => s.workspace === workspace);
    const localIds = new Set(local.map((s) => s.id));
    return {
      sessions: [
        ...(view?.sessions ?? []).filter((s) => !localIds.has(s.id)),
        ...local.map((s) => this.asHub(s)),
      ],
      overlaps: view?.overlaps ?? [],
    };
  }

  private async sessionFor(
    body: Record<string, unknown>,
    pane: string | undefined,
  ): Promise<LocalSession | null> {
    const sid = typeof body.session_id === "string" ? body.session_id : null;
    if (sid === null) return null;
    const id = `claude:${sid}`;
    const existing = this.sessions.get(id);
    if (existing !== undefined) return existing;
    const cwd = typeof body.cwd === "string" ? body.cwd : null;
    if (cwd === null) return null;
    const ignoredAt = this.ignoredCwds.get(cwd);
    if (ignoredAt !== undefined && Date.now() - ignoredAt < 60_000) return null;
    const place = await this.deps.placeOf(cwd);
    if (place === null) {
      this.ignoredCwds.set(cwd, Date.now());
      this.log("session.ignored", { session: id, cwd, why: "not in a workspace project" });
      return null;
    }
    const title = pane === undefined ? undefined : this.deps.herdrTitle(pane);
    const session: LocalSession = {
      id,
      agent: "claude",
      workspace: place.workspace,
      project: place.project,
      root: place.root,
      cwd,
      pane,
      label: title ?? "Claude session",
      labelFromPrompt: false,
      branch: await this.deps.branchOf(place.root),
      status: "idle",
      files: [],
      claims: [],
      intent: undefined,
      lastActivity: Date.now(),
      memory: emptyMemory(),
      asked: new Map(),
    };
    this.sessions.set(id, session);
    this.log("session.started", {
      session: id,
      workspace: place.workspace,
      project: place.project,
      root: place.root,
      pane,
      branch: session.branch,
    });
    return session;
  }

  private touch(session: LocalSession) {
    session.lastActivity = Date.now();
    // An agent at work again is no longer waiting to be woken.
    for (const waiter of this.waiters) {
      if (waiter.session === session.id) {
        this.waiters.delete(waiter);
        waiter.answer("");
      }
    }
  }

  private markDirty() {
    this.dirtySince ??= Date.now();
  }

  // ---- hooks ----

  private async hook(
    body: Record<string, unknown>,
    headers: NodeHttp.IncomingHttpHeaders,
  ): Promise<Record<string, unknown> | null> {
    const started = Date.now();
    const event = typeof body.hook_event_name === "string" ? body.hook_event_name : "";
    const pane = headerOf(headers, "x-herdr-pane");
    // A session Peer never saw that ends has nothing to clear.
    if (event === "SessionEnd" && !this.sessions.has(`claude:${String(body.session_id)}`))
      return null;
    const session = await this.sessionFor(body, pane);
    if (session === null) return null;
    if (pane !== undefined) session.pane = pane;
    const out = await this.answerHook(event, session, body);
    this.log("hook", {
      session: session.id,
      hookEvent: event,
      tool: body.tool_name,
      file: editedFile(body.tool_name, body.tool_input) ?? undefined,
      answer: out ?? undefined,
      ms: Date.now() - started,
    });
    return out;
  }

  private async answerHook(
    event: string,
    session: LocalSession,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const context = (hookEventName: string, text: string | null) =>
      text === null ? null : { hookSpecificOutput: { hookEventName, additionalContext: text } };
    switch (event) {
      case "SessionStart": {
        this.touch(session);
        session.status = "idle";
        this.markDirty();
        return context(event, this.news(session));
      }
      case "UserPromptSubmit": {
        this.touch(session);
        session.status = "working";
        // What the person asked first says more than a terminal title ("Claude Code").
        const asked = typeof body.prompt === "string" ? clip(body.prompt, 200) : "";
        const prompt = asked.length > 60 ? `${asked.slice(0, 59)}…` : asked;
        if (prompt !== "" && !session.labelFromPrompt) {
          session.label = prompt;
          session.labelFromPrompt = true;
        }
        this.markDirty();
        return context(event, this.news(session));
      }
      case "PreToolUse":
        this.touch(session);
        session.status = "working";
        return this.beforeTool(session, body);
      case "PostToolUse": {
        this.touch(session);
        const file = this.fileOf(session, body);
        if (file !== null) {
          session.files = [...session.files.filter((f) => f !== file), file].slice(-MAX_FILES);
          const asked = session.asked.get(file);
          if (asked !== undefined) {
            // The edit ran after its person was asked: they approved.
            for (const key of asked) session.memory.acknowledged.add(key);
            session.asked.delete(file);
            this.log("ask.approved", { session: session.id, file, keys: asked });
          }
          this.markDirty();
        }
        return context(event, this.news(session));
      }
      case "Stop":
        session.status = "idle";
        session.lastActivity = Date.now();
        this.markDirty();
        return null;
      case "SessionEnd":
        this.sessions.delete(session.id);
        this.log("session.ended", { session: session.id });
        this.markDirty();
        return null;
      default:
        return null;
    }
  }

  private fileOf(session: LocalSession, body: Record<string, unknown>): string | null {
    const file = editedFile(body.tool_name, body.tool_input);
    return file === null ? null : inRepository(session, file);
  }

  private async beforeTool(
    session: LocalSession,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    // The agent running Peer's own CLI: let it, and remember who is about to call.
    if (body.tool_name === "Bash") {
      const input = body.tool_input as Record<string, unknown> | null;
      const command = typeof input?.command === "string" ? input.command.trim() : "";
      const script = this.scripts.peer;
      // `peer …` is Peer's own coordination command: run its script, without asking.
      const viaName = isPlainCliCall(command, this.cli);
      if (viaName || isPlainCliCall(command, script)) {
        this.lastCli = { session: session.id, at: Date.now() };
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: "Peer coordination",
            ...(viaName
              ? {
                  updatedInput: { ...input, command: `${script}${command.slice(this.cli.length)}` },
                }
              : {}),
          },
        };
      }
      return null;
    }
    const file = this.fileOf(session, body);
    if (file === null) return this.newsContext("PreToolUse", session);
    // Decide on what the other agents changed just now, not a view from a while ago.
    if (Date.now() - (this.viewAt.get(session.workspace) ?? 0) > FRESH_MS) {
      await this.syncNow(session.workspace, 1500);
    }
    const policy = this.deps.policy();
    let answer = this.decide(session, file, policy);
    if (answer.decision === "deny") {
      // Make the contest an overlap the hub knows, so the agent's note has somewhere to go.
      session.claims = [...session.claims.filter((c) => c !== file), file];
      this.markDirty();
      await this.syncNow(session.workspace, 1500);
      answer = this.decide(session, file, policy);
    }
    if (answer.decision === undefined && answer.context === undefined) {
      return this.newsContext("PreToolUse", session);
    }
    this.announce(session, answer.overlaps);
    if (answer.decision === "ask") {
      session.asked.set(file, answer.keys);
    } else if (answer.decision === undefined) {
      for (const key of answer.keys) session.memory.acknowledged.add(key);
    }
    this.log("decision", {
      session: session.id,
      file,
      policy,
      decision: answer.decision ?? "notify",
      with: answer.with,
      keys: answer.keys,
      text: answer.reason ?? answer.context,
    });
    if (answer.decision !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: answer.decision,
          permissionDecisionReason: answer.reason,
        },
      };
    }
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: answer.context },
    };
  }

  private decide(session: LocalSession, file: string, policy: PeerCoordinationPolicy) {
    return decideEdit({
      policy,
      me: this.asHub(session),
      file,
      view: this.merged(session.workspace, this.views.get(session.workspace)),
      memory: session.memory,
      nameOf: this.nameOf(session.workspace),
      cli: this.cli,
    });
  }

  private newsContext(event: string, session: LocalSession) {
    const text = this.news(session);
    return text === null
      ? null
      : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  }

  /** What happened on the session's overlaps since it last heard, marked as heard. */
  private news(session: LocalSession): string | null {
    const news = newsFor({
      me: this.asHub(session),
      view: this.merged(session.workspace, this.views.get(session.workspace)),
      memory: session.memory,
      nameOf: this.nameOf(session.workspace),
      cli: this.cli,
    });
    if (news === null) return null;
    for (const id of news.announced) session.memory.announced.add(id);
    for (const id of news.seen) session.memory.seenNotes.add(id);
    this.log("news", {
      session: session.id,
      text: news.text,
      announced: news.announced,
      seen: news.seen,
    });
    return news.text;
  }

  // ---- waking idle agents ----

  private async wait(
    body: Record<string, unknown>,
    headers: NodeHttp.IncomingHttpHeaders,
  ): Promise<string> {
    const session = await this.sessionFor(body, headerOf(headers, "x-herdr-pane"));
    if (session === null) return "";
    const ready = this.news(session);
    if (ready !== null) {
      this.log("wake", { session: session.id, text: ready, immediate: true });
      return ready;
    }
    return new Promise<string>((resolve) => {
      const waiter: Waiter = {
        session: session.id,
        since: Date.now(),
        answer: (text) => {
          clearTimeout(timer);
          resolve(text);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve("");
      }, WAIT_MS);
      this.waiters.add(waiter);
      this.log("wait", { session: session.id });
    });
  }

  /** Wakes idle agents that have something new to hear. */
  private wakeWaiters() {
    for (const waiter of this.waiters) {
      const session = this.sessions.get(waiter.session);
      if (session === undefined) {
        this.waiters.delete(waiter);
        waiter.answer("");
        continue;
      }
      const text = this.news(session);
      if (text !== null) {
        this.waiters.delete(waiter);
        this.log("wake", { session: session.id, text });
        waiter.answer(text);
      }
    }
  }

  // ---- the peer CLI ----

  private async callerOf(headers: NodeHttp.IncomingHttpHeaders): Promise<LocalSession | null> {
    const explicit = headerOf(headers, "x-peer-session");
    if (explicit !== undefined) {
      const session = this.sessions.get(
        explicit.startsWith("claude:") ? explicit : `claude:${explicit}`,
      );
      if (session !== undefined) return session;
    }
    const pane = headerOf(headers, "x-herdr-pane");
    const recent = [...this.sessions.values()].toSorted((a, b) => b.lastActivity - a.lastActivity);
    if (pane !== undefined) {
      const inPane = recent.find((s) => s.pane === pane);
      if (inPane !== undefined) return inPane;
    }
    if (this.lastCli !== null && Date.now() - this.lastCli.at < 15_000) {
      const session = this.sessions.get(this.lastCli.session);
      if (session !== undefined) return session;
    }
    const cwd = headerOf(headers, "x-peer-cwd");
    if (cwd === undefined) return null;
    return recent.find((s) => cwd === s.root || cwd.startsWith(`${s.root}/`)) ?? null;
  }

  private async runCli(
    command: string,
    args: ReadonlyArray<string>,
    headers: NodeHttp.IncomingHttpHeaders,
  ): Promise<string> {
    if (command === "help") return this.help();
    const session = await this.callerOf(headers);
    if (session === null) {
      return "peer: no agent session of yours is known here. Peer coordinates Claude Code sessions in workspace projects.";
    }
    this.touch(session);
    const flag = (name: string) => {
      const at = args.indexOf(name);
      return at < 0 ? undefined : args[at + 1];
    };
    const plain = args.filter((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
    const text = clip(plain.join(" "), 600);
    const view = () => this.merged(session.workspace, this.views.get(session.workspace));
    const mine = (state?: "open") =>
      view().overlaps.filter(
        (o) =>
          o.sessions.includes(session.id) &&
          (state === undefined || o.state === state) &&
          (flag("--overlap") === undefined || o.id.startsWith(flag("--overlap") ?? "")),
      );
    switch (command) {
      case "status": {
        await this.syncNow(session.workspace, 3000);
        const out = statusText({
          me: this.asHub(session),
          view: view(),
          nameOf: this.nameOf(session.workspace),
          cli: this.cli,
        });
        this.markSeen(session);
        return out;
      }
      case "note": {
        if (text === "")
          return `peer: say what to note, e.g. ${this.cli} note "I only change submit() in pay.ts"`;
        await this.syncNow(session.workspace, 3000);
        const targets = mine("open");
        if (targets.length === 0) {
          return `peer: you share no files with another agent right now, so there is no one to note to. ${this.cli} status shows who is at work.`;
        }
        for (const overlap of targets) {
          const updated = await this.deps.note(
            session.workspace,
            session.project,
            overlap.id,
            text,
            session.id,
          );
          this.applyOverlap(session.workspace, updated);
          this.acknowledge(session, overlap);
        }
        this.log("note.agent", { session: session.id, overlaps: targets.map((o) => o.id), text });
        return `Noted on overlap ${targets.map((o) => shortId(o.id)).join(", ")}; the other agent hears it at its next step, or wakes up if idle.`;
      }
      case "resolve": {
        if (text === "")
          return `peer: say what was agreed, e.g. ${this.cli} resolve "they rename first, I rebase"`;
        await this.syncNow(session.workspace, 3000);
        const targets = mine("open");
        if (targets.length === 0) return "peer: no open overlap to resolve.";
        for (const overlap of targets) {
          const updated = await this.deps.resolve(
            session.workspace,
            session.project,
            overlap.id,
            text,
            session.id,
          );
          this.applyOverlap(session.workspace, updated);
          this.acknowledge(session, overlap);
        }
        this.log("resolve.agent", {
          session: session.id,
          overlaps: targets.map((o) => o.id),
          text,
        });
        return `Resolved overlap ${targets.map((o) => shortId(o.id)).join(", ")}.`;
      }
      case "claim": {
        const cwd = headerOf(headers, "x-peer-cwd") ?? session.cwd;
        const claimed = plain.flatMap((path) => {
          const relative = inRepository({ ...session, cwd }, path);
          return relative === null
            ? []
            : [path.endsWith("/") && !relative.endsWith("/") ? `${relative}/` : relative];
        });
        if (claimed.length === 0)
          return "peer: name files or directories (ending in /) inside this repository.";
        session.claims = [...new Set([...session.claims, ...claimed])];
        const intent = flag("--intent");
        if (intent !== undefined) session.intent = clip(intent, 300);
        this.markDirty();
        await this.syncNow(session.workspace, 3000);
        const others = view().sessions.filter(
          (s) =>
            s.id !== session.id &&
            s.project === session.project &&
            [...s.files, ...s.claims].some((p) => claimed.some((c) => touches(p, c))),
        );
        this.log("claim", {
          session: session.id,
          claimed,
          intent: session.intent,
          contested: others.map((s) => s.id),
        });
        return others.length === 0
          ? `Claimed ${claimed.join(", ")}. No other agent works there.`
          : `Claimed ${claimed.join(", ")}. Already there: ${others.map((s) => `${this.deps.nameOf(session.workspace, s.email)}'s agent ("${s.label}")`).join("; ")}. ${this.cli} status shows the overlap.`;
      }
      case "release": {
        session.claims =
          plain.length === 0
            ? []
            : session.claims.filter((c) => !plain.some((p) => c === p || c.endsWith(p)));
        this.markDirty();
        this.log("release", { session: session.id, claims: session.claims });
        return session.claims.length === 0
          ? "Released all claims."
          : `Still claimed: ${session.claims.join(", ")}`;
      }
      default:
        return this.help();
    }
  }

  private help(): string {
    const cli = this.cli;
    return [
      "peer — coordinate with the other agents on this project through Peer.",
      `  ${cli} status                     who else is at work here, your overlaps and their notes`,
      `  ${cli} note "<text>"              a note to the agents you share files with (they hear it at their next step)`,
      `  ${cli} resolve "<agreement>"      close your open overlaps with what was agreed`,
      `  ${cli} claim <path>... [--intent "<why>"]   files or directories/ you are about to change`,
      `  ${cli} release [<path>...]        drop claims`,
    ].join("\n");
  }

  /** The session posted on an overlap: it no longer has to before editing the files in it so far. */
  private acknowledge(session: LocalSession, overlap: HubOverlap) {
    session.memory.announced.add(announcementKey(overlap));
    const others = overlap.sessions.filter((id) => id !== session.id);
    for (const file of overlap.files) {
      session.memory.acknowledged.add(contestKey(overlap.id, file));
      for (const other of others)
        session.memory.acknowledged.add(contestKey(`with:${other}`, file));
    }
  }

  /** The session was told about these overlaps as they are now. */
  private announce(session: LocalSession, overlapIds: ReadonlyArray<string>) {
    for (const overlap of this.views.get(session.workspace)?.overlaps ?? []) {
      if (overlapIds.includes(overlap.id)) session.memory.announced.add(announcementKey(overlap));
    }
  }

  private markSeen(session: LocalSession) {
    for (const overlap of this.views.get(session.workspace)?.overlaps ?? []) {
      if (!overlap.sessions.includes(session.id)) continue;
      session.memory.announced.add(announcementKey(overlap));
      for (const note of overlap.notes) session.memory.seenNotes.add(note.id);
    }
  }

  // ---- syncing with the hub ----

  private applyOverlap(workspace: string, overlap: HubOverlap) {
    const view = this.views.get(workspace);
    if (view === undefined) return;
    this.views.set(workspace, {
      ...view,
      overlaps: [...view.overlaps.filter((o) => o.id !== overlap.id), overlap],
    });
    this.afterViewChange(workspace);
  }

  private afterViewChange(workspace: string) {
    const view = this.views.get(workspace);
    for (const overlap of view?.overlaps ?? []) {
      if (overlap.state !== "open" || this.announcedToPeople.has(overlap.id)) continue;
      const local = overlap.sessions.filter((id) => this.sessions.has(id));
      if (local.length === 0) continue;
      this.announcedToPeople.add(overlap.id);
      const others = new Set(overlap.sessions.filter((id) => !this.sessions.has(id)));
      const other = view?.sessions.find((s) => others.has(s.id));
      const who =
        other === undefined
          ? "another agent of yours"
          : `${this.deps.nameOf(workspace, other.email)}'s agent`;
      this.deps.notify(
        `Peer: overlap with ${who}`,
        `${overlap.files.join(", ")} · ${overlap.project}`,
      );
      this.log("overlap.opened", {
        workspace,
        overlap: overlap.id,
        sessions: overlap.sessions,
        files: overlap.files,
      });
    }
    this.wakeWaiters();
    this.deps.changed();
  }

  private reportFor(workspace: string): ReadonlyArray<ReportedSession> {
    return [...this.sessions.values()]
      .filter((s) => s.workspace === workspace)
      .map((s) => ({
        id: s.id,
        project: s.project,
        label: s.label,
        agent: s.agent,
        ...(s.branch === undefined ? {} : { branch: s.branch }),
        status: s.status,
        ...(s.intent === undefined ? {} : { intent: s.intent }),
        files: s.files,
        claims: s.claims,
      }));
  }

  /** Reports and refreshes now (one workspace, or all), waiting at most `budgetMs`. */
  private async syncNow(workspace?: string, budgetMs = 5000): Promise<void> {
    const run = this.sync(workspace);
    await Promise.race([run, new Promise((resolve) => setTimeout(resolve, budgetMs))]);
  }

  private sync(only?: string): Promise<void> {
    if (this.syncing !== null) return this.syncing.then(() => this.sync(only));
    const run = (async () => {
      const started = Date.now();
      this.dirtySince = null;
      this.lastSync = started;
      const now = Date.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastActivity > SESSION_TTL_MS) {
          this.sessions.delete(id);
          this.log("session.expired", { session: id });
        }
      }
      const workspaces = new Set<string>([
        ...this.deps.workspaces(),
        ...[...this.sessions.values()].map((s) => s.workspace),
        ...this.reported,
      ]);
      for (const workspace of workspaces) {
        if (only !== undefined && workspace !== only) continue;
        const sessions = this.reportFor(workspace);
        try {
          const view =
            sessions.length > 0 || this.reported.has(workspace)
              ? await this.deps.report(workspace, sessions)
              : await this.deps.view(workspace);
          if (sessions.length > 0) this.reported.add(workspace);
          else this.reported.delete(workspace);
          this.views.set(workspace, view);
          this.viewAt.set(workspace, Date.now());
          this.log("sync", {
            workspace,
            reported: sessions.map((s) => ({
              id: s.id,
              files: s.files.length,
              claims: s.claims,
              status: s.status,
            })),
            sessions: view.sessions.length,
            overlaps: view.overlaps.map((o) => ({
              id: o.id,
              state: o.state,
              files: o.files,
              notes: o.notes.length,
            })),
            ms: Date.now() - started,
          });
          this.afterViewChange(workspace);
        } catch (error) {
          this.log("sync.failed", {
            workspace,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    this.syncing = run.finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private tick() {
    const now = Date.now();
    const active = [...this.sessions.values()].some((s) => now - s.lastActivity < 10 * 60 * 1000);
    const due =
      (this.dirtySince !== null && now - this.dirtySince >= DEBOUNCE_MS) ||
      now - this.lastSync >= (active ? ACTIVE_SYNC_MS : IDLE_SYNC_MS);
    if (due && this.syncing === null) void this.sync();
  }

  // ---- the socket ----

  private async route(request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) {
    try {
      const raw = await readBody(request);
      const url = request.url ?? "/";
      if (url === "/hook" || url === "/hook/wait") {
        const body = parseJson(raw);
        if (url === "/hook") {
          const out = await this.hook(body, request.headers);
          respond(response, out === null ? 204 : 200, out === null ? "" : JSON.stringify(out));
        } else {
          const text = await this.wait(body, request.headers);
          respond(response, text === "" ? 204 : 200, text);
        }
        return;
      }
      if (url.startsWith("/cli/")) {
        const command = url.slice("/cli/".length);
        const args =
          raw === ""
            ? []
            : raw.split("\0").filter((arg, i, all) => i < all.length - 1 || arg !== "");
        const out = await this.runCli(command, args, request.headers);
        this.log("cli", { command, args, out });
        respond(response, 200, `${out}\n`);
        return;
      }
      respond(response, 404, "");
    } catch (error) {
      this.log("broker.error", { error: error instanceof Error ? error.message : String(error) });
      respond(response, 500, "");
    }
  }
}

/**
 * A path as the agent named it, relative to the session's repository. git
 * names the repository by its real path (/private/var/… on macOS) while agents
 * use the path they were given (/var/…), and the file may not exist yet: the
 * nearest existing directory decides.
 */
function inRepository(session: { readonly root: string; readonly cwd: string }, path: string) {
  const absolute = NodePath.normalize(
    NodePath.isAbsolute(path) ? path : NodePath.join(session.cwd, path),
  );
  return repositoryPath(session.root, absolute) ?? repositoryPath(session.root, realPath(absolute));
}

function realPath(path: string): string {
  const missing: string[] = [];
  let existing = path;
  for (;;) {
    try {
      return NodePath.join(NodeFS.realpathSync(existing), ...missing);
    } catch {
      const parent = NodePath.dirname(existing);
      if (parent === existing) return path;
      missing.unshift(NodePath.basename(existing));
      existing = parent;
    }
  }
}

function headerOf(headers: NodeHttp.IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return text === undefined || text === "" ? undefined : text;
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readBody(request: NodeHttp.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 1_000_000) request.destroy();
    });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

function respond(response: NodeHttp.ServerResponse, status: number, body: string) {
  if (response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(body);
}

/** Whether a Unix socket path fits the platform's limit (104 bytes on macOS). */
export function socketPathFits(path: string): boolean {
  return Buffer.byteLength(path) < 104;
}

/** A JSON settings file: {} when it does not exist, null when it is not a JSON object. */
export async function readJsonSettings(path: string): Promise<Record<string, unknown> | null> {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => null);
  if (text === null) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Writes a JSON settings file in one step, keeping the original once as `<file>.peer-backup`. */
export async function writeJsonSettings(
  path: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const backup = `${path}.peer-backup`;
  const existing = await NodeFSP.stat(path).then(
    () => true,
    () => false,
  );
  const backedUp = await NodeFSP.stat(backup).then(
    () => true,
    () => false,
  );
  if (existing && !backedUp) await NodeFSP.copyFile(path, backup);
  const temporary = `${path}.peer-${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  await NodeFSP.rename(temporary, path);
}
