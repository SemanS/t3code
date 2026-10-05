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
  AGENT_NAMES,
  agentNamed,
  announcementKey,
  boardNews,
  boardText,
  changedPaths,
  claimedTask,
  closeOutText,
  contestKey,
  contextTemplate,
  contextWritten,
  coordinationScripts,
  decideEdit,
  describe,
  editedFiles,
  emptyMemory,
  compactionNudge,
  projectGuidanceText,
  findingsForKeeper,
  findingsOnWork,
  isPlainCliCall,
  keeperSkill,
  mentionsCli,
  newsFor,
  projectLines,
  repositoryPath,
  rosterChange,
  type AgentKind,
  type EditAnswer,
  scopeOf,
  sharedChange,
  sharedTemplate,
  shortId,
  startContext,
  statusText,
  taskClaim,
  teamLines,
  withoutOutputTrim,
  teamNews,
  touches,
  type BoardEntry,
  type ContextHolder,
  type CoordinationView,
  type SessionMemory,
  type SharedContext,
  type WorkAgent,
} from "./coordination.ts";
import type {
  ContextRefusal,
  HubContext,
  HubContextKeeper,
  HubContextText,
  HubContextVersion,
  HubContextVersionText,
  HubCoordSession,
  HubCoordView,
  HubFinding,
  HubOverlap,
  ReportedSession,
} from "./hubApi.ts";

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
  /**
   * The herdr pane an agent of this kind runs in, in `cwd`: the one its hook
   * named when herdr agrees, else the only one there. Codex may run its hooks
   * in a shared server whose environment names another pane.
   */
  readonly herdrPane: (
    agent: AgentKind,
    cwd: string,
    named: string | undefined,
  ) => string | undefined;
  /**
   * Gives an idle Codex session a message, which starts its turn (Codex has no
   * hook that wakes it). False when Codex could not take it.
   */
  readonly queueCodex: (session: string, text: string) => Promise<boolean>;
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
  /** Where agents keep their working contexts, one file per session. */
  readonly contextsDir: string;
  /**
   * The task a session works on: the one its thread was put on (a Peer thread,
   * a herdr agent: the first of `keys` with one), else the one its branch or
   * label names by key.
   */
  readonly taskOf: (
    workspace: string,
    project: string,
    keys: ReadonlyArray<string>,
    texts: ReadonlyArray<string | undefined>,
  ) => string | undefined;
  /**
   * The Peer thread (`peer:<thread id>`) whose agent runs as this provider
   * session, by the session id its harness gives hooks; none for an agent
   * Peer does not run (herdr, a terminal).
   */
  readonly threadOf: (nativeId: string) => Promise<string | undefined>;
  /** A project's tasks as Peer knows them. */
  readonly tasks: (
    workspace: string,
    project: string,
  ) => ReadonlyArray<{
    readonly id: string;
    readonly key?: string | undefined;
    readonly title: string;
    readonly status?: string | undefined;
  }>;
  /** A task as people name it, e.g. `KRK-335 · DNS errors`. */
  readonly taskName: (workspace: string, project: string, task: string) => string;
  /** A shared context with its text, or null when it has none. */
  readonly readContext: (
    workspace: string,
    project: string,
    scope: string,
  ) => Promise<HubContextText | null>;
  /** Asks for a session to keep a shared context, or gives it up (`release`). */
  readonly keepContext: (
    workspace: string,
    project: string,
    scope: string,
    session: string,
    release: boolean,
  ) => Promise<HubContextText | ContextRefusal>;
  /** A new version of a shared context from the session that keeps it. */
  readonly writeContext: (
    workspace: string,
    project: string,
    scope: string,
    session: string,
    baseVersion: number,
    text: string,
  ) => Promise<HubContextText | ContextRefusal>;
  /** The project's own guidance for agents on what to mark [project], from a checkout's knowledge. */
  readonly projectGuidance: (root: string) => Promise<string | null>;
  /** Whether a task was closed. */
  readonly taskDone: (workspace: string, project: string, task: string) => boolean;
  /** What `git status --porcelain -z` says in a repository: its changed files. */
  readonly gitStatus: (root: string) => Promise<string>;
  /** The versions of a shared context the hub keeps, newest first. */
  readonly contextVersions: (
    workspace: string,
    project: string,
    scope: string,
  ) => Promise<ReadonlyArray<HubContextVersion>>;
  readonly readContextVersion: (
    workspace: string,
    project: string,
    scope: string,
    version: number,
  ) => Promise<HubContextVersionText | null>;
}

interface LocalSession {
  readonly id: string;
  /** The agent's harness, whose hooks report it: its id is `<agent>:<session id>`. */
  readonly agent: AgentKind;
  readonly workspace: string;
  readonly project: string;
  readonly root: string;
  cwd: string;
  pane: string | undefined;
  /** The transcript the agent's harness keeps for the session. */
  transcript: string | undefined;
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
  /** The file the agent keeps its own working context in. */
  readonly ownContextPath: string;
  /** The file it keeps now: its own, or its work's shared context while it keeps that. */
  contextPath: string;
  /** It keeps the shared context of its work (task, or no task). */
  keeps: boolean;
  /** The shared context's version (and text) it last heard, or wrote on while keeping it. */
  sharedHeard: number;
  sharedHeardText: string;
  sharedToldAt: number;
  /** What Peer tells it at its next step, e.g. that it keeps the shared context now. */
  readonly pending: string[];
  /** Its SessionStart is being answered, which settles who keeps its work's context itself. */
  starting: boolean;
  /** Who it last heard is on its work, while it keeps the shared context. */
  roster: ReadonlyArray<WorkAgent> | undefined;
  /** The size its kept context had when it was last told to compact it. */
  compactedAt: number;
  /** It was asked, as the keeper of a closed task, to mark what the project should keep. */
  toldClosed: boolean;
  /** The files git saw changed in its repository when it last looked: changes after it are its. */
  dirty: Set<string>;
  /** The lines it marked [project] in the shared context while keeping it: its findings. */
  readonly marked: Set<string>;
  /** Its "For the team" lines as last read: what it shares with the project. */
  team: ReadonlyArray<string>;
  readonly startedAt: number;
  /** When the agent last changed its working context, or when Peer created it. */
  contextAt: number;
  nudgedAt: number;
  /** The agent wrote its working context this session, or found one it had written before. */
  contextKept: boolean;
  /** It was reminded once, at its first change, that its working context was still empty. */
  remindedAtStart: boolean;
  task: string | undefined;
  /** The Peer thread it runs in (`peer:<thread id>`), once Peer found it. */
  thread: string | undefined;
  /** How often Peer looked for its thread: a thread's session id may be recorded after it starts. */
  threadTries: number;
  /** Tasks it asked the agents of (`task:<id>` claims), and when. */
  readonly asks: Map<string, number>;
  /** The other works whose shared context it has been told of, as they were written then. */
  readonly boardHeard: Set<string>;
  /** Findings of other agents it has heard. */
  readonly heard: Set<string>;
}

/** A shared context as this computer has it: in memory, and in a file its agents read. */
interface SharedMirror {
  readonly workspace: string;
  readonly project: string;
  readonly scope: string;
  readonly path: string;
  version: number;
  text: string;
  keeper: HubContextKeeper | undefined;
  updatedAt: string;
  updatedBy: string | undefined;
  /** The agent session that wrote it; none when a person brought an older version back. */
  updatedSession: string | undefined;
  restoredFrom: number | undefined;
  /** Its keeper here changed it and the hub has not taken the change yet. */
  unsent: boolean;
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
/** An agent whose working context has not changed for this long, while it works, is reminded once. */
const NUDGE_MS = 20 * 60 * 1000;
/** A shared context nobody keeps is asked for at most this often per work. */
const CLAIM_GAP_MS = 20_000;
/** An agent reading a shared context hears its changes at most this often. */
const SHARED_NEWS_GAP_MS = 5 * 60 * 1000;
/** What the hub keeps of a shared context. */
const SHARED_MAX_BYTES = 32 * 1024;
/** About 6K tokens: past this a keeper is told to compact, again for every 4 KiB more. */
const SHARED_COMPACT_BYTES = 24 * 1024;
const SHARED_COMPACT_STEP = 4 * 1024;
/**
 * A keeper idle this long, while an agent here works on its work, gives way (the
 * hub decides): ten minutes, or `PEER_KEEPER_IDLE_MS` (the coordination lab shortens it).
 */
const KEEPER_IDLE_MS = Number(process.env.PEER_KEEPER_IDLE_MS) || 10 * 60 * 1000;
/** The other works an agent hears of when it starts; `peer status` lists up to `BOARD_ALL`. */
const BOARD_SHOWN = 8;
const BOARD_ALL = 30;
/** A work nobody is at counts while its shared context changed this many days ago at most. */
const BOARD_DAYS = 14;
/** The other works' shared contexts this computer keeps a copy of, per project. */
const BOARD_MIRRORS = 12;
/** How long a session's start waits for those copies: its hook has a few seconds in all. */
const BOARD_START_WAIT_MS = 1200;
/** A question about a task goes once settled, after this long when no conversation opened, or after `ASK_MAX_MS`. */
const ASK_SETTLE_MS = 60_000;
const ASK_MAX_MS = 2 * 60 * 60 * 1000;

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long ago a time was, as people say it: `4 min`, `2 h`. */
function sinceText(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "a while";
  if (minutes === 0) return "under a minute";
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** A part of a path made of one id: no separators, no dots to climb with. */
const safePart = (part: string) => part.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);

export class CoordinationBroker {
  private server: NodeHttp.Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly views = new Map<string, HubCoordView>();
  private readonly viewAt = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly announcedToPeople = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  /** Codex sessions Peer is handing a note to through Codex now. */
  private readonly queueing = new Set<string>();
  /** Copies of the project's other works' contexts being made, per workspace. */
  private readonly boardMirroring = new Map<string, Promise<void>>();
  private readonly ignoredCwds = new Map<string, number>();
  /** Shared contexts of the work this computer's agents are on, by `sharedKey`. */
  private readonly shared = new Map<string, SharedMirror>();
  private readonly claimedAt = new Map<string, number>();
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
      // In a directory of its own: a session's PATH gets it and nothing else.
      peer: NodePath.join(deps.scriptsDir, "bin", "peer"),
    };
  }

  // ---- lifecycle ----

  async start(): Promise<void> {
    if (this.server !== null) return;
    const binDir = NodePath.dirname(this.scripts.peer);
    await NodeFSP.mkdir(binDir, { recursive: true });
    const texts = coordinationScripts(this.deps.socketPath, binDir);
    for (const [name, text] of Object.entries(texts)) {
      const path = this.scripts[name as keyof typeof texts];
      await NodeFSP.writeFile(path, text, { mode: 0o755 });
      await NodeFSP.chmod(path, 0o755);
    }
    // Where `peer` lived before it had a directory of its own.
    await NodeFSP.rm(NodePath.join(this.deps.scriptsDir, "peer"), { force: true });
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
    void this.forgetOldContexts();
  }

  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const waiter of this.waiters) waiter.answer("");
    this.waiters.clear();
    // The next agent on their work keeps what this computer's agents kept (the hub hands it
    // over anyway once their sessions stop reporting, so an unreachable hub does not hold this up).
    await Promise.race([
      Promise.all([...this.sessions.values()].map((session) => this.release(session))),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
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
    readonly findings: ReadonlyArray<HubFinding & { readonly workspace: string }>;
    readonly contexts: ReadonlyArray<HubContext & { readonly workspace: string }>;
    readonly candidates: ReadonlyArray<{
      readonly workspace: string;
      readonly project: string;
      readonly proposed: number;
    }>;
  } {
    const sessions = [];
    const overlaps = [];
    const findings = [];
    const contexts = [];
    const candidates = [];
    for (const [workspace, view] of this.views) {
      for (const session of this.merged(workspace, view).sessions) {
        sessions.push({ ...session, workspace, local: this.sessions.has(session.id) });
      }
      for (const overlap of view.overlaps) overlaps.push({ ...overlap, workspace });
      for (const finding of view.findings ?? []) findings.push({ ...finding, workspace });
      for (const context of view.contexts ?? []) contexts.push({ ...context, workspace });
      for (const waiting of view.candidates ?? []) candidates.push({ ...waiting, workspace });
    }
    return { sessions, overlaps, findings, contexts, candidates };
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
      ...(session.task === undefined ? {} : { task: session.task }),
      ...(session.branch === undefined ? {} : { branch: session.branch }),
      status: session.status,
      ...(session.intent === undefined ? {} : { intent: session.intent }),
      files: session.files,
      claims: session.claims,
      seenAt: new Date(session.lastActivity).toISOString(),
      activeAt: new Date(session.lastActivity).toISOString(),
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
    agent: AgentKind,
    body: Record<string, unknown>,
    pane: string | undefined,
  ): Promise<LocalSession | null> {
    const sid = typeof body.session_id === "string" ? body.session_id : null;
    if (sid === null) return null;
    const id = `${agent}:${sid}`;
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
    const branch = await this.deps.branchOf(place.root);
    // An agent Peer runs in a thread is on the task its thread was put on, whatever its branch.
    const thread = await this.deps.threadOf(sid).catch(() => undefined);
    const now = Date.now();
    const ownContextPath = NodePath.join(
      this.deps.contextsDir,
      safePart(place.workspace),
      safePart(place.project),
      `${safePart(sid)}.md`,
    );
    const session: LocalSession = {
      id,
      agent,
      workspace: place.workspace,
      project: place.project,
      root: place.root,
      cwd,
      pane,
      transcript: typeof body.transcript_path === "string" ? body.transcript_path : undefined,
      label: title ?? `${AGENT_NAMES[agent]} session`,
      labelFromPrompt: false,
      branch,
      status: "idle",
      files: [],
      claims: [],
      intent: undefined,
      lastActivity: now,
      memory: emptyMemory(),
      asked: new Map(),
      ownContextPath,
      contextPath: ownContextPath,
      keeps: false,
      sharedHeard: 0,
      sharedHeardText: "",
      sharedToldAt: 0,
      pending: [],
      starting: false,
      roster: undefined,
      compactedAt: 0,
      toldClosed: false,
      // What was changed before it started is not its doing.
      dirty: new Set(changedPaths(await this.deps.gitStatus(place.root).catch(() => ""))),
      marked: new Set(),
      team: [],
      startedAt: now,
      contextAt: now,
      nudgedAt: 0,
      contextKept: false,
      remindedAtStart: false,
      task: this.deps.taskOf(
        place.workspace,
        place.project,
        [...(thread === undefined ? [] : [thread]), `herdr:${agent}:${sid}`],
        [branch, title],
      ),
      thread,
      threadTries: 1,
      asks: new Map(),
      // What the project already had is no news to it; its start tells it, or Peer restarted.
      boardHeard: new Set(this.writtenScopes(place.workspace, place.project)),
      heard: new Set(),
    };
    // A session Peer meets again (Peer restarted, or the session outlived its TTL) keeps what
    // it shares: reporting it without its lines would take its findings back.
    await this.restoreContext(session);
    this.sessions.set(id, session);
    this.log("session.started", {
      session: id,
      workspace: place.workspace,
      project: place.project,
      root: place.root,
      pane,
      branch: session.branch,
      thread,
      task: session.task,
      transcript: session.transcript,
    });
    return session;
  }

  /** The herdr pane a hook came from: Claude Code's say so; Codex's only when herdr agrees. */
  private paneOf(
    agent: AgentKind,
    body: Record<string, unknown>,
    named: string | undefined,
  ): string | undefined {
    if (agent === "claude") return named;
    return typeof body.cwd === "string" ? this.deps.herdrPane(agent, body.cwd, named) : undefined;
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
    const agent = agentNamed(headerOf(headers, "x-peer-agent"));
    const pane = this.paneOf(agent, body, headerOf(headers, "x-herdr-pane"));
    // A session Peer never saw that ends has nothing to clear.
    if (event === "SessionEnd" && !this.sessions.has(`${agent}:${String(body.session_id)}`))
      return null;
    const session = await this.sessionFor(agent, body, pane);
    if (session === null) return null;
    if (pane !== undefined) session.pane = pane;
    const out = await this.answerHook(event, session, body);
    this.log("hook", {
      session: session.id,
      hookEvent: event,
      tool: body.tool_name,
      files: editedFiles(body.tool_name, body.tool_input),
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
        const source = typeof body.source === "string" ? body.source : "startup";
        const start = await this.startContextFor(session, source);
        const news = this.news(session, { team: false });
        return context(event, news === null ? start : `${start}\n\n${news}`);
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
        session.status = "working";
        if (body.tool_name === "Bash") {
          await this.readShellChanges(session);
          return context(event, this.news(session));
        }
        let file: string | null = null;
        let contextEdited = false;
        for (const path of this.editedPaths(session, body)) {
          if (this.samePath(path, session.ownContextPath)) {
            await this.readTeamLines(session);
            contextEdited = true;
            continue;
          }
          if (session.keeps && this.samePath(path, session.contextPath)) {
            await this.saveShared(session);
            contextEdited = true;
            continue;
          }
          const changed = inRepository(session, path);
          if (changed === null) continue;
          file = changed;
          session.dirty.add(changed);
          session.files = [...session.files.filter((f) => f !== changed), changed].slice(
            -MAX_FILES,
          );
          const asked = session.asked.get(changed);
          if (asked !== undefined) {
            // The edit ran after its person was asked: they approved.
            for (const key of asked) session.memory.acknowledged.add(key);
            session.asked.delete(changed);
            this.log("ask.approved", { session: session.id, file: changed, keys: asked });
          }
          this.markDirty();
        }
        const news = this.news(session);
        if (contextEdited && file === null) return context(event, news);
        const nudge = this.nudge(session, file);
        return context(event, [news, nudge].filter((part) => part !== null).join("\n\n") || null);
      }
      case "Notification": {
        // Waiting for its person's permission: not at work, so it neither keeps nor takes a context.
        const message = typeof body.message === "string" ? body.message : "";
        if (/permission|approv/i.test(message)) {
          session.status = "blocked";
          this.markDirty();
          this.log("session.blocked", { session: session.id, message: clip(message, 200) });
        }
        return null;
      }
      case "PermissionRequest": {
        // Codex asks its person. Peer's own command and the agent's own contexts are Peer's to let
        // through; for anything else the agent waits for its person, so it does not work meanwhile.
        if (this.isPeerWork(session, body)) {
          this.log("permission.allowed", { session: session.id, tool: body.tool_name });
          return {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: "allow" },
            },
          };
        }
        session.status = "blocked";
        this.markDirty();
        this.log("session.blocked", { session: session.id, tool: body.tool_name });
        return null;
      }
      case "Stop":
        session.status = "idle";
        session.lastActivity = Date.now();
        // What it changed in ways Peer's hooks did not see (a patch through the shell) is its too.
        await this.readShellChanges(session);
        this.markDirty();
        return null;
      case "SessionEnd":
        void this.release(session);
        this.sessions.delete(session.id);
        this.log("session.ended", { session: session.id });
        this.markDirty();
        return null;
      default:
        return null;
    }
  }

  /**
   * What a shell command changed: the files git sees changed now and did not
   * before, less those other sessions here changed. Agents edit with sed too.
   */
  private async readShellChanges(session: LocalSession) {
    const now = new Set(changedPaths(await this.deps.gitStatus(session.root).catch(() => "")));
    const others = new Set(
      [...this.sessions.values()]
        .filter((other) => other !== session && other.root === session.root)
        .flatMap((other) => other.files),
    );
    const changed = [...now].filter((path) => !session.dirty.has(path) && !others.has(path));
    session.dirty = now;
    if (changed.length === 0) return;
    session.files = [...session.files.filter((file) => !changed.includes(file)), ...changed].slice(
      -MAX_FILES,
    );
    this.markDirty();
    this.log("files.shell", { session: session.id, files: changed });
  }

  /** The files a tool call edits, absolute: a Codex patch names them from the session's directory. */
  private editedPaths(session: LocalSession, body: Record<string, unknown>): string[] {
    return editedFiles(body.tool_name, body.tool_input).map((path) =>
      NodePath.resolve(session.cwd, path),
    );
  }

  /** Whether two paths are one file, however the agent wrote it (macOS has /var under /private). */
  private samePath(a: string, b: string): boolean {
    return NodePath.resolve(a) === NodePath.resolve(b) || realPath(a) === realPath(b);
  }

  /** The agent's own working context, or the shared context it keeps. */
  private keptBy(session: LocalSession, path: string): boolean {
    return (
      this.samePath(path, session.ownContextPath) ||
      (session.keeps && this.samePath(path, session.contextPath))
    );
  }

  /** A permission Codex asks for that is Peer's own business: its command, or the agent's contexts. */
  private isPeerWork(session: LocalSession, body: Record<string, unknown>): boolean {
    if (body.tool_name === "Bash") {
      const input = body.tool_input as Record<string, unknown> | null;
      const command = typeof input?.command === "string" ? input.command : "";
      return isPlainCliCall(command, this.scripts.peer) || isPlainCliCall(command, this.cli);
    }
    const paths = this.editedPaths(session, body);
    return paths.length > 0 && paths.every((path) => this.keptBy(session, path));
  }

  private async beforeTool(
    session: LocalSession,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    if (body.tool_name === "Bash") return this.beforeShell(session, body);
    const files: string[] = [];
    for (const path of this.editedPaths(session, body)) {
      if (this.keptBy(session, path)) continue;
      const mirror = [...this.shared.values()].find((candidate) =>
        this.samePath(candidate.path, path),
      );
      if (mirror !== undefined) {
        const keeper =
          mirror.keeper === undefined
            ? "another agent"
            : `${this.deps.nameOf(mirror.workspace, mirror.keeper.email)}'s agent`;
        this.log("shared.denied", { session: session.id, scope: mirror.scope });
        const subject = this.subjectOf(mirror.workspace, mirror.project, mirror.scope);
        const ownWork =
          mirror.workspace === session.workspace &&
          mirror.project === session.project &&
          mirror.scope === scopeOf(session.task);
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: ownWork
              ? `Peer: ${keeper} keeps the shared context of ${subject}; the other agents on it only read it. Put what the work should know under "## For the team" in your working context (${session.ownContextPath}); Peer passes it to the keeper.`
              : `Peer: this is the shared context of ${subject}, another work on this project, and ${keeper} keeps it: only its keeper writes it. Read it; if your work depends on it, ask its agents: ${this.cli} ask ${this.handleOf(mirror.workspace, mirror.project, mirror.scope)} "<question>".`,
          },
        };
      }
      const file = inRepository(session, path);
      if (file !== null) files.push(file);
    }
    if (files.length === 0) {
      // Its own contexts only: Claude Code edits them unasked. Codex takes no "allow" without a
      // rewrite, and asks for them through PermissionRequest instead.
      return session.agent === "claude" && this.editedPaths(session, body).length > 0
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "The agent's own working context",
            },
          }
        : this.newsContext("PreToolUse", session);
    }
    // Decide on what the other agents changed just now, not a view from a while ago.
    if (Date.now() - (this.viewAt.get(session.workspace) ?? 0) > FRESH_MS) {
      await this.syncNow(session.workspace, 1500);
    }
    const policy = this.deps.policy();
    let answers = files.map((file) => ({ file, answer: this.decide(session, file, policy) }));
    if (answers.some(({ answer }) => answer.decision === "deny")) {
      // Make each contest an overlap the hub knows, so the agent's note has somewhere to go.
      for (const { file, answer } of answers) {
        if (answer.decision === "deny") {
          session.claims = [...session.claims.filter((c) => c !== file), file];
        }
      }
      this.markDirty();
      await this.syncNow(session.workspace, 1500);
      answers = files.map((file) => ({ file, answer: this.decide(session, file, policy) }));
    }
    const said = answers.filter(
      ({ answer }) => answer.decision !== undefined || answer.context !== undefined,
    );
    if (said.length === 0) return this.newsContext("PreToolUse", session);
    for (const { file, answer } of said) this.settle(session, file, answer, policy);
    const deny = said.find(({ answer }) => answer.decision === "deny")?.answer;
    const ask = said.find(({ answer }) => answer.decision === "ask")?.answer;
    if (deny !== undefined || (ask !== undefined && session.agent === "codex")) {
      const reason =
        deny?.reason ??
        `${ask?.reason ?? ""} Ask your person in your reply before you change it, and change it once they agree.`;
      if (deny === undefined && ask !== undefined) {
        // Codex cannot ask its person before a tool runs: its agent asks, and tries again after.
        for (const key of ask.keys) session.memory.acknowledged.add(key);
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason.trim(),
        },
      };
    }
    if (ask !== undefined) {
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: ask.reason,
        },
      };
    }
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: said.map(({ answer }) => answer.context).join("\n\n"),
      },
    };
  }

  /** What one contested file's answer leaves behind: who heard, what was asked, the log. */
  private settle(
    session: LocalSession,
    file: string,
    answer: EditAnswer,
    policy: PeerCoordinationPolicy,
  ) {
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
  }

  /** The agent running Peer's own CLI: let it, and remember who is about to call. */
  private beforeShell(
    session: LocalSession,
    body: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const input = body.tool_input as Record<string, unknown> | null;
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    const script = this.scripts.peer;
    if (!mentionsCli(command, this.cli) && !command.includes(script)) return null;
    // Whoever runs `peer` next is this session, whatever else the command does.
    this.lastCli = { session: session.id, at: Date.now() };
    // `peer …` is Peer's own coordination command: run its script, without asking.
    const viaName = isPlainCliCall(command, this.cli);
    if (!viaName && !isPlainCliCall(command, script)) {
      // On the session's PATH it still runs; it only is not let through without asking.
      this.log("cli.unplain", { session: session.id, command });
      return null;
    }
    // Codex takes "allow" only with a rewrite, and runs Peer's script past its sandbox only as
    // its rule names it: the script, without what the agent added to trim its output.
    const rewritten =
      session.agent === "codex"
        ? `${script}${withoutOutputTrim(command).slice(viaName ? this.cli.length : script.length)}`
        : viaName
          ? `${script}${command.slice(this.cli.length)}`
          : undefined;
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "Peer coordination",
        ...(rewritten === undefined ? {} : { updatedInput: { ...input, command: rewritten } }),
      },
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
      taskName: this.taskNamer(session.workspace, session.project),
      cli: this.cli,
    });
  }

  private newsContext(event: string, session: LocalSession) {
    const text = this.news(session);
    return text === null
      ? null
      : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  }

  /**
   * What happened on the session's overlaps since it last heard, and (unless
   * `team` is false) what Peer has to tell it, what changed in its work's
   * shared context and what other agents found that concerns it.
   */
  private news(session: LocalSession, options: { readonly team?: boolean } = {}): string | null {
    const news = newsFor({
      me: this.asHub(session),
      view: this.merged(session.workspace, this.views.get(session.workspace)),
      memory: session.memory,
      nameOf: this.nameOf(session.workspace),
      taskName: this.taskNamer(session.workspace, session.project),
      cli: this.cli,
    });
    if (news !== null) {
      for (const id of news.announced) session.memory.announced.add(id);
      for (const id of news.seen) session.memory.seenNotes.add(id);
      this.log("news", {
        session: session.id,
        text: news.text,
        announced: news.announced,
        seen: news.seen,
      });
    }
    const parts = [news?.text ?? null];
    // Findings and shared contexts wait for the agent's next step; they never wake it.
    if (options.team !== false) {
      parts.push(
        ...session.pending.splice(0),
        this.closeNews(session),
        this.rosterNews(session),
        this.sharedNews(session),
        this.findingNews(session),
        this.boardNewsFor(session),
      );
    }
    const said = parts.filter((part) => part !== null);
    return said.length === 0 ? null : said.join("\n\n");
  }

  /** What other agents found: for a keeper, what its work found; for anyone, what names its files. */
  private findingNews(session: LocalSession): string | null {
    const findings = this.findingsOf(session.workspace);
    const parts: string[] = [];
    const delivered: string[] = [];
    if (session.keeps) {
      const onWork = findingsOnWork(this.holder(session), findings, session.heard).slice(0, 8);
      if (onWork.length > 0) {
        parts.push(
          findingsForKeeper({
            subject: this.subjectOf(session.workspace, session.project, scopeOf(session.task)),
            findings: onWork,
            nameOf: this.nameOf(session.workspace),
          }),
        );
        for (const finding of onWork) {
          session.heard.add(finding.id);
          delivered.push(finding.id);
        }
      }
    }
    const team = teamNews({
      me: this.holder(session),
      findings,
      heard: session.heard,
      // Findings on its own work go to whoever keeps the work's shared context, while somebody does.
      sameWork: !session.keeps && this.keeperOf(session) === undefined,
      nameOf: this.nameOf(session.workspace),
      taskName: (task) => this.deps.taskName(session.workspace, session.project, task),
    });
    if (team !== null) {
      parts.push(team.text);
      for (const id of team.ids) {
        session.heard.add(id);
        delivered.push(id);
      }
    }
    if (parts.length === 0) return null;
    const text = parts.join("\n\n");
    this.log("finding.delivered", {
      session: session.id,
      keeps: session.keeps,
      findings: delivered,
      text,
    });
    return text;
  }

  /** Who a session's agent is, as its teammates name it: "Ana's agent". */
  private me(session: LocalSession) {
    const email = this.deps.email();
    return email === null
      ? "your person's agent"
      : `${this.deps.nameOf(session.workspace, email)}'s agent`;
  }

  /** A keeper whose task was closed is asked, once, to mark what the project should keep. */
  private closeNews(session: LocalSession): string | null {
    if (!session.keeps || session.task === undefined || session.toldClosed) return null;
    if (!this.deps.taskDone(session.workspace, session.project, session.task)) return null;
    session.toldClosed = true;
    this.log("shared.closed", { session: session.id, task: session.task });
    return closeOutText(this.deps.taskName(session.workspace, session.project, session.task));
  }

  /** Who joined or left the work a keeper keeps the context of, since it last heard. */
  private rosterNews(session: LocalSession): string | null {
    if (!session.keeps) return null;
    const now = this.agentsOn(session);
    const before = session.roster;
    session.roster = now;
    // Its start, or the handover, said who was there.
    if (before === undefined) return null;
    return rosterChange(before, now);
  }

  /** What changed in the shared context a session reads, at most every few minutes. */
  private sharedNews(session: LocalSession): string | null {
    if (session.keeps) return null;
    const mirror = this.mirrorOf(session);
    if (
      mirror === undefined ||
      mirror.version <= session.sharedHeard ||
      !contextWritten(mirror.text) ||
      Date.now() - session.sharedToldAt < SHARED_NEWS_GAP_MS
    ) {
      return null;
    }
    const text = sharedChange(
      this.sharedOf(mirror),
      session.sharedHeardText,
      mirror.updatedBy === undefined
        ? undefined
        : this.deps.nameOf(mirror.workspace, mirror.updatedBy),
    );
    session.sharedHeard = mirror.version;
    session.sharedHeardText = mirror.text;
    session.sharedToldAt = Date.now();
    this.log("shared.told", {
      session: session.id,
      scope: mirror.scope,
      version: mirror.version,
      text,
    });
    return text;
  }

  private holder(session: LocalSession): ContextHolder {
    return {
      id: session.id,
      project: session.project,
      task: session.task,
      files: session.files,
      claims: session.claims,
    };
  }

  private findingsOf(workspace: string): ReadonlyArray<HubFinding> {
    return this.views.get(workspace)?.findings ?? [];
  }

  // ---- working context (experimental) ----

  /**
   * What a session hears when it starts: how to keep its working context (its
   * own, made now if it has none, or its work's shared one when it keeps that),
   * the context itself after a compaction or a resume, the shared context of its
   * work, and the findings it should hear now.
   */
  private async startContextFor(session: LocalSession, source: string): Promise<string> {
    session.starting = true;
    try {
      return await this.startedContext(session, source);
    } finally {
      session.starting = false;
    }
  }

  private async startedContext(session: LocalSession, source: string): Promise<string> {
    await NodeFSP.mkdir(NodePath.dirname(session.ownContextPath), { recursive: true });
    let saved: string | undefined;
    try {
      saved = await NodeFSP.readFile(session.ownContextPath, "utf8");
      session.contextAt = (await NodeFSP.stat(session.ownContextPath)).mtimeMs;
    } catch {
      await NodeFSP.writeFile(
        session.ownContextPath,
        contextTemplate(
          session.label,
          session.task === undefined
            ? undefined
            : this.deps.taskName(session.workspace, session.project, session.task),
        ),
      );
    }
    session.team = saved === undefined ? [] : teamLines(saved);
    // What the team found, and who keeps the work's shared context, are worth a fresh look now.
    await this.syncNow(session.workspace, 1500);
    await this.takeUp(session);
    // What it would be told at its next step is in what it hears now.
    session.pending.length = 0;
    const mirror = this.mirrorOf(session);
    const onWork = findingsOnWork(
      this.holder(session),
      this.findingsOf(session.workspace),
      session.heard,
    );
    let findings: HubFinding[] = [];
    if (session.keeps) {
      // What was found before the context last changed was there for the last keeper to fold in.
      const since = mirror === undefined || mirror.version === 0 ? 0 : Date.parse(mirror.updatedAt);
      findings = onWork.filter((finding) => Date.parse(finding.at) > since).slice(0, 10);
      for (const finding of onWork) session.heard.add(finding.id);
    } else if (this.keeperOf(session) === undefined) {
      findings = onWork.slice(0, 8);
      for (const finding of findings) session.heard.add(finding.id);
    } else if (mirror !== undefined && contextWritten(mirror.text)) {
      // Kept by another agent: what it has not folded in yet goes along with the context.
      const since = Date.parse(mirror.updatedAt);
      findings = onWork.filter((finding) => Date.parse(finding.at) > since).slice(0, 8);
      for (const finding of findings) session.heard.add(finding.id);
    }
    if (session.keeps) session.roster = this.agentsOn(session);
    if (!session.keeps && mirror !== undefined) {
      // It reads the context now; the first change after this is news at once.
      session.sharedHeard = mirror.version;
      session.sharedHeardText = mirror.text;
      session.sharedToldAt = 0;
    }
    const guidance = await this.deps.projectGuidance(session.root).catch(() => null);
    // The project's other work, and where to read each: what this agent's work may depend on.
    // Its hook waits a few seconds at most: copies still on their way are named by `peer context`.
    await Promise.race([this.mirrorBoard(session.workspace), sleepMs(BOARD_START_WAIT_MS)]);
    const board = this.board(session);
    for (const scope of this.writtenScopes(session.workspace, session.project)) {
      session.boardHeard.add(scope);
    }
    const text = startContext({
      me: this.me(session),
      ...(session.agent === "codex" ? { cliPath: this.scripts.peer } : {}),
      board: boardText(board, this.cli),
      guidance,
      own: {
        path: session.ownContextPath,
        saved: source === "compact" || source === "resume" ? saved : undefined,
      },
      shared: mirror === undefined ? undefined : { ...this.sharedOf(mirror), keeps: session.keeps },
      findings,
      agents: this.agentsOn(session).map((agent) => agent.name),
      nameOf: this.nameOf(session.workspace),
    });
    this.log("context.injected", {
      session: session.id,
      source,
      path: session.contextPath,
      keeps: session.keeps,
      shared: mirror === undefined ? undefined : { scope: mirror.scope, version: mirror.version },
      saved: saved?.length ?? 0,
      findings: findings.map((finding) => finding.id),
      board: board.map((entry) => entry.scope),
      bytes: text.length,
    });
    return text;
  }

  /** What an existing working context already says, read when Peer meets its session. */
  private async restoreContext(session: LocalSession) {
    try {
      const [text, stat] = await Promise.all([
        NodeFSP.readFile(session.ownContextPath, "utf8"),
        NodeFSP.stat(session.ownContextPath),
      ]);
      session.team = teamLines(text);
      session.contextAt = stat.mtimeMs;
      session.contextKept = contextWritten(text);
    } catch {
      // No working context yet: SessionStart makes one.
    }
  }

  /** Working contexts of sessions nobody has touched for a month go. */
  private async forgetOldContexts() {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const walk = async (dir: string): Promise<void> => {
      const entries = await NodeFSP.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.name.endsWith(".md")) {
          const stat = await NodeFSP.stat(path).catch(() => null);
          if (stat !== null && stat.mtimeMs < cutoff) await NodeFSP.rm(path, { force: true });
        }
      }
    };
    await walk(this.deps.contextsDir);
  }

  /** The agent changed its own working context: what it shares with the team may have changed. */
  private async readTeamLines(session: LocalSession) {
    let text: string;
    try {
      text = await NodeFSP.readFile(session.ownContextPath, "utf8");
    } catch {
      return;
    }
    if (!session.keeps) {
      session.contextAt = Date.now();
      session.contextKept = true;
    }
    const team = teamLines(text);
    const changed = team.join("\n") !== session.team.join("\n");
    session.team = team;
    this.log("context.updated", { session: session.id, bytes: text.length, team, changed });
    if (changed) this.markDirty();
  }

  /**
   * A reminder in a line: at an agent's first change while its working context
   * is still empty, and when it has gone stale while the agent works.
   */
  private nudge(session: LocalSession, changed: string | null): string | null {
    const now = Date.now();
    if (changed !== null && !session.contextKept && !session.remindedAtStart) {
      session.remindedAtStart = true;
      this.log("context.nudged", { session: session.id, why: "first change", file: changed });
      return session.keeps
        ? `Peer: you changed ${changed} and the shared context you keep (${session.contextPath}) is still empty. Note there where the work stands and what you found; your teammates' agents read it.`
        : `Peer: you changed ${changed} and your working context (${session.contextPath}) is still empty. Note there what you are doing and what you found; put what your teammates' agents should know under "## For the team".`;
    }
    if (
      now - session.startedAt < NUDGE_MS ||
      now - session.contextAt < NUDGE_MS ||
      now - session.nudgedAt < NUDGE_MS
    ) {
      return null;
    }
    session.nudgedAt = now;
    const minutes = Math.round((now - session.contextAt) / 60_000);
    this.log("context.nudged", { session: session.id, why: "stale", minutes });
    return `Peer: ${session.keeps ? "the shared context you keep" : "your working context"} (${session.contextPath}) has not changed for ${minutes} minutes. Update it if ${session.keeps ? "where the work stands, its findings or the plan" : "your goal, findings or plan"} moved.`;
  }

  // ---- shared contexts of work (experimental) ----

  private sharedKey(workspace: string, project: string, scope: string) {
    return `${workspace}\u0000${project}\u0000${scope}`;
  }

  private mirrorOf(session: LocalSession): SharedMirror | undefined {
    return this.shared.get(
      this.sharedKey(session.workspace, session.project, scopeOf(session.task)),
    );
  }

  /** What a work is called: its task's name, or the project's work outside tasks. */
  private subjectOf(workspace: string, project: string, scope: string) {
    return scope.startsWith("task:")
      ? this.deps.taskName(workspace, project, scope.slice("task:".length))
      : `${project} (work outside tasks)`;
  }

  private sharedOf(mirror: SharedMirror): SharedContext {
    return {
      subject: this.subjectOf(mirror.workspace, mirror.project, mirror.scope),
      path: mirror.path,
      text: mirror.text,
      version: mirror.version,
      keeper:
        mirror.keeper === undefined
          ? undefined
          : this.deps.nameOf(mirror.workspace, mirror.keeper.email),
    };
  }

  /** Who keeps the shared context of a session's work, when it is another session still at work. */
  private keeperOf(session: LocalSession): HubContextKeeper | undefined {
    const keeper = this.mirrorOf(session)?.keeper;
    if (keeper === undefined || keeper.session === session.id) return undefined;
    const atWork = this.merged(session.workspace, this.views.get(session.workspace)).sessions;
    return atWork.some((s) => s.id === keeper.session) ? keeper : undefined;
  }

  /** The other agents at work on the same work, as people name them. */
  private agentsOn(session: LocalSession): WorkAgent[] {
    return this.merged(session.workspace, this.views.get(session.workspace))
      .sessions.filter(
        (s) =>
          s.id !== session.id &&
          s.project === session.project &&
          scopeOf(s.task) === scopeOf(session.task),
      )
      .map((s) => ({
        id: s.id,
        name: `${this.deps.nameOf(session.workspace, s.email)}'s agent ("${s.label}")`,
      }));
  }

  /**
   * Takes in a shared context as the hub has it, in memory and in the file the
   * agents here read: when it is newer than what is here, or with `force`.
   */
  private async mirror(
    workspace: string,
    context: HubContextText,
    force = false,
  ): Promise<SharedMirror> {
    const key = this.sharedKey(workspace, context.project, context.scope);
    const known = this.shared.get(key);
    const mirror: SharedMirror = known ?? {
      workspace,
      project: context.project,
      scope: context.scope,
      path: NodePath.join(
        this.deps.contextsDir,
        safePart(workspace),
        safePart(context.project),
        "shared",
        `${safePart(context.scope)}.md`,
      ),
      version: -1,
      text: "",
      keeper: undefined,
      updatedAt: context.updatedAt,
      updatedBy: undefined,
      updatedSession: undefined,
      restoredFrom: undefined,
      unsent: false,
    };
    this.shared.set(key, mirror);
    mirror.keeper = context.keeper;
    if (!force && context.version <= mirror.version) return mirror;
    // Nobody wrote it yet: its keeper starts from a template, which is not news to anyone.
    const file =
      context.text.trim() === ""
        ? sharedTemplate(this.subjectOf(workspace, context.project, context.scope))
        : context.text;
    mirror.version = context.version;
    mirror.text = file;
    mirror.updatedAt = context.updatedAt;
    mirror.updatedBy = context.updatedBy;
    mirror.updatedSession = context.updatedSession;
    mirror.restoredFrom = context.restoredFrom;
    mirror.unsent = false;
    try {
      await NodeFSP.mkdir(NodePath.dirname(mirror.path), { recursive: true });
      await NodeFSP.writeFile(mirror.path, file);
    } catch (error) {
      this.log("shared.mirror.failed", { path: mirror.path, error: messageOf(error) });
    }
    return mirror;
  }

  /** Asks the hub for the session to keep its work's shared context; otherwise reads it. */
  private async takeUp(session: LocalSession): Promise<void> {
    const scope = scopeOf(session.task);
    let answer: HubContextText | ContextRefusal;
    try {
      answer = await this.deps.keepContext(
        session.workspace,
        session.project,
        scope,
        session.id,
        false,
      );
    } catch (error) {
      this.log("shared.failed", { session: session.id, scope, error: messageOf(error) });
      return;
    }
    if ("refused" in answer) {
      const current =
        answer.refused === "stale"
          ? answer.current
          : await this.deps
              .readContext(session.workspace, session.project, scope)
              .catch(() => null);
      if (current !== null) await this.mirror(session.workspace, current);
      if (session.keeps) await this.read(session);
      this.log("shared.read", {
        session: session.id,
        scope,
        keeper: answer.refused === "kept" ? answer.keeper?.session : undefined,
        version: current?.version,
      });
      return;
    }
    this.keep(session, await this.mirror(session.workspace, answer));
    this.log("shared.kept", { session: session.id, scope, version: answer.version });
  }

  private keep(session: LocalSession, mirror: SharedMirror) {
    session.keeps = true;
    session.contextPath = mirror.path;
    session.sharedHeard = mirror.version;
    session.sharedHeardText = mirror.text;
    session.contextKept = contextWritten(mirror.text);
    session.remindedAtStart = false;
    session.contextAt = Date.now();
    mirror.keeper = {
      session: session.id,
      email: this.deps.email() ?? "",
      environment: this.deps.environment,
      since: new Date().toISOString(),
    };
  }

  /** The session no longer keeps the shared context: its own working context is its own again. */
  private async read(session: LocalSession) {
    session.keeps = false;
    session.contextPath = session.ownContextPath;
    session.contextKept = false;
    await this.restoreContext(session);
  }

  /** Gives up the shared context a session keeps, so the next agent on the work keeps it at once. */
  private async release(session: LocalSession): Promise<void> {
    if (!session.keeps) return;
    session.keeps = false;
    session.contextPath = session.ownContextPath;
    const scope = scopeOf(session.task);
    this.log("shared.released", { session: session.id, scope });
    await this.deps
      .keepContext(session.workspace, session.project, scope, session.id, true)
      .catch((error: unknown) =>
        this.log("shared.release.failed", { session: session.id, scope, error: messageOf(error) }),
      );
  }

  /** When the keeper changed the shared context, the hub gets the new version. */
  private async saveShared(session: LocalSession) {
    const mirror = this.mirrorOf(session);
    if (mirror === undefined) return;
    const text = await NodeFSP.readFile(mirror.path, "utf8").catch(() => null);
    if (text === null || text === mirror.text) return;
    session.contextAt = Date.now();
    session.contextKept = contextWritten(text);
    const before = new Set(projectLines(mirror.text));
    const after = projectLines(text);
    for (const line of after) if (!before.has(line)) session.marked.add(line);
    for (const line of before) if (!after.includes(line)) session.marked.delete(line);
    mirror.text = text;
    if (Buffer.byteLength(text) > SHARED_MAX_BYTES) {
      // The hub would refuse it: the team keeps the last version until the keeper shortens it.
      session.pending.push(
        `Peer: the shared context you keep (${mirror.path}) is over 32 KiB, so your teammates' agents still read version ${mirror.version}. Shorten it to what the work needs; Peer shares it again then.`,
      );
      this.log("shared.too_large", {
        session: session.id,
        scope: mirror.scope,
        bytes: Buffer.byteLength(text),
      });
      return;
    }
    mirror.unsent = true;
    await this.pushShared(session, mirror);
  }

  private async pushShared(session: LocalSession, mirror: SharedMirror) {
    let answer: HubContextText | ContextRefusal;
    try {
      answer = await this.deps.writeContext(
        mirror.workspace,
        mirror.project,
        mirror.scope,
        session.id,
        mirror.version,
        mirror.text,
      );
    } catch (error) {
      // It goes again at the next sync.
      this.log("shared.unsent", {
        session: session.id,
        scope: mirror.scope,
        error: messageOf(error),
      });
      return;
    }
    const subject = this.subjectOf(mirror.workspace, mirror.project, mirror.scope);
    if (!("refused" in answer)) {
      mirror.version = answer.version;
      mirror.updatedAt = answer.updatedAt;
      mirror.updatedBy = answer.updatedBy;
      mirror.updatedSession = answer.updatedSession;
      mirror.restoredFrom = undefined;
      mirror.unsent = false;
      session.sharedHeard = answer.version;
      session.sharedHeardText = mirror.text;
      const bytes = Buffer.byteLength(mirror.text);
      if (bytes < SHARED_COMPACT_BYTES) session.compactedAt = 0;
      else if (bytes >= session.compactedAt + SHARED_COMPACT_STEP) {
        session.compactedAt = bytes;
        session.pending.push(compactionNudge(mirror.path, bytes));
        this.log("shared.compact", { session: session.id, scope: mirror.scope, bytes });
      }
      this.markDirty();
      this.log("shared.written", {
        session: session.id,
        scope: mirror.scope,
        version: answer.version,
        bytes: mirror.text.length,
      });
      this.deps.changed();
      return;
    }
    if (answer.refused === "stale") {
      await this.mirror(mirror.workspace, answer.current, true);
      const by = answer.current.updatedBy;
      session.pending.push(
        `Peer: the shared context of ${subject} changed meanwhile (version ${answer.current.version}${by === undefined ? "" : `, by ${this.deps.nameOf(mirror.workspace, by)}'s agent`}); ${mirror.path} now has that version. Make your change again on top of it.`,
      );
      this.log("shared.stale", {
        session: session.id,
        scope: mirror.scope,
        version: answer.current.version,
      });
      return;
    }
    const current = await this.deps
      .readContext(mirror.workspace, mirror.project, mirror.scope)
      .catch(() => null);
    if (current !== null) await this.mirror(mirror.workspace, current, true);
    else mirror.unsent = false;
    await this.read(session);
    const who =
      answer.keeper === undefined
        ? "Another agent"
        : `${this.deps.nameOf(mirror.workspace, answer.keeper.email)}'s agent`;
    session.pending.push(
      `Peer: ${who} keeps the shared context of ${subject} now, so your last change to it was not shared. Your working context is ${session.ownContextPath} again; put what the work should know under "## For the team" there.`,
    );
    this.log("shared.lost", {
      session: session.id,
      scope: mirror.scope,
      keeper: answer.keeper?.session,
    });
  }

  /**
   * After a view: newer shared contexts are read, a keeper that lost its work's
   * context hears so, one agent here asks to keep a context nobody keeps, and
   * a keeper's unsent change goes again.
   */
  private async followShared(workspace: string) {
    const view = this.views.get(workspace);
    // A hub from before shared contexts lists none.
    if (view?.contexts === undefined) return;
    const works = new Map<string, LocalSession[]>();
    for (const session of this.sessions.values()) {
      if (session.workspace !== workspace) continue;
      const key = this.sharedKey(workspace, session.project, scopeOf(session.task));
      works.set(key, [...(works.get(key) ?? []), session]);
    }
    for (const [key, sessions] of works) {
      const first = sessions[0];
      if (first === undefined) continue;
      const scope = scopeOf(first.task);
      const subject = this.subjectOf(workspace, first.project, scope);
      const listed = view.contexts.find((c) => c.project === first.project && c.scope === scope);
      let mirror = this.shared.get(key);
      if (listed !== undefined && listed.version > (mirror?.version ?? -1)) {
        const known = mirror?.version;
        const current = await this.deps
          .readContext(workspace, first.project, scope)
          .catch(() => null);
        if (current !== null) mirror = await this.mirror(workspace, current);
        // A version its keeper here did not write: a person brought an older one back.
        const keeping = sessions.find((s) => s.keeps);
        if (
          current !== null &&
          mirror !== undefined &&
          keeping !== undefined &&
          known !== undefined &&
          current.updatedSession !== keeping.id
        ) {
          keeping.sharedHeard = current.version;
          keeping.sharedHeardText = mirror.text;
          const who =
            current.updatedBy === undefined
              ? "Someone"
              : this.deps.nameOf(workspace, current.updatedBy);
          keeping.pending.push(
            current.restoredFrom === undefined
              ? `Peer: ${who} changed the shared context you keep (now version ${current.version}); ${mirror.path} has it. Go on from it.`
              : `Peer: ${who} brought version ${current.restoredFrom} of the shared context you keep back (now version ${current.version}); ${mirror.path} has it. Go on from it; what it replaced is version ${known} (\`${this.cli} context ${known}\`).`,
          );
          this.log("shared.replaced", {
            session: keeping.id,
            scope,
            version: current.version,
            restoredFrom: current.restoredFrom,
          });
        }
      }
      if (mirror !== undefined && listed !== undefined) mirror.keeper = listed.keeper;
      for (const session of sessions) {
        if (
          !session.keeps ||
          listed?.keeper === undefined ||
          listed.keeper.session === session.id
        ) {
          continue;
        }
        await this.read(session);
        session.pending.push(
          `Peer: ${this.deps.nameOf(workspace, listed.keeper.email)}'s agent keeps the shared context of ${subject} now. Your working context is ${session.ownContextPath} again; put what the work should know under "## For the team" there.`,
        );
        this.log("shared.lost", { session: session.id, scope, keeper: listed.keeper.session });
      }
      const keeper = sessions.find((s) => s.keeps);
      if (keeper !== undefined) {
        // An unsent change goes again; an edit its hooks did not see (through Bash, say) goes too.
        const kept = this.mirrorOf(keeper);
        if (kept?.unsent === true) await this.pushShared(keeper, kept);
        else await this.saveShared(keeper);
        continue;
      }
      // Like the paper's orchestrator, a keeper is an agent at work: one that stopped reporting, or
      // has been idle a while when an agent here works on its work, gives way.
      const keeperSession =
        listed?.keeper === undefined
          ? undefined
          : view.sessions.find((s) => s.id === listed.keeper?.session);
      const idleFor =
        keeperSession === undefined || keeperSession.status === "working"
          ? 0
          : Date.now() - Date.parse(keeperSession.activeAt ?? keeperSession.seenAt);
      const away =
        keeperSession === undefined ||
        (idleFor > KEEPER_IDLE_MS && sessions.some((s) => s.status === "working"));
      if (listed?.keeper !== undefined && !away) continue;
      if (Date.now() - (this.claimedAt.get(key) ?? 0) < CLAIM_GAP_MS) continue;
      this.claimedAt.set(key, Date.now());
      // The agent most at work here takes it over; one starting takes it up as it starts.
      const next = sessions
        .filter((s) => !s.starting)
        .toSorted(
          (a, b) =>
            Number(b.status === "working") - Number(a.status === "working") ||
            b.lastActivity - a.lastActivity,
        )[0];
      if (next === undefined) continue;
      await this.takeUp(next);
      const kept = this.mirrorOf(next);
      if (!next.keeps || kept === undefined) continue;
      const guidance = await this.deps.projectGuidance(next.root).catch(() => null);
      const before = listed?.keeper;
      const since = kept.version === 0 ? 0 : Date.parse(kept.updatedAt);
      const findings = findingsOnWork(this.holder(next), this.findingsOf(workspace), next.heard);
      for (const finding of findings) next.heard.add(finding.id);
      next.roster = this.agentsOn(next);
      const fresh = findings.filter((finding) => Date.parse(finding.at) > since).slice(0, 10);
      next.pending.push(
        [
          `Peer: you (${this.me(next)}) keep the shared context of ${subject} now${before === undefined ? "" : `; ${this.deps.nameOf(workspace, before.email)}'s agent kept it before${keeperSession === undefined ? "" : ` and has been idle for ${Math.round(idleFor / 60_000)} minutes`}`}. It is your working context from now on: carry over what matters from ${next.ownContextPath}, then keep it current.`,
          keeperSkill(kept.path, subject),
          ...(guidance === null ? [] : [projectGuidanceText(guidance)]),
          contextWritten(kept.text)
            ? `It reads now (version ${kept.version}):\n\n${kept.text.trim().slice(0, 12_000)}`
            : "Nobody has written it yet: Peer started it from a template.",
          ...(next.roster.length === 0
            ? []
            : [`Agents on this work now: ${next.roster.map((agent) => agent.name).join("; ")}.`]),
          ...(fresh.length === 0
            ? []
            : [findingsForKeeper({ subject, findings: fresh, nameOf: this.nameOf(workspace) })]),
        ].join("\n\n"),
      );
      this.log("shared.handed", {
        session: next.id,
        scope,
        from: before?.session,
        version: kept.version,
      });
    }
  }

  /**
   * The task a session works on now: the one its Peer thread or herdr agent was
   * put on, or the one its branch names.
   */
  private taskFor(session: LocalSession) {
    const title = session.pane === undefined ? undefined : this.deps.herdrTitle(session.pane);
    return this.deps.taskOf(
      session.workspace,
      session.project,
      [...(session.thread === undefined ? [] : [session.thread]), `herdr:${session.id}`],
      [session.branch, title],
    );
  }

  /** Looks for a young session's Peer thread again: its session id may be recorded after it starts. */
  private async findThread(session: LocalSession) {
    if (session.thread !== undefined || session.threadTries >= 6) return;
    if (Date.now() - session.startedAt > 3 * 60_000) return;
    session.threadTries += 1;
    const thread = await this.deps
      .threadOf(session.id.slice(session.agent.length + 1))
      .catch(() => undefined);
    if (thread === undefined) return;
    session.thread = thread;
    this.log("session.thread", { session: session.id, thread });
  }

  // ---- the project's other work (after the paper's coexisting contexts) ----

  /** A task as people name it, in a project. */
  private taskNamer(workspace: string, project: string) {
    return (task: string) => this.deps.taskName(workspace, project, task);
  }

  /** What agents type for a work in `peer context` and `peer ask`: its task's key, else its id. */
  private handleOf(workspace: string, project: string, scope: string): string {
    const task = claimedTask(scope);
    if (task === undefined) return "project";
    return this.deps.tasks(workspace, project).find((t) => t.id === task)?.key ?? task;
  }

  /** The work a handle names in a project: a task by its key or id, or `project`. */
  private scopeNamed(workspace: string, project: string, handle: string): string | undefined {
    const wanted = handle.trim().toLowerCase();
    if (wanted === "project") return "project";
    const task = this.deps
      .tasks(workspace, project)
      .find((t) => t.id.toLowerCase() === wanted || t.key?.toLowerCase() === wanted);
    if (task !== undefined) return `task:${task.id}`;
    // A task the hub has a context or agents for that Peer's list of tasks does not have yet.
    const view = this.views.get(workspace);
    const scopes = [
      ...(view?.contexts ?? []).filter((c) => c.project === project).map((c) => c.scope),
      ...(view?.sessions ?? [])
        .filter((s) => s.project === project && s.task !== undefined)
        .map((s) => scopeOf(s.task)),
    ];
    return scopes.find((scope) => claimedTask(scope)?.toLowerCase() === wanted);
  }

  /** An agent at work elsewhere on the project, as the board shows it: whose, and what it does now. */
  private boardAgent(workspace: string, other: HubCoordSession): string {
    const agent =
      other.agent === undefined ? "" : `${AGENT_NAMES[other.agent as AgentKind] ?? other.agent}, `;
    const doing =
      other.status === "working"
        ? "working"
        : other.status === "blocked"
          ? "waiting for its person"
          : `idle ${sinceText(other.activeAt ?? other.seenAt)}`;
    const where = other.environment === this.deps.environment ? "" : ", on another computer";
    return `${this.deps.nameOf(workspace, other.email)}'s agent (${agent}${doing}${where}, ${other.files.length} file(s) changed)`;
  }

  /** The written shared contexts of a project the hub lists, by scope. */
  private writtenScopes(workspace: string, project: string): string[] {
    return (this.views.get(workspace)?.contexts ?? [])
      .filter((c) => c.project === project && c.version > 0)
      .map((c) => c.scope);
  }

  /**
   * The project's other works for an agent on `session`'s: each task (or the
   * work outside tasks) with agents at work on it or a recent shared context,
   * those with agents at work first, then the most recently written.
   */
  private board(session: LocalSession, limit = BOARD_SHOWN): BoardEntry[] {
    const { workspace, project } = session;
    const view = this.views.get(workspace);
    const own = scopeOf(session.task);
    const others = this.merged(workspace, view).sessions.filter(
      (s) => s.project === project && s.id !== session.id,
    );
    const contexts = (view?.contexts ?? []).filter((c) => c.project === project);
    const done = new Set(
      this.deps
        .tasks(workspace, project)
        .filter((t) => t.status === "done")
        .map((t) => `task:${t.id}`),
    );
    const scopes = new Set([
      ...contexts.map((c) => c.scope),
      ...others.map((s) => scopeOf(s.task)),
    ]);
    scopes.delete(own);
    const entries = [...scopes].flatMap((scope) => {
      const context = contexts.find((c) => c.scope === scope);
      const agents = others.filter((s) => scopeOf(s.task) === scope);
      const written = context !== undefined && context.version > 0;
      const recent =
        written && Date.now() - Date.parse(context.updatedAt) < BOARD_DAYS * 24 * 60 * 60 * 1000;
      // A closed task, or one whose context nobody wrote lately, says nothing unless agents work on it.
      if (agents.length === 0 && (done.has(scope) || !recent)) return [];
      const mirror = this.shared.get(this.sharedKey(workspace, project, scope));
      return [
        {
          scope,
          handle: this.handleOf(workspace, project, scope),
          name:
            scope === "project" ? "Work outside tasks" : this.subjectOf(workspace, project, scope),
          agents: agents.map((s) => this.boardAgent(workspace, s)),
          keeper:
            context?.keeper === undefined
              ? undefined
              : `${this.deps.nameOf(workspace, context.keeper.email)}'s agent`,
          version: context?.version,
          gist: context?.gist,
          path: mirror !== undefined && mirror.version > 0 ? mirror.path : undefined,
          working: agents.some((s) => s.status === "working"),
          at: written ? Date.parse(context.updatedAt) : 0,
        },
      ];
    });
    return entries
      .toSorted(
        (a, b) =>
          Number(b.agents.length > 0) - Number(a.agents.length > 0) ||
          Number(b.working) - Number(a.working) ||
          b.at - a.at,
      )
      .slice(0, limit)
      .map(({ working: _working, at: _at, ...entry }) => entry);
  }

  /** Work that showed up on the project since the session last heard: told once, at its next step. */
  private boardNewsFor(session: LocalSession): string | null {
    const fresh = this.board(session, BOARD_ALL)
      .filter((entry) => (entry.version ?? 0) > 0 && !session.boardHeard.has(entry.scope))
      .slice(0, 3);
    if (fresh.length === 0) return null;
    for (const entry of fresh) session.boardHeard.add(entry.scope);
    const text = boardNews(fresh, this.cli);
    this.log("board.told", {
      session: session.id,
      scopes: fresh.map((entry) => entry.scope),
      text,
    });
    return text;
  }

  /** Where another work's shared context is, for an agent that needs it, or null when none is written. */
  private contextPointer(workspace: string, project: string, scope: string): string | null {
    const listed = this.views
      .get(workspace)
      ?.contexts?.find((c) => c.project === project && c.scope === scope);
    if (listed === undefined || listed.version === 0) return null;
    const mirror = this.shared.get(this.sharedKey(workspace, project, scope));
    const keeper =
      listed.keeper === undefined
        ? ""
        : `, kept by ${this.deps.nameOf(workspace, listed.keeper.email)}'s agent`;
    return `Its shared context (version ${listed.version}${keeper}) is in ${mirror !== undefined && mirror.version > 0 ? mirror.path : "the hub"}; ${this.cli} context ${this.handleOf(workspace, project, scope)} prints it.`;
  }

  /**
   * Keeps this computer's copies of the project's other works' shared contexts,
   * which its agents read as files, like the paper's agents read the contexts
   * of the agents beside them. A copy is read again only when the hub has a
   * newer version.
   */
  private mirrorBoard(workspace: string): Promise<void> {
    // One at a time per workspace: a sync and a session's start may both ask.
    const running = this.boardMirroring.get(workspace);
    if (running !== undefined) return running;
    const run = this.copyBoard(workspace).finally(() => this.boardMirroring.delete(workspace));
    this.boardMirroring.set(workspace, run);
    return run;
  }

  private async copyBoard(workspace: string) {
    const view = this.views.get(workspace);
    if (view?.contexts === undefined) return;
    const local = [...this.sessions.values()].filter((s) => s.workspace === workspace);
    for (const project of new Set(local.map((s) => s.project))) {
      // Their own work's context: followShared reads it, and its keeper here writes it.
      const theirs = new Set(
        local.filter((s) => s.project === project).map((s) => scopeOf(s.task)),
      );
      const done = new Set(
        this.deps
          .tasks(workspace, project)
          .filter((t) => t.status === "done")
          .map((t) => `task:${t.id}`),
      );
      const wanted = view.contexts
        .filter(
          (c) =>
            c.project === project &&
            c.version > 0 &&
            !theirs.has(c.scope) &&
            !done.has(c.scope) &&
            Date.now() - Date.parse(c.updatedAt) < BOARD_DAYS * 24 * 60 * 60 * 1000,
        )
        .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, BOARD_MIRRORS);
      const stale = wanted.filter((context) => {
        const known = this.shared.get(this.sharedKey(workspace, project, context.scope));
        return known === undefined || known.version < context.version;
      });
      await Promise.all(
        stale.map(async (context) => {
          const current = await this.deps
            .readContext(workspace, project, context.scope)
            .catch(() => null);
          if (current === null) return;
          await this.mirror(workspace, current);
          this.log("board.mirrored", {
            workspace,
            project,
            scope: context.scope,
            version: current.version,
          });
        }),
      );
    }
  }

  /** `peer ask <task> "<question>"`: a conversation with the agents at work on another task. */
  private async ask(session: LocalSession, handle: string, question: string): Promise<string> {
    const { workspace, project } = session;
    const scope = this.scopeNamed(workspace, project, handle);
    if (scope === undefined) {
      const known = this.board(session, BOARD_ALL).map((entry) => entry.handle);
      return `peer: no task "${handle}" on ${project}.${known.length === 0 ? "" : ` Work on it now: ${known.join(", ")}.`}`;
    }
    const name = this.subjectOf(workspace, project, scope);
    if (scope === scopeOf(session.task)) {
      return `peer: ${name} is your own work. Its agents read its shared context${session.keeps ? ", which you keep" : ""}; ${this.cli} note reaches the agents you share files with.`;
    }
    const task = claimedTask(scope);
    if (task === undefined) {
      return `peer: ask the agents on a task. Agents outside tasks hear you through the files you both change (${this.cli} claim <path>).`;
    }
    await this.syncNow(workspace, 3000);
    const pointer = this.contextPointer(workspace, project, scope);
    const there = this.merged(workspace, this.views.get(workspace)).sessions.filter(
      (s) => s.project === project && s.task === task && s.id !== session.id,
    );
    if (there.length === 0) {
      return `Nobody's agent works on ${name} now, so nobody can answer.${pointer === null ? "" : ` ${pointer}`} If you need its people, tell yours.`;
    }
    const claim = taskClaim(task);
    session.claims = [...session.claims.filter((c) => c !== claim), claim];
    session.asks.set(claim, Date.now());
    this.markDirty();
    await this.syncNow(workspace, 3000);
    const overlaps = (this.views.get(workspace)?.overlaps ?? []).filter(
      (o) => o.project === project && o.sessions.includes(session.id) && o.files.includes(claim),
    );
    if (overlaps.length === 0) {
      session.claims = session.claims.filter((c) => c !== claim);
      session.asks.delete(claim);
      this.markDirty();
      this.log("ask.unopened", { session: session.id, task });
      return `peer: the hub opened no conversation with the agents on ${name}; it may be older than peer ask.${pointer === null ? "" : ` ${pointer}`}`;
    }
    for (const overlap of overlaps) {
      const updated = await this.deps.note(workspace, project, overlap.id, question, session.id);
      this.applyOverlap(workspace, updated);
      this.acknowledge(session, updated);
    }
    this.log("ask", {
      session: session.id,
      task,
      overlaps: overlaps.map((o) => o.id),
      text: question,
    });
    const who = there
      .map(
        (s) =>
          `${this.deps.nameOf(workspace, s.email)}'s agent${s.environment === this.deps.environment ? "" : " (on another computer)"}`,
      )
      .join(", ");
    return `Asked the agents on ${name}: ${who}. They hear it at their next step, or wake up if idle, and their answer reaches you as Peer news (${this.cli} status shows the conversation). Once settled: ${this.cli} resolve "<agreement>".${pointer === null ? "" : ` Meanwhile: ${pointer}`}`;
  }

  /** Questions about a task go when their conversation is settled, or after a while without one. */
  private dropSettledAsks(workspace: string) {
    const overlaps = this.views.get(workspace)?.overlaps ?? [];
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.workspace !== workspace) continue;
      for (const [claim, at] of session.asks) {
        const about = overlaps.filter(
          (o) => o.sessions.includes(session.id) && o.files.includes(claim),
        );
        const settled = about.length > 0 && about.every((o) => o.state === "resolved");
        const unanswered = about.length === 0 && now - at > ASK_SETTLE_MS;
        if (!settled && !unanswered && now - at < ASK_MAX_MS) continue;
        session.asks.delete(claim);
        session.claims = session.claims.filter((c) => c !== claim);
        this.markDirty();
        this.log("ask.dropped", { session: session.id, claim, settled });
      }
    }
  }

  // ---- waking idle agents ----

  private async wait(
    body: Record<string, unknown>,
    headers: NodeHttp.IncomingHttpHeaders,
  ): Promise<string> {
    const agent = agentNamed(headerOf(headers, "x-peer-agent"));
    const session = await this.sessionFor(
      agent,
      body,
      this.paneOf(agent, body, headerOf(headers, "x-herdr-pane")),
    );
    if (session === null) return "";
    // Findings wait for the agent's next step; only a note on an overlap wakes it.
    const ready = this.news(session, { team: false });
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
    this.wakeCodex();
    for (const waiter of this.waiters) {
      const session = this.sessions.get(waiter.session);
      if (session === undefined) {
        this.waiters.delete(waiter);
        waiter.answer("");
        continue;
      }
      // Findings wait for the agent's next step; only a note on an overlap wakes it.
      const text = this.news(session, { team: false });
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
      const session =
        this.sessions.get(explicit) ??
        [...this.sessions.values()].find((s) => s.id === `${s.agent}:${explicit}`);
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
      return "peer: no agent session of yours is known here. Peer coordinates Claude Code and Codex sessions in workspace projects.";
    }
    // Not a sign the agent is at work: its own commands come in a tool call its hooks already
    // reported, and anyone else's (a person's, say) must not cancel its wait for a note.
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
        const board = this.board(session, BOARD_ALL);
        const out = statusText({
          me: this.asHub(session),
          view: view(),
          nameOf: this.nameOf(session.workspace),
          taskName: this.taskNamer(session.workspace, session.project),
          board,
          cli: this.cli,
        });
        this.markSeen(session);
        for (const entry of board)
          if ((entry.version ?? 0) > 0) session.boardHeard.add(entry.scope);
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
          : `Claimed ${claimed.join(", ")}. Already there: ${others.map((s) => describe(s, this.nameOf(session.workspace), this.taskNamer(session.workspace, session.project))).join("; ")}. ${this.cli} status shows the overlap.`;
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
      case "context": {
        // `peer context [<task>] [history|<version>]`: its own work's, or another work's.
        const first = plain[0];
        const own = first === undefined || first === "history" || /^\d+$/.test(first);
        const scope = own
          ? scopeOf(session.task)
          : this.scopeNamed(session.workspace, session.project, first);
        if (scope === undefined) {
          return `peer: no task "${first}" on ${session.project}. ${this.cli} status lists the work on it.`;
        }
        return this.contextCli(session, scope, own ? first : plain[1]);
      }
      case "ask": {
        const [handle, ...rest] = plain;
        const question = clip(rest.join(" "), 600);
        if (handle === undefined || question === "") {
          return `peer: say which task and what to ask, e.g. ${this.cli} ask VL1 "Where do you keep the speaker names?"`;
        }
        return this.ask(session, handle, question);
      }
      default:
        return this.help();
    }
  }

  /** `peer context`: a work's shared context (the caller's own by default), its kept versions, or one of them. */
  private async contextCli(
    session: LocalSession,
    scope: string,
    which: string | undefined,
  ): Promise<string> {
    const subject = this.subjectOf(session.workspace, session.project, scope);
    const who = (
      by: string | undefined,
      agent: string | undefined,
      restored: number | undefined,
    ) =>
      by === undefined
        ? "someone"
        : agent === undefined && restored !== undefined
          ? `${this.deps.nameOf(session.workspace, by)}, bringing back ${restored}`
          : `${this.deps.nameOf(session.workspace, by)}'s agent`;
    if (which === "history") {
      const versions = await this.deps
        .contextVersions(session.workspace, session.project, scope)
        .catch(() => null);
      if (versions === null) return "peer: the hub cannot be reached now.";
      if (versions.length === 0)
        return `peer: the shared context of ${subject} has no versions yet.`;
      return [
        `Versions of the shared context of ${subject}, newest first (${this.cli} context <version> reads one):`,
        ...versions.map(
          (v) =>
            `  ${v.version}  ${v.at.slice(0, 16).replace("T", " ")}  ${who(v.by, v.session, v.restoredFrom)}  +${v.added} -${v.dropped}`,
        ),
      ].join("\n");
    }
    if (which !== undefined) {
      const number = Number(which);
      if (!Number.isInteger(number) || number < 1) {
        return `peer: say which version, e.g. ${this.cli} context 7, or ${this.cli} context history.`;
      }
      const version = await this.deps
        .readContextVersion(session.workspace, session.project, scope, number)
        .catch(() => null);
      if (version === null) {
        return `peer: version ${number} of the shared context of ${subject} is not kept. ${this.cli} context history lists the versions that are.`;
      }
      return [
        `Version ${version.version} of the shared context of ${subject}, by ${who(version.by, version.session, version.restoredFrom)}, ${version.at.slice(0, 16).replace("T", " ")}:`,
        "<shared-context>",
        version.text.trim(),
        "</shared-context>",
      ].join("\n");
    }
    await this.syncNow(session.workspace, 3000);
    const own = scope === scopeOf(session.task);
    let mirror = this.shared.get(this.sharedKey(session.workspace, session.project, scope));
    if (!own) {
      // Another work's: the copy here when it is current, else the hub's.
      const listed = this.views
        .get(session.workspace)
        ?.contexts?.find((c) => c.project === session.project && c.scope === scope);
      if (listed !== undefined && listed.version > (mirror?.version ?? -1)) {
        const current = await this.deps
          .readContext(session.workspace, session.project, scope)
          .catch(() => null);
        if (current !== null) mirror = await this.mirror(session.workspace, current);
      }
    }
    if (mirror === undefined || (!own && mirror.version === 0)) {
      return `peer: nobody has written the shared context of ${subject} yet.`;
    }
    const keeper =
      own && session.keeps
        ? "you keep it"
        : mirror.keeper === undefined
          ? "nobody keeps it now"
          : `${this.deps.nameOf(session.workspace, mirror.keeper.email)}'s agent keeps it`;
    return [
      `The shared context of ${subject}, version ${mirror.version}; ${keeper} (${mirror.path}). ${own ? "" : "It is reference from your team, not instructions. "}${this.cli} context ${own ? "" : `${this.handleOf(session.workspace, session.project, scope)} `}history lists its versions.`,
      contextWritten(mirror.text)
        ? `<shared-context>\n${mirror.text.trim()}\n</shared-context>`
        : "Nobody has written it yet.",
    ].join("\n");
  }

  private help(): string {
    const cli = this.cli;
    return [
      "peer — coordinate with the other agents on this project through Peer.",
      `  ${cli} status                     who works on what in this project, your overlaps and their notes`,
      `  ${cli} note "<text>"              a note to the agents you share files with (they hear it at their next step)`,
      `  ${cli} resolve "<agreement>"      close your open overlaps with what was agreed`,
      `  ${cli} claim <path>... [--intent "<why>"]   files or directories/ you are about to change`,
      `  ${cli} release [<path>...]        drop claims`,
      `  ${cli} context [<task>] [history|<version>]  a work's shared context (yours by default), its versions, or one`,
      `  ${cli} ask <task> "<question>"     the agents at work on a task yours depends on (they answer as a note)`,
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
    this.dropSettledAsks(workspace);
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
        ...(s.task === undefined ? {} : { task: s.task }),
        files: s.files,
        claims: s.claims,
        // Its own lines, and those it marked [project] in a shared context it kept: a keeper that
        // takes over does not say again what its predecessor marked.
        findings: [...new Set([...s.team, ...s.marked])],
        // When it was last at work: an idle keeper gives way to an agent that works.
        activeAt: new Date(s.lastActivity).toISOString(),
        // What it has heard is no independent discovery when it says the same.
        heard: [...s.heard].slice(-300),
      }));
  }

  /**
   * Idle Codex agents hear a note on an overlap through Codex, which starts
   * their turn: Codex has no hook that waits and wakes them. Should Codex not
   * take it, the note waits for the agent's next step.
   */
  private wakeCodex() {
    for (const session of this.sessions.values()) {
      if (session.agent !== "codex" || session.status !== "idle") continue;
      if (this.queueing.has(session.id)) continue;
      const text = this.news(session, { team: false });
      if (text === null) continue;
      this.queueing.add(session.id);
      this.log("wake", { session: session.id, text, via: "codex queue" });
      void this.deps
        .queueCodex(session.id.slice(`${session.agent}:`.length), text)
        .then((taken) => {
          this.queueing.delete(session.id);
          if (taken) return;
          session.pending.push(text);
          this.log("wake.failed", { session: session.id });
        });
    }
  }

  /** The agent session most recently active in a herdr pane, as its hooks reported it. */
  sessionInPane(
    pane: string,
  ): { readonly id: string; readonly path: string | undefined } | undefined {
    let latest: LocalSession | undefined;
    for (const session of this.sessions.values()) {
      if (session.pane !== pane) continue;
      if (latest === undefined || session.lastActivity > latest.lastActivity) latest = session;
    }
    return latest === undefined
      ? undefined
      : { id: latest.id.slice(latest.agent.length + 1), path: latest.transcript };
  }

  /** The hub says a workspace's coordination changed: read it within a moment. */
  hubChanged(): void {
    this.dirtySince ??= Date.now();
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
          void this.release(session);
          this.sessions.delete(id);
          this.log("session.expired", { session: id });
          continue;
        }
        await this.findThread(session);
        // Put on another task (or taken off one): its work, and the shared context with it, change.
        const task = this.taskFor(session);
        if (task !== session.task) {
          await this.release(session);
          this.log("session.task", { session: id, from: session.task, to: task });
          session.task = task;
          session.sharedHeard = 0;
          session.sharedHeardText = "";
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
          await this.followShared(workspace);
          await this.mirrorBoard(workspace);
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
