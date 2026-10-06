// @effect-diagnostics nodeBuiltinImport:off cryptoRandomUUID:off globalTimers:off globalDate:off preferSchemaOverJson:off - a local socket for agents' hooks and CLI, durable runtime generations, debounced syncs, wall-clock TTLs, and a JSON-lines log for experiments.
/**
 * CoordinationBroker — the local end of coordination. Agents' hooks and the
 * `peer` CLI talk to it over a Unix socket only this user can open. It keeps
 * the agent sessions of this computer and reports them to the hub. Before an
 * agent changes a file the hub decides, recording its claim and the overlaps
 * in the same step, so the first edits of one file on two computers cannot
 * both pass; within its deadline, or by an explicit fallback. A hub without
 * that leaves the decision to the last view, as it was. Every event goes to
 * a JSON-lines log, so a run can be read back exactly.
 *
 * @module peerHub/coordinationBroker
 */
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { runtimeStillPresent } from "./workLifecycle.ts";
import { publishesWork } from "./handoffCommands.ts";

import type {
  PeerCoordinationPolicy,
  PeerProjectPolicy,
  PeerWorkStatus,
  PeerWorkThread,
  PeerContextRead,
  PeerStaleReads,
  PeerCoordEvent,
} from "@t3tools/contracts";
import type { PeerMemoryMode } from "@t3tools/contracts";
import type { MemorySession } from "./memory/MemoryService.ts";

/** Domain operations; the broker only binds them to a confirmed local runtime. */
export interface BrokerMemory {
  readonly prepare: (
    session: MemorySession,
    source: string,
  ) => Promise<{
    readonly mode: PeerMemoryMode;
    readonly currentPath: string;
    readonly notice: string;
  }>;
  readonly notice: (session: MemorySession) => Promise<string>;
  readonly cli: (
    session: MemorySession,
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<string>;
  readonly checkpoint: (session: MemorySession, reason: string) => Promise<unknown>;
  readonly end: (session: MemorySession) => Promise<void>;
  readonly legacySnapshot: (session: MemorySession, text: string, source: string) => Promise<void>;
}

import {
  AGENT_NAMES,
  INTENT_MAX_PATHS,
  agentNamed,
  announcementKey,
  answerForVerdict,
  boardNews,
  changedPaths,
  claimedTask,
  closerOf,
  closeOutText,
  contestKey,
  contextTemplate,
  contextWritten,
  coordinationScripts,
  decideEdit,
  describe,
  editHookAnswer,
  editedFiles,
  emptyMemory,
  compactionNudge,
  findingsForKeeper,
  findingsOnWork,
  generatedFile,
  isPlainCliCall,
  mentionsCli,
  newsFor,
  policyWithoutHub,
  projectLines,
  repositoryPath,
  rosterChange,
  type AgentKind,
  type EditAnswer,
  scopeOf,
  sharedChange,
  sharedTemplate,
  settleAskedAt,
  settleNudge,
  settleRequest,
  shortId,
  startContext,
  statusText,
  taskClaim,
  teamLines,
  withoutOutputTrim,
  teamNews,
  touches,
  unverifiedAnswer,
  type BoardEntry,
  type ContextHolder,
  type CoordinationView,
  type SessionMemory,
  type SharedContext,
  type WorkAgent,
} from "./coordination.ts";
import {
  FIND_ENTRIES,
  FIND_WORKS,
  contextLines,
  findPrompt,
  findRefusal,
  modelEnabled,
  parseFound,
  runModel,
  type FindEntry,
  type FindWork,
} from "./findModel.ts";
import { projectAcceptsPersonal, readHubPolicyState } from "./hubPolicy.ts";
import {
  entryText,
  governing,
  governingText,
  known,
  knowledgeIndexText,
  knowledgeLine,
  readKnowledge,
  searchKnowledge,
  standing,
  type Known,
} from "./knowledgeIndex.ts";
import { askedByPerson, cutText, neutral, plural } from "./peerText.ts";
import {
  ASK_GIST_SHOWN,
  ASK_INDEX_SHOWN,
  INDEX_ALL,
  INDEX_SHOWN,
  KNOWLEDGE_SHOWN,
  askIndexText,
  askReminderText,
  followedChange,
  gistKey,
  indexText,
} from "./teamIndex.ts";
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
  HubIntentAnswer,
  HubIntentRequest,
  HubOverlap,
  HubUnsupported,
  ReportedSession,
} from "./hubApi.ts";

export interface CheckoutPlace {
  readonly workspace: string;
  readonly project: string;
  /** The repository's working tree the agent is in. */
  readonly root: string;
  readonly repositoryId?: string;
}

export interface BrokerDeps {
  readonly memory?: BrokerMemory;
  /** Confirmed runtime state; undefined leaves hook activity as the bounded fallback lease. */
  readonly runtimeStatus?: (
    session: string,
    thread: string | undefined,
    pane: string | undefined,
  ) => PeerWorkStatus | null | undefined;
  /** Durable unfinished work, including sessions no longer available to answer an ask. */
  readonly work?: (workspace: string, project: string) => ReadonlyArray<PeerWorkThread>;
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
  readonly wakeRuntime?: (
    session: string,
    pane: string | undefined,
    text: string,
  ) => Promise<{
    readonly status: "queued" | "uncertain" | "unavailable";
    readonly reason?: string;
  }>;
  readonly nameOf: (workspace: string, email: string) => string;
  readonly email: () => string | null;
  readonly policy: () => PeerCoordinationPolicy;
  readonly report: (
    workspace: string,
    sessions: ReadonlyArray<ReportedSession>,
  ) => Promise<HubCoordView>;
  readonly view: (workspace: string) => Promise<HubCoordView>;
  /** `op` names the command: the hub adds no second note for the same one. */
  readonly note: (
    workspace: string,
    project: string,
    overlap: string,
    text: string,
    session: string | undefined,
    op?: string,
  ) => Promise<HubOverlap>;
  readonly resolve: (
    workspace: string,
    project: string,
    overlap: string,
    resolution: string,
    session: string | undefined,
    op?: string,
  ) => Promise<HubOverlap>;
  /**
   * Asks the hub to decide an agent's intent to change files, and answers within `timeoutMs` or
   * fails: its verdict on each path (it registered the session as their holder in the same step),
   * or that this hub has no such thing. Absent: as a hub without it.
   */
  readonly intent?: (
    workspace: string,
    project: string,
    request: HubIntentRequest,
    timeoutMs: number,
  ) => Promise<HubIntentAnswer | HubUnsupported>;
  /** A session acknowledges an overlap; the overlap as the hub has it, or that this hub has no such thing. */
  readonly ack?: (
    workspace: string,
    project: string,
    overlap: string,
    session: string,
    op: string,
    filesAt?: string,
  ) => Promise<HubOverlap | HubUnsupported>;
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
  readonly contextRead?: (
    workspace: string,
    project: string,
    scope: string,
    session: string,
    version: number,
    op: string,
  ) => Promise<PeerContextRead>;
  readonly staleReads?: (
    workspace: string,
    project: string,
    session: string,
  ) => Promise<PeerStaleReads>;
  readonly coordEvents?: (
    workspace: string,
    project: string,
    filter: { readonly task?: string; readonly path?: string; readonly limit?: number },
  ) => Promise<ReadonlyArray<PeerCoordEvent>>;
  /** Asks for a session to keep a shared context, or gives it up (`release`). */
  readonly keepContext: (
    workspace: string,
    project: string,
    scope: string,
    session: string,
    release: boolean,
    epoch?: number,
    op?: string,
  ) => Promise<HubContextText | ContextRefusal>;
  readonly finishTask?: (
    workspace: string,
    project: string,
    task: string,
    session: string,
    status: "review" | "done",
    op: string,
  ) => Promise<unknown>;
  /** A new version of a shared context from the session that keeps it. */
  readonly writeContext: (
    workspace: string,
    project: string,
    scope: string,
    session: string,
    baseVersion: number,
    text: string,
    epoch?: number,
    op?: string,
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
  runtimeGeneration: string;
  readonly repositoryId: string | undefined;
  memoryMode: PeerMemoryMode;
  memoryNotice: string;
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
  lastPresent?: number;
  readonly memory: SessionMemory;
  /** Files whose edit its person was asked about, with what an approval settles: the edit happening means they approved. */
  readonly asked: Map<
    string,
    {
      readonly keys: ReadonlyArray<string>;
      readonly overlaps: ReadonlyArray<string>;
      readonly filesAt: ReadonlyMap<string, string | undefined>;
    }
  >;
  /** The file the agent keeps its own working context in. */
  ownContextPath: string;
  readonly legacyOwnContextPath: string;
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
  /** Git said what was changed before the session started (a big repository may take longer than a hook waits). */
  dirtyKnown: boolean;
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
  /** Overlaps it closes that it was asked to settle once they went quiet: how often, and at which note. */
  readonly settleNudges: Map<string, number>;
  readonly settleHeard: Set<string>;
  /** Findings of other agents it has heard. */
  readonly heard: Set<string>;
  /** The other works whose shared context it read (`peer context`): what it read, to tell it when that changes. */
  readonly read: Map<string, ReadWork>;
  /** The files it changes or is about to, as far as Peer saw: what the project's `.ai` may govern. */
  readonly touching: Set<string>;
  /** What was checked against `.ai` last: nothing new to check, nothing to say. */
  governsChecked: number;
  governsBook: ReadonlyArray<Known> | undefined;
  /** The entries of the project's `.ai` it was told of or read (ids). */
  readonly knowledgeTold: Set<string>;
  /**
   * What the agent was told of each other work (`gistKey`), since its session started or its
   * context was compacted: it is not told twice, only what changed. And when an ask last carried
   * something, so a pause can be told from a flow of asks.
   */
  readonly told: Map<string, string>;
  askIndexAt: number;
  /** What Peer added to its context, in characters, by the hook that carried it. */
  readonly injected: Map<string, number>;
  modAt?: number;
  readonly modHandled: Map<string, number>;
  readonly deliveries: Map<
    string,
    { readonly text: string; readonly event: string; acknowledged: boolean }
  >;
  /** When a model last looked for it (`peer find`), and how often over the last hour. */
  findAt: number;
  readonly findTimes: number[];
  /** What it did with the team's work and knowledge, newest last: people see it in Peer. */
  readonly advice: Advice[];
}

/** A shared context as this computer has it: in memory, and in a file its agents read. */
interface SharedMirror {
  readonly workspace: string;
  readonly project: string;
  readonly scope: string;
  readonly path: string;
  version: number;
  epoch?: number | undefined;
  text: string;
  keeper: HubContextKeeper | undefined;
  updatedAt: string;
  updatedBy: string | undefined;
  /** The agent session that wrote it; none when a person brought an older version back. */
  updatedSession: string | undefined;
  restoredFrom: number | undefined;
  /** Its keeper here changed it and the hub has not taken the change yet. */
  unsent: boolean;
  /** The write to the hub in flight: the next waits for it, so none is mistaken for another's. */
  pushing: Promise<void> | undefined;
}

/** A work's context as an agent read it, to tell it what changed there since. */
interface ReadWork {
  version: number;
  text: string;
  /** When it was last told of a change, or read it. */
  toldAt: number;
}

/** What an agent did with the team's work and knowledge, or what Peer noted, for people to see in Peer. */
interface Advice {
  readonly about: "work" | "knowledge";
  /** A work's scope, or `kx:<entry id>`. */
  readonly scope: string;
  readonly name: string;
  /** The agent read it, asked its agents, a model found it for it, or an entry governs files it changes. */
  readonly how: "read" | "asked" | "found" | "governs";
  readonly why: string;
  readonly entryKind?: string;
  readonly path?: string;
  readonly at: number;
}

/** Another work on a project as an agent could hear of it: its board entry and what it says of itself. */
interface WorkRow {
  readonly entry: BoardEntry;
  /** What its agents were asked and say they do. */
  readonly labels: ReadonlyArray<string>;
  readonly text: string | undefined;
  readonly updatedAt: number | undefined;
  readonly active: boolean;
  readonly working: boolean;
}

interface Waiter {
  readonly session: string;
  readonly since: number;
  readonly answer: (text: string) => void;
}

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
/**
 * An open overlap both agents wrote on and that went quiet this long is the
 * closing agent's to close: two minutes, or `PEER_SETTLE_QUIET_MS` (the lab
 * shortens it). It hears so at most `SETTLE_NUDGES` times per overlap.
 */
const SETTLE_QUIET_MS = Number(process.env.PEER_SETTLE_QUIET_MS) || 2 * 60 * 1000;
const SETTLE_NUDGES = 2;
/**
 * A hook's script waits 4 s for Peer and then goes on silently, and Claude Code stops waiting
 * for the script after 5: what Peer has not got ready by this time goes to the agent's next step
 * instead of being lost with the answer.
 */
const HOOK_DEADLINE_MS = 3300;
/**
 * How long the hub has to decide an edit (`intent`) before the explicit fallback applies. Well
 * inside `HOOK_DEADLINE_MS`, so the answer still reaches the script that waits for it.
 */
const INTENT_DEADLINE_MS = 2000;
/** Of which a session the hub has not heard of yet is reported first. */
const INTENT_REPORT_MS = 800;
/** A hub that answered 404 or 405 to `intent` is taken to have no such thing for this long. */
const INTENT_LEGACY_MS = 10 * 60 * 1000;
/** How long a hook waits for git to say what changed: a hook must not wait on a big repository. */
const GIT_STATUS_MS = 1500;
/** A repository's `.ai` is read again after this long (`PEER_KNOWLEDGE_FRESH_MS`); a hook waits for the read this long at most. */
const KNOWLEDGE_FRESH_MS = Number(process.env.PEER_KNOWLEDGE_FRESH_MS) || 60_000;
const KNOWLEDGE_READ_WAIT_MS = 400;
/**
 * How often an agent hears that a context it read was written again (`PEER_FOLLOW_GAP_MS`, which the
 * lab shortens), and how long a pause must be before an ask that has nothing new in it is reminded
 * of the others' work (`PEER_ASK_REMIND_MS`).
 */
const FOLLOW_GAP_MS = Number(process.env.PEER_FOLLOW_GAP_MS) || 2 * 60 * 1000;
const ASK_REMIND_MS = Number(process.env.PEER_ASK_REMIND_MS) || 10 * 60 * 1000;
/** How many contexts an agent is told of changes in, and files it is checked against `.ai` for. */
const READ_KEPT = 12;
const TOUCHING_KEPT = 100;

const clip = (text: string, max: number) => cutText(text.replace(/\s+/g, " ").trim(), max);

/** What a hook's answer puts into the agent's context, in characters: its text, and the reason of a refusal. */
function injectedChars(out: Record<string, unknown> | null): number {
  const answer = out?.hookSpecificOutput as
    | {
        readonly additionalContext?: unknown;
        readonly permissionDecision?: unknown;
        readonly permissionDecisionReason?: unknown;
      }
    | undefined;
  const text = typeof answer?.additionalContext === "string" ? answer.additionalContext.length : 0;
  const reason =
    answer?.permissionDecision === "deny" && typeof answer.permissionDecisionReason === "string"
      ? answer.permissionDecisionReason.length
      : 0;
  return text + reason;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TIMED_OUT = Symbol("timed out");

/** What `promise` gives, or `TIMED_OUT` when it does not settle within `ms`; what it does later is nobody's concern. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  // A failure that comes after the deadline must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

const chunks = <T>(items: ReadonlyArray<T>, size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, at) =>
    items.slice(at * size, (at + 1) * size),
  );

/** Names one command to the hub, so that repeating it (a retry) has no further effect. */
const newOp = () => NodeCrypto.randomBytes(12).toString("hex");

const isDecided = (answer: HubIntentAnswer | HubUnsupported): answer is HubIntentAnswer =>
  !("unsupported" in answer);

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
  private readonly creatingSessions = new Map<string, Promise<LocalSession | null>>();
  private server: NodeHttp.Server | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly sessions = new Map<string, LocalSession>();
  private readonly views = new Map<string, HubCoordView>();
  private readonly viewAt = new Map<string, number>();
  private readonly reported = new Set<string>();
  /** The sessions of this computer each workspace's hub last heard in a report. */
  private readonly reportedSessions = new Map<string, ReadonlySet<string>>();
  /**
   * Where the hub answered 404 or 405 to `intent` (a hub without it), until when (epoch ms): each edit
   * would pay a 404 to learn it again. By project: a hub that has it answers 404 for a project it
   * does not know, which must not stop the workspace's other projects from asking.
   */
  private readonly intentUnsupportedUntil = new Map<string, number>();
  private readonly intentLegacyLogged = new Set<string>();
  private readonly announcedToPeople = new Set<string>();
  private readonly waiters = new Set<Waiter>();
  /** Codex sessions Peer is handing a note to through Codex now. */
  private readonly queueing = new Set<string>();
  /** Copies of the project's other works' contexts being made, per workspace. */
  private readonly boardMirroring = new Map<string, Promise<void>>();
  /** What each repository's `.ai` holds, read at most once a minute, by the repository's root. */
  private readonly knowledge = new Map<
    string,
    {
      readonly at: number;
      readonly book: ReadonlyArray<Known>;
      readonly reading: Promise<void> | undefined;
    }
  >();
  /** Models looking for agents now on this computer (`peer find`), and a way to stop them with the broker. */
  private findsRunning = 0;
  private readonly modelAbort = new AbortController();
  /** The `git status` runs in flight, by repository. */
  private readonly gitRuns = new Map<string, Promise<string>>();
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
    this.modelAbort.abort();
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
    readonly overlaps: ReadonlyArray<
      HubOverlap & {
        readonly workspace: string;
        /** The agent session that closes it once its agents agree. */
        readonly closer: string | undefined;
        /** When a person asked its agents to settle it, unless an agent wrote since. */
        readonly askedAt: string | undefined;
      }
    >;
    readonly findings: ReadonlyArray<HubFinding & { readonly workspace: string }>;
    readonly contexts: ReadonlyArray<HubContext & { readonly workspace: string }>;
    /** What Peer told this computer's agents, newest first. */
    readonly advice: ReadonlyArray<
      Omit<Advice, "at"> & {
        readonly workspace: string;
        readonly project: string;
        readonly session: string;
        readonly at: string;
      }
    >;
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
    const advice = [...this.sessions.values()]
      .flatMap((session) =>
        session.advice.map((entry) => ({
          ...entry,
          workspace: session.workspace,
          project: session.project,
          session: session.id,
          at: new Date(entry.at).toISOString(),
        })),
      )
      .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, 100);
    for (const [workspace, view] of this.views) {
      const merged = this.merged(workspace, view);
      for (const session of merged.sessions) {
        sessions.push({ ...session, workspace, local: this.sessions.has(session.id) });
      }
      for (const overlap of view.overlaps) {
        overlaps.push({
          ...overlap,
          workspace,
          closer: closerOf(overlap, merged.sessions),
          askedAt: settleAskedAt(overlap.notes),
        });
      }
      for (const finding of view.findings ?? []) findings.push({ ...finding, workspace });
      for (const context of view.contexts ?? []) contexts.push({ ...context, workspace });
      for (const waiting of view.candidates ?? []) candidates.push({ ...waiting, workspace });
    }
    return { sessions, overlaps, findings, contexts, advice, candidates };
  }

  /** A person's note on an overlap, from Peer. */
  async personNote(workspace: string, project: string, overlap: string, text: string) {
    const updated = await this.deps.note(workspace, project, overlap, text, undefined, newOp());
    this.log("note.person", { workspace, project, overlap, text });
    this.applyOverlap(workspace, updated);
  }

  async personResolve(workspace: string, project: string, overlap: string, resolution: string) {
    const updated = await this.deps.resolve(
      workspace,
      project,
      overlap,
      resolution,
      undefined,
      newOp(),
    );
    this.log("resolve.person", { workspace, project, overlap, resolution });
    this.applyOverlap(workspace, updated);
  }

  /**
   * A person asks the agents on an overlap to settle it between them: both
   * hear it as a note (an idle one wakes up), with the one that closes it named
   * and what the person adds.
   */
  async personSettle(
    workspace: string,
    project: string,
    overlapId: string,
    message: string | undefined,
  ) {
    await this.syncNow(workspace, 3000);
    const view = this.merged(workspace, this.views.get(workspace));
    const overlap = view.overlaps.find((o) => o.id === overlapId);
    const closerId = overlap === undefined ? undefined : closerOf(overlap, view.sessions);
    const closer = view.sessions.find((s) => s.id === closerId);
    const text = settleRequest({
      closer: closer === undefined ? undefined : this.agentName(workspace, closer),
      message: message === undefined ? undefined : clip(message, 300),
      cli: this.cli,
    });
    const updated = await this.deps.note(workspace, project, overlapId, text, undefined, newOp());
    this.log("settle.person", { workspace, project, overlap: overlapId, closer: closerId, text });
    this.applyOverlap(workspace, updated);
  }

  /** An agent as people tell it apart: whose, and on which task. */
  private agentName(workspace: string, session: HubCoordSession): string {
    const name = `${this.deps.nameOf(workspace, session.email)}'s agent`;
    return session.task === undefined
      ? name
      : `${name} on ${this.deps.taskName(workspace, session.project, session.task)}`;
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
      runtimeGeneration: session.runtimeGeneration,
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

  private memoryDescriptor(session: LocalSession): MemorySession {
    return {
      workspace: session.workspace,
      project: session.project,
      sessionId: session.id,
      environmentId: this.deps.environment,
      runtimeGeneration: session.runtimeGeneration,
      workId: session.thread ?? (session.pane === undefined ? session.id : `herdr:${session.pane}`),
      ...(session.task === undefined ? {} : { taskId: session.task }),
      ...(session.repositoryId === undefined ? {} : { repositoryId: session.repositoryId }),
      adapter: session.agent,
      root: session.root,
    };
  }
  private applyMemoryMode(session: LocalSession, mode: PeerMemoryMode, currentPath: string) {
    session.memoryMode = mode;
    session.ownContextPath = mode === "memory" ? currentPath : session.legacyOwnContextPath;
    session.contextPath =
      mode === "memory" || !session.keeps
        ? session.ownContextPath
        : (this.mirrorOf(session)?.path ?? session.ownContextPath);
    if (mode === "memory") {
      session.team = [];
      session.marked.clear();
    }
  }

  /** MCP binds its caller to this known runtime; it cannot supply another actor. */
  memorySession(nativeSessionId: string): MemorySession | undefined {
    const matches = [...this.sessions.values()].filter(
      (session) =>
        session.id === nativeSessionId ||
        session.id.slice(session.agent.length + 1) === nativeSessionId,
    );
    return matches.length === 1 ? this.memoryDescriptor(matches[0]!) : undefined;
  }

  /** Finish a coordination report before sending a runtime-authenticated memory operation. */
  async registerMemoryRuntime(nativeSessionId: string): Promise<void> {
    const session = this.memorySession(nativeSessionId);
    if (session !== undefined) await this.sync(session.workspace);
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
    if (typeof body.session_id !== "string") return null;
    const id = `${agent}:${body.session_id}`;
    const existing = this.sessions.get(id);
    if (existing !== undefined) return existing;
    const creating = this.creatingSessions.get(id);
    if (creating !== undefined) return creating;
    const run = this.createSession(agent, body, pane).finally(() =>
      this.creatingSessions.delete(id),
    );
    this.creatingSessions.set(id, run);
    return run;
  }

  private async createSession(
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
      runtimeGeneration: NodeCrypto.randomUUID(),
      repositoryId: place.repositoryId,
      memoryMode: "legacy",
      memoryNotice: "",
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
      legacyOwnContextPath: ownContextPath,
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
      ...(await this.baselineOf(place.root)),
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
      settleNudges: new Map(),
      settleHeard: new Set(),
      heard: new Set(),
      read: new Map(),
      touching: new Set(),
      governsChecked: 0,
      governsBook: undefined,
      knowledgeTold: new Set(),
      told: new Map(),
      askIndexAt: 0,
      injected: new Map(),
      modHandled: new Map(),
      deliveries: new Map(),
      findAt: 0,
      findTimes: [],
      advice: [],
    };
    // A session Peer meets again (Peer restarted, or the session outlived its TTL) keeps what
    // it shares: reporting it without its lines would take its findings back.
    if (this.deps.memory !== undefined) {
      try {
        const prepared = await this.deps.memory.prepare(this.memoryDescriptor(session), "startup");
        this.applyMemoryMode(session, prepared.mode, prepared.currentPath);
        session.memoryNotice = prepared.notice;
      } catch (error) {
        this.log("memory.prepare.failed", { session: id, error: messageOf(error) });
      }
    }
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
    this.queueing.delete(session.id);
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

  /**
   * A hook answered within the time its script waits. What is not ready by then (a slow hub made
   * a session's start take longer) is queued for the agent's next step: it would be lost with
   * an answer nobody waits for.
   */
  private async hookInTime(
    body: Record<string, unknown>,
    headers: NodeHttp.IncomingHttpHeaders,
  ): Promise<Record<string, unknown> | null> {
    const late = { passed: false };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = headerOf(headers, "x-peer-adapter") === "mod" ? 7500 : HOOK_DEADLINE_MS;
    const expired = new Promise<Record<string, unknown> | null>((resolve) => {
      timer = setTimeout(() => {
        late.passed = true;
        const mutations = editedFiles(body.tool_name, body.tool_input);
        const input = body.tool_input as Record<string, unknown> | null;
        const publication =
          body.tool_name === "Bash" &&
          typeof input?.command === "string" &&
          publishesWork(input.command);
        if (body.hook_event_name !== "PreToolUse") {
          resolve(null);
        } else if (publication) {
          resolve({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "Peer could not verify shared input versions before the deadline. Retry publishing.",
            },
          });
        } else if (mutations.length === 0) {
          resolve(null);
        } else {
          const agent = agentNamed(headerOf(headers, "x-peer-agent"));
          const session = this.sessions.get(`${agent}:${String(body.session_id)}`);
          const policy =
            session === undefined
              ? this.deps.policy()
              : policyWithoutHub(
                  this.views.get(session.workspace)?.policies,
                  session.project,
                  this.deps.policy(),
                );
          const memory = session?.memory ?? emptyMemory();
          const answer = unverifiedAnswer({ policy, files: mutations, memory });
          const hook = editHookAnswer(agent, [answer]);
          for (const key of hook?.acknowledge ?? []) memory.acknowledged.add(key);
          this.log("intent.unverified", {
            session: session?.id,
            files: mutations,
            policy,
            reason: "hook deadline",
          });
          resolve(hook?.output ?? null);
        }
      }, deadline);
    });
    try {
      return await Promise.race([this.hook(body, headers, late), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async hook(
    body: Record<string, unknown>,
    headers: NodeHttp.IncomingHttpHeaders,
    late: { passed: boolean } = { passed: false },
  ): Promise<Record<string, unknown> | null> {
    const started = Date.now();
    const event = typeof body.hook_event_name === "string" ? body.hook_event_name : "";
    const agent = agentNamed(headerOf(headers, "x-peer-agent"));
    const pane = this.paneOf(agent, body, headerOf(headers, "x-herdr-pane"));
    // A session Peer never saw that ends has nothing to clear.
    if (
      event === "SessionEnd" &&
      !this.sessions.has(`${agent}:${String(body.session_id)}`) &&
      !this.creatingSessions.has(`${agent}:${String(body.session_id)}`)
    )
      return null;
    const session = await this.sessionFor(agent, body, pane);
    if (session === null) return null;
    const mod = headerOf(headers, "x-peer-adapter") === "mod";
    const signature = NodeCrypto.createHash("sha256")
      .update(
        JSON.stringify([
          event,
          body.tool_name,
          body.tool_input,
          body.prompt,
          body.source,
          body.message,
          body.reason,
        ]),
      )
      .digest("hex");
    if (!mod && Date.now() - (session.modHandled.get(signature) ?? 0) < 10_000) return null;
    if (mod) {
      session.modAt = Date.now();
    }
    if (pane !== undefined) session.pane = pane;
    const pending = this.answerHook(event, session, body, { mod, signature });
    const generation = session.runtimeGeneration;
    const out = await pending;
    if (
      event !== "SessionEnd" &&
      (session.runtimeGeneration !== generation || this.sessions.get(session.id) !== session)
    ) {
      this.log("hook.stale", {
        session: session.id,
        runtimeGeneration: generation,
        hookEvent: event,
      });
      const input = body.tool_input as Record<string, unknown> | null;
      if (
        event === "PreToolUse" &&
        (editedFiles(body.tool_name, body.tool_input).length > 0 ||
          (body.tool_name === "Bash" &&
            typeof input?.command === "string" &&
            publishesWork(input.command)))
      ) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason:
              "Peer's runtime session changed while checking this action. Retry from the current session.",
          },
        };
      }
      return null;
    }
    if (mod) {
      session.modHandled.set(signature, Date.now());
      while (session.modHandled.size > 100)
        session.modHandled.delete(session.modHandled.keys().next().value!);
    }
    const chars = injectedChars(out);
    this.log("hook", {
      session: session.id,
      hookEvent: event,
      tool: body.tool_name,
      files: editedFiles(body.tool_name, body.tool_input),
      answer: out ?? undefined,
      ...(chars === 0 ? {} : { chars }),
      ms: Date.now() - started,
    });
    if (!late.passed) {
      // What reaches the agent is what Peer costs it: the log says how much, for tuning from real runs.
      if (!mod && chars > 0)
        session.injected.set(event, (session.injected.get(event) ?? 0) + chars);
      if (!mod || event === "SessionEnd") return out;
      const text = (out?.hookSpecificOutput as { readonly additionalContext?: unknown } | undefined)
        ?.additionalContext;
      const id = typeof text === "string" && text !== "" ? NodeCrypto.randomUUID() : undefined;
      if (id !== undefined && typeof text === "string") {
        session.deliveries.set(id, { text, event, acknowledged: false });
        this.log("delivery.prepared", {
          session: session.id,
          runtimeGeneration: session.runtimeGeneration,
          id,
          chars: text.length,
          hookEvent: event,
        });
        while (session.deliveries.size > 100)
          session.deliveries.delete(session.deliveries.keys().next().value!);
      }
      return {
        ...out,
        peerStatus: `Peer · ${session.project} · ${session.status} · ${session.keeps ? "keeps shared context" : "private context"}`,
        ...(id === undefined
          ? {}
          : { peerDelivery: { id, text, chars: typeof text === "string" ? text.length : 0 } }),
      };
    }
    // Its script stopped waiting before this was ready: what it had to say goes with the next step.
    const said = (out?.hookSpecificOutput as { readonly additionalContext?: unknown } | undefined)
      ?.additionalContext;
    if (typeof said === "string" && said !== "") session.pending.push(said);
    this.log("hook.late", {
      session: session.id,
      hookEvent: event,
      ms: Date.now() - started,
      queued: typeof said === "string" && said !== "",
      decided: (out?.hookSpecificOutput as { readonly permissionDecision?: unknown } | undefined)
        ?.permissionDecision,
    });
    return null;
  }

  private async answerHook(
    event: string,
    session: LocalSession,
    body: Record<string, unknown>,
    adapter?: { readonly mod: boolean; readonly signature: string },
  ): Promise<Record<string, unknown> | null> {
    if (event === "SessionStart") {
      // A resumed process may keep its native session id after a crash. Its old receipts
      // expire before any asynchronous work; compact continues the same process.
      if (body.source !== "compact") {
        session.runtimeGeneration = NodeCrypto.randomUUID();
        session.deliveries.clear();
        session.modHandled.clear();
        if (adapter?.mod === true) session.modAt = Date.now();
        else delete session.modAt;
      }
      // Mods handle the event before invoking the settings hook. Reserve its fingerprint
      // while startup is still waiting, so that fallback cannot rotate the process twice.
      if (adapter?.mod === true) session.modHandled.set(adapter.signature, Date.now());
    }
    const context = (hookEventName: string, text: string | null) =>
      text === null ? null : { hookSpecificOutput: { hookEventName, additionalContext: text } };
    if (
      session.memoryMode === "memory" &&
      this.deps.memory !== undefined &&
      event !== "SessionEnd"
    ) {
      session.memoryNotice = await this.deps.memory
        .notice(this.memoryDescriptor(session))
        .catch(() => "");
    }
    // The project's reviewed knowledge is read before the steps that may tell of it.
    if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") {
      await this.ensureKnowledge(session).catch(() => undefined);
    }
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
        const prompt = asked.length > 60 ? `${cutText(asked, 59)}…` : asked;
        if (prompt !== "" && !session.labelFromPrompt) {
          session.label = prompt;
          session.labelFromPrompt = true;
        }
        // It may have gone to another branch, which can name another task.
        session.branch =
          (await this.deps.branchOf(session.root).catch(() => undefined)) ?? session.branch;
        this.markDirty();
        // The index goes with what the person asked: the agent decides, as it starts on the ask,
        // whether somebody else does a part of it. No ranking of the works against the ask. What
        // the news told of a work is not told again by the index, so the news comes first.
        const fullPrompt = typeof body.prompt === "string" ? body.prompt : "";
        const news = this.news(session);
        const index =
          session.memoryMode === "memory"
            ? `Peer Memory index: ${this.cli} memory search${session.task === undefined ? "" : ` --task ${session.task}`}. Select record versions with ${this.cli} memory project --include id@version --purpose "current task".`
            : this.advise(session, "index", () => this.askIndexFor(session, fullPrompt), null);
        return context(event, [news, index].filter((part) => part !== null).join("\n\n") || null);
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
          if (
            session.keeps &&
            this.samePath(path, this.mirrorOf(session)?.path ?? session.contextPath)
          ) {
            await this.saveShared(session);
            contextEdited = true;
            continue;
          }
          const changed = inRepository(session, path);
          if (changed === null) continue;
          file = changed;
          this.noteTouching(session, changed);
          session.dirty.add(changed);
          session.files = [...session.files.filter((f) => f !== changed), changed].slice(
            -MAX_FILES,
          );
          const asked = session.asked.get(changed);
          if (asked !== undefined) {
            // The edit ran after its person was asked: they approved, which the hub hears too.
            for (const key of asked.keys) session.memory.acknowledged.add(key);
            session.asked.delete(changed);
            this.log("ask.approved", { session: session.id, file: changed, keys: asked.keys });
            for (const overlap of asked.overlaps)
              void this.ackOverlap(session, overlap, asked.filesAt.get(overlap));
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
      case "PreCompact":
        await this.checkpointPrivate(session);
        if (this.deps.memory !== undefined)
          await this.deps.memory.checkpoint(
            this.memoryDescriptor(session),
            "before provider compaction",
          );
        return context(
          event,
          session.memoryMode === "memory"
            ? `Peer Memory saved a checkpoint of ${session.ownContextPath}. Read this private file and the latest immutable projection after compaction.`
            : null,
        );
      case "SessionEnd":
        if (this.deps.memory !== undefined)
          await this.deps.memory.end(this.memoryDescriptor(session));
        void this.release(session);
        this.sessions.delete(session.id);
        this.log("session.ended", {
          session: session.id,
          injected: Object.fromEntries(session.injected),
          tokenEstimate: Math.round([...session.injected.values()].reduce((a, b) => a + b, 0) / 4),
          tokenEstimateMethod: "chars/4",
        });
        this.markDirty();
        return null;
      default:
        return null;
    }
  }

  /**
   * What git says changed in a repository, or null when it does not say within `ms` (a big
   * repository). One run per repository at a time: a slow one is waited for again, not stacked.
   */
  private async statusWithin(root: string, ms: number): Promise<string | null> {
    let run = this.gitRuns.get(root);
    if (run === undefined) {
      run = this.deps
        .gitStatus(root)
        .catch(() => "")
        .finally(() => this.gitRuns.delete(root));
      this.gitRuns.set(root, run);
    }
    const status = await Promise.race([run, sleepMs(ms).then(() => null)]);
    if (status === null) this.log("git.slow", { root, ms });
    return status;
  }

  /** The files already changed in a repository as a session starts, and whether git said in time. */
  private async baselineOf(root: string) {
    const status = await this.statusWithin(root, GIT_STATUS_MS);
    return { dirty: new Set(changedPaths(status ?? "")), dirtyKnown: status !== null };
  }

  /**
   * What a shell command changed: the files git sees changed now and did not
   * before, less those other sessions here changed. Agents edit with sed too.
   */
  private async readShellChanges(session: LocalSession) {
    const status = await this.statusWithin(session.root, GIT_STATUS_MS);
    // A repository too big to look at in time is looked at again at the next step.
    if (status === null) return;
    const now = new Set(changedPaths(status));
    if (!session.dirtyKnown) {
      // The first time git says what is changed here: whatever was, was there before the agent, or
      // is somebody's else; attributing it would make false overlaps for its teammates.
      session.dirty = new Set([...now, ...session.dirty]);
      session.dirtyKnown = true;
      return;
    }
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
    for (const file of changed) this.noteTouching(session, file);
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
      (session.keeps && this.samePath(path, this.mirrorOf(session)?.path ?? session.contextPath))
    );
  }

  /** A permission Codex asks for that is Peer's own business: its command, or the agent's contexts. */
  private isPeerWork(session: LocalSession, body: Record<string, unknown>): boolean {
    if (session.memoryMode === "memory" && body.tool_name === "Read") {
      const input = body.tool_input as Record<string, unknown> | null;
      const path =
        typeof input?.file_path === "string"
          ? NodePath.resolve(session.cwd, input.file_path)
          : undefined;
      if (
        path !== undefined &&
        (this.samePath(path, session.ownContextPath) ||
          (NodePath.dirname(path) === NodePath.dirname(session.ownContextPath) &&
            /^(?:projection\..+\.md|manifest\..+\.json)$/.test(NodePath.basename(path))))
      )
        return true;
    }
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
            permissionDecisionReason:
              ownWork && session.memoryMode === "memory"
                ? `Peer: ${keeper} edits the shared overview of ${subject}. Share a selected finding with ${this.cli} remember; your private working context is ${session.ownContextPath}.`
                : ownWork
                  ? `Peer: ${keeper} keeps the shared context of ${subject}; the other agents on it only read it. Put what the work should know under "## For the team" in your working context (${session.ownContextPath}); Peer passes it to the keeper.`
                  : `Peer: this is the shared context of ${subject}, another work on this project, and ${keeper} keeps it: only its keeper writes it. Read it; if your work depends on it, ask its agents: ${this.cli} ask ${this.handleOf(mirror.workspace, mirror.project, mirror.scope)} "<question>".`,
          },
        };
      }
      const file = inRepository(session, path);
      if (file !== null) files.push(file);
    }
    // What the project's `.ai` governs among the files it is about to change is said before it does.
    for (const file of files) this.noteTouching(session, file);
    if (files.length === 0) {
      // Its own contexts only: Claude Code edits them unasked. Codex takes no "allow" without a
      // rewrite, and asks for them through PermissionRequest instead. A file elsewhere outside the
      // repository is not Peer's to let through: its person's permission settings decide.
      const paths = this.editedPaths(session, body);
      const own = paths.length > 0 && paths.every((path) => this.keptBy(session, path));
      return session.agent === "claude" && own
        ? {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "allow",
              permissionDecisionReason: "The agent's own working context",
            },
          }
        : this.newsContext("PreToolUse", session);
    }
    // The hub decides, recording the claim in the same step: a view from a while ago would let the
    // first edits of one file on two computers both pass.
    const { answers, policy } = await this.decideEdits(session, files);
    const said = answers.filter(
      ({ answer }) => answer.decision !== undefined || answer.context !== undefined,
    );
    for (const { file, answer } of said) this.settle(session, file, answer, policy);
    const hook = editHookAnswer(
      session.agent,
      said.map(({ answer }) => answer),
    );
    if (hook === null) return this.newsContext("PreToolUse", session);
    for (const key of hook.acknowledge) session.memory.acknowledged.add(key);
    return hook.output;
  }

  /**
   * What each file of an edit hears. The hub decides where it can (`intent`): it records the
   * session's claim and opens the overlaps in one step, so two first edits cannot both pass. A hub
   * without it leaves the view this computer has, as before it existed; a hub that gives no verdict
   * within its deadline leaves the explicit fallback (`unverifiedAnswer`).
   */
  private async decideEdits(
    session: LocalSession,
    files: ReadonlyArray<string>,
  ): Promise<{
    readonly answers: ReadonlyArray<{ readonly file: string; readonly answer: EditAnswer }>;
    readonly policy: PeerProjectPolicy;
  }> {
    const settings = this.deps.policy();
    // Nobody contests a lockfile: it is made again after the merge.
    const checked = [...new Set(files)].filter((file) => !generatedFile(file));
    if (checked.length === 0) return { answers: [], policy: settings };
    const hub = await this.askHub(session, checked);
    if (hub.kind === "decided") return hub;
    if (hub.kind === "unsupported") {
      return { answers: await this.viewAnswers(session, files, settings), policy: settings };
    }
    const policy = policyWithoutHub(
      this.views.get(session.workspace)?.policies,
      session.project,
      settings,
    );
    // One answer for the edit as a whole: nothing here tells one of its files from another.
    const answer = unverifiedAnswer({ policy, files: checked, memory: session.memory });
    if (answer.decision === undefined) {
      // Let go on the policy's word: its files reach the next report, so the hub finds the overlaps afterwards.
      this.log("intent.unverified", { session: session.id, files: checked, policy });
    }
    const [first = ""] = checked;
    return { answers: [{ file: first, answer }], policy };
  }

  /**
   * What each file of an edit hears from the view this computer has, as it did before the hub decided:
   * for a hub without `intent`.
   */
  private async viewAnswers(
    session: LocalSession,
    files: ReadonlyArray<string>,
    policy: PeerCoordinationPolicy,
  ) {
    // Decide on what the other agents changed just now, not a view from a while ago.
    if (Date.now() - (this.viewAt.get(session.workspace) ?? 0) > FRESH_MS) {
      await this.syncNow(session.workspace, 1500);
    }
    let answers = files.map((file) => ({ file, answer: this.decide(session, file, policy) }));
    if (answers.some(({ answer }) => answer.decision === "deny")) {
      // Make each contest an overlap the hub knows, so the agent's note has somewhere to go.
      for (const { file, answer } of answers) {
        if (answer.decision === "deny") {
          session.claims = [...session.claims.filter((c) => c !== file), file];
        }
      }
      this.markDirty();
      // Both waits together stay well inside what the hook has (`HOOK_DEADLINE_MS`).
      await this.syncNow(session.workspace, 1000);
      answers = files.map((file) => ({ file, answer: this.decide(session, file, policy) }));
    }
    return answers;
  }

  /**
   * Asks the hub to decide an edit of `files` (not lockfiles), within `INTENT_DEADLINE_MS` in all:
   * its verdicts, worded as answers; that this hub has no `intent`, which it is not asked again for
   * ten minutes; or that it gave no verdict in time.
   */
  private async askHub(
    session: LocalSession,
    files: ReadonlyArray<string>,
  ): Promise<
    | {
        readonly kind: "decided";
        readonly answers: ReadonlyArray<{ readonly file: string; readonly answer: EditAnswer }>;
        readonly policy: PeerProjectPolicy;
      }
    | { readonly kind: "unsupported" }
    | { readonly kind: "failed" }
  > {
    const { workspace, project } = session;
    const intent = this.deps.intent;
    const place = `${workspace}\u0000${project}`;
    if (intent === undefined || (this.intentUnsupportedUntil.get(place) ?? 0) > Date.now()) {
      return { kind: "unsupported" };
    }
    const started = Date.now();
    const failed = (reason: string) => {
      this.log("intent.failed", {
        session: session.id,
        workspace,
        project,
        files,
        ms: Date.now() - started,
        reason,
      });
      return { kind: "failed" } as const;
    };
    try {
      // The hub knows the sessions this computer reported: a new one is reported first, from the same budget.
      if (!this.reportedSessions.get(workspace)?.has(session.id)) {
        await this.syncNow(workspace, INTENT_REPORT_MS);
      }
      const left = Math.max(INTENT_DEADLINE_MS - (Date.now() - started), 0);
      const answers = await within(
        Promise.all(
          chunks(files, INTENT_MAX_PATHS).map((paths) =>
            intent(
              workspace,
              project,
              {
                environment: this.deps.environment,
                session: session.id,
                paths,
                policy: this.deps.policy(),
                op: newOp(),
              },
              left,
            ),
          ),
        ),
        left,
      );
      if (answers === TIMED_OUT) return failed("timeout");
      const decided = answers.filter(isDecided);
      if (decided.length < answers.length || decided[0] === undefined) {
        this.intentUnsupportedUntil.set(place, Date.now() + INTENT_LEGACY_MS);
        if (!this.intentLegacyLogged.has(workspace)) {
          this.intentLegacyLogged.add(workspace);
          this.log("intent.legacy", { workspace, project });
        }
        return { kind: "unsupported" };
      }
      const answer: HubIntentAnswer = {
        ...decided[0],
        verdicts: decided.flatMap((one) => one.verdicts),
        overlaps: [
          ...new Map(decided.flatMap((one) => one.overlaps).map((o) => [o.id, o])).values(),
        ],
      };
      // Texts, news and `peer status` see what the hub recorded at once, not at the next sync.
      this.mergeIntent(workspace, project, answer);
      this.log("intent", {
        session: session.id,
        workspace,
        project,
        ms: Date.now() - started,
        policy: answer.policy,
        policySource: answer.policySource,
        verdicts: answer.verdicts.map(({ path, verdict, with: parties, holder }) => ({
          path,
          verdict,
          with: parties,
          ...(typeof holder === "string" ? { holder } : {}),
        })),
      });
      const verdicts = new Map(answer.verdicts.map((verdict) => [verdict.path, verdict]));
      const me = this.asHub(session);
      const sessions = this.merged(workspace, this.views.get(workspace)).sessions;
      return {
        kind: "decided",
        policy: answer.policy,
        answers: files.map((file) => {
          const verdict = verdicts.get(file);
          return {
            file,
            answer:
              verdict === undefined
                ? unverifiedAnswer({ policy: answer.policy, files: [file], memory: session.memory })
                : answerForVerdict({
                    verdict,
                    me,
                    sessions,
                    overlaps: answer.overlaps,
                    memory: session.memory,
                    nameOf: this.nameOf(workspace),
                    taskName: this.taskNamer(workspace, project),
                    cli: this.cli,
                  }),
          };
        }),
      };
    } catch (error) {
      return failed(messageOf(error));
    }
  }

  /** What the hub answered about a project's files goes into the view at once: its overlaps, and the policy it decided by. */
  private mergeIntent(workspace: string, project: string, answer: HubIntentAnswer) {
    const current: HubCoordView = this.views.get(workspace) ?? {
      sessions: [],
      overlaps: [],
      at: answer.at,
    };
    const named = new Set(answer.overlaps.map((overlap) => overlap.id));
    this.views.set(workspace, {
      ...current,
      overlaps: [
        ...current.overlaps.filter((overlap) => !named.has(overlap.id)),
        ...answer.overlaps,
      ],
      ...(answer.policySource === "project"
        ? { policies: { ...current.policies, [project]: answer.policy } }
        : {}),
    });
    this.afterViewChange(workspace);
  }

  /** The person approved the edit its agent was asked about: the hub hears that the agent acknowledged the overlap. */
  private async ackOverlap(session: LocalSession, overlap: string, filesAt: string | undefined) {
    const ack = this.deps.ack;
    if (ack === undefined) return;
    const op = newOp();
    try {
      const updated = await ack(
        session.workspace,
        session.project,
        overlap,
        session.id,
        op,
        filesAt,
      );
      // A hub from before acknowledgements: nothing to say to it.
      if ("unsupported" in updated) return;
      this.applyOverlap(session.workspace, updated);
      this.log("ack", { session: session.id, overlap, op });
    } catch (error) {
      this.log("ack.failed", { session: session.id, overlap, op, reason: messageOf(error) });
    }
  }

  /** What one contested file's answer leaves behind: who heard, what was asked, the log. */
  private settle(
    session: LocalSession,
    file: string,
    answer: EditAnswer,
    policy: PeerProjectPolicy,
  ) {
    this.announce(session, answer.overlaps);
    if (answer.decision === "ask") {
      session.asked.set(file, {
        keys: answer.keys,
        overlaps: answer.overlaps,
        filesAt: new Map(
          answer.overlaps.map((id) => [
            id,
            this.views.get(session.workspace)?.overlaps.find((known) => known.id === id)?.filesAt ??
              undefined,
          ]),
        ),
      });
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
  private async beforeShell(
    session: LocalSession,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const input = body.tool_input as Record<string, unknown> | null;
    const command = typeof input?.command === "string" ? input.command.trim() : "";
    if (publishesWork(command)) {
      const refusal = await this.handoffRefusal(session);
      if (refusal !== null)
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: refusal,
          },
        };
    }
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

  private async handoffRefusal(session: LocalSession): Promise<string | null> {
    if (this.deps.staleReads === undefined) return null;
    try {
      const freshness = await within(
        this.deps.staleReads(session.workspace, session.project, session.id),
        INTENT_DEADLINE_MS,
      );
      if (freshness === TIMED_OUT) throw new Error("freshness deadline");
      if (freshness.fresh && freshness.stale.length === 0) return null;
      this.log("handoff.stale", { session: session.id, stale: freshness.stale });
      return `Peer: shared inputs changed. Read the current version before publishing, or explicitly confirm its change with ${this.cli} ack <task>: ${freshness.stale.map((read) => `${this.handleOf(session.workspace, session.project, read.scope)} v${read.readVersion} → v${read.currentVersion}`).join("; ")}.`;
    } catch (error) {
      this.log("handoff.unverified", { session: session.id, reason: messageOf(error) });
      return "Peer could not verify shared input versions. Retry publishing when the hub is reachable.";
    }
  }

  private async checkpointPrivate(session: LocalSession) {
    try {
      const stat = await NodeFSP.lstat(session.ownContextPath);
      if (!stat.isFile() || stat.isSymbolicLink()) return;
      const text = await NodeFSP.readFile(session.ownContextPath, "utf8");
      const temporary = `${session.ownContextPath}.checkpoint.${NodeCrypto.randomUUID()}`;
      await NodeFSP.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
      await NodeFSP.rename(temporary, `${session.ownContextPath}.checkpoint.md`);
      this.log("context.checkpoint", {
        session: session.id,
        path: `${session.ownContextPath}.checkpoint.md`,
      });
    } catch (error) {
      this.log("context.checkpoint.failed", { session: session.id, reason: messageOf(error) });
    }
  }

  /** Runtime labels require a live adapter handshake; the runtime alone reports after an action. */
  coordinationLevel(nativeId: string): "A" | "B" | "C" {
    const session = this.sessions.get(nativeId);
    if (session === undefined) return "C";
    return session.modAt !== undefined && Date.now() - session.modAt < 180_000 ? "A" : "B";
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
  private news(
    session: LocalSession,
    options: { readonly team?: boolean; readonly waking?: boolean } = {},
  ): string | null {
    const view = this.merged(session.workspace, this.views.get(session.workspace));
    const news = newsFor({
      me: this.asHub(session),
      view,
      memory: session.memory,
      nameOf: this.nameOf(session.workspace),
      taskName: this.taskNamer(session.workspace, session.project),
      closer: (overlap) => closerOf(overlap, view.sessions),
      ...(options.waking === true ? { waking: true } : {}),
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
    // An overlap gone quiet that this agent closes is overlap news too: it may wake the agent.
    const parts = [news?.text ?? null, this.settleNews(session)];
    // Findings and shared contexts wait for the agent's next step; they never wake it.
    if (options.team !== false) {
      parts.push(
        ...session.pending.splice(0),
        session.memoryMode === "memory" ? session.memoryNotice || null : this.closeNews(session),
        session.memoryMode === "memory" ? null : this.rosterNews(session),
        session.memoryMode === "memory" ? null : this.sharedNews(session),
        session.memoryMode === "memory" ? null : this.findingNews(session),
        this.advise(session, "followed", () => this.followedNews(session), null),
        this.advise(session, "governs", () => this.governsNews(session), null),
        this.boardNewsFor(session),
      );
    }
    const said = parts.filter((part) => part !== null);
    return said.length === 0 ? null : said.join("\n\n");
  }

  /**
   * The open overlaps this session closes that went quiet after both agents
   * wrote: it hears, at most twice per overlap, to close it or say what is left.
   */
  private settleNews(session: LocalSession): string | null {
    const view = this.merged(session.workspace, this.views.get(session.workspace));
    const now = Date.now();
    const said: string[] = [];
    for (const overlap of view.overlaps) {
      if (overlap.state !== "open" || !overlap.sessions.includes(session.id)) continue;
      if (closerOf(overlap, view.sessions) !== session.id) continue;
      const wrote = overlap.notes.some((note) => note.session === session.id);
      const answered = overlap.notes.some(
        (note) => note.session !== undefined && note.session !== session.id,
      );
      const last = overlap.notes.at(-1);
      if (!wrote || !answered || last === undefined) continue;
      const quiet = now - Date.parse(last.at);
      if (!(quiet >= SETTLE_QUIET_MS)) continue;
      const key = `${overlap.id}:${overlap.notes.length}`;
      const times = session.settleNudges.get(overlap.id) ?? 0;
      if (session.settleHeard.has(key) || times >= SETTLE_NUDGES) continue;
      session.settleHeard.add(key);
      session.settleNudges.set(overlap.id, times + 1);
      const otherId = overlap.sessions.find((id) => id !== session.id);
      const other = view.sessions.find((s) => s.id === otherId);
      said.push(
        settleNudge({
          overlap,
          other:
            other === undefined
              ? "an agent no longer at work"
              : describe(
                  other,
                  this.nameOf(session.workspace),
                  this.taskNamer(session.workspace, session.project),
                ),
          minutes: Math.max(1, Math.round(quiet / 60_000)),
          taskName: this.taskNamer(session.workspace, session.project),
          cli: this.cli,
        }),
      );
    }
    if (said.length === 0) return null;
    const text = said.join("\n\n");
    this.log("settle.nudged", { session: session.id, text });
    return text;
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
            cli: this.cli,
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
      taskHandle: (task) => this.handleOf(session.workspace, session.project, scopeOf(task)),
      cli: this.cli,
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
    this.log("finding.prepared", {
      session: session.id,
      runtimeGeneration: session.runtimeGeneration,
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
    if (this.deps.memory !== undefined) {
      const prepared = await this.deps.memory
        .prepare(this.memoryDescriptor(session), source)
        .catch(() => undefined);
      if (prepared !== undefined) {
        this.applyMemoryMode(session, prepared.mode, prepared.currentPath);
        session.memoryNotice = prepared.notice;
      }
    }
    if (session.memoryMode === "memory") {
      await this.syncNow(session.workspace, 1500);
      await this.takeUp(session);
      const mirror = this.mirrorOf(session);
      const text = [
        session.memoryNotice,
        `Peer Memory: ${this.cli} remember --claim "finding" --evidence path:line records a durable finding; ${this.cli} memory search retrieves the index. Select exact versions with memory project --include id@version --purpose "current task".`,
        ...(mirror === undefined
          ? []
          : [
              `Shared work overview: ${mirror.path} (version ${mirror.version}).${session.keeps ? " You edit this overview separately; your working context stays private." : " It is a separate overview by its keeper."}`,
            ]),
        "All provider adapters use companion context. Hooks alone do not prove receipt; acknowledge the exact projection after reading it.",
      ].join("\n\n");
      session.memoryNotice = "";
      this.log("memory.started", {
        session: session.id,
        runtimeGeneration: session.runtimeGeneration,
        mode: session.memoryMode,
        contextPath: session.contextPath,
        chars: text.length,
      });
      return text;
    }
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
    // The project's other work, and where to read each: the index the agent chooses from. Its
    // hook waits a few seconds at most: copies still on their way are named by `peer context`.
    await Promise.race([this.mirrorBoard(session.workspace), sleepMs(BOARD_START_WAIT_MS)]);
    await this.ensureKnowledge(session).catch(() => undefined);
    const works = this.indexWorks(session, INDEX_ALL);
    for (const scope of this.writtenScopes(session.workspace, session.project)) {
      session.boardHeard.add(scope);
    }
    // A new conversation, or one that was compacted, knows nothing of the others' work yet: what
    // each builds comes with its next ask.
    session.told.clear();
    session.askIndexAt = 0;
    const text = startContext({
      me: this.me(session),
      ...(session.agent === "codex" ? { cliPath: this.scripts.peer } : {}),
      index: indexText({
        works,
        knowledge: knowledgeIndexText(this.knowledgeBook(session), {
          cli: this.cli,
          shown: KNOWLEDGE_SHOWN,
          titles: true,
        }),
        now: Date.now(),
        cli: this.cli,
        shown: INDEX_SHOWN,
      }),
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
      index: works.slice(0, INDEX_SHOWN).map((entry) => entry.scope),
      knowledge: standing(this.knowledgeBook(session)).length,
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
      session.team = session.memoryMode === "memory" ? [] : teamLines(text);
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
    if (!session.keeps || session.memoryMode === "memory") {
      session.contextAt = Date.now();
      session.contextKept = true;
    }
    if (session.memoryMode === "memory") return;
    const team = teamLines(text);
    const changed = team.join("\n") !== session.team.join("\n");
    session.team = team;
    this.log("context.updated", { session: session.id, bytes: text.length, team, changed });
    if (changed) this.markDirty();
    if (changed && session.memoryMode === "shadow" && this.deps.memory !== undefined)
      await this.deps.memory
        .legacySnapshot(this.memoryDescriptor(session), team.join("\n"), "for_the_team")
        .catch((error) =>
          this.log("memory.legacy.failed", { session: session.id, error: messageOf(error) }),
        );
  }

  /**
   * A reminder in a line: at an agent's first change while its working context
   * is still empty, and when it has gone stale while the agent works.
   */
  private nudge(session: LocalSession, changed: string | null): string | null {
    if (session.memoryMode === "memory") return null;
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
      pushing: undefined,
    };
    this.shared.set(key, mirror);
    mirror.keeper = context.keeper;
    mirror.epoch = context.epoch ?? context.keeper?.epoch;
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
      await this.writeMirror(
        mirror.path,
        file,
        known === undefined ? context.updatedAt : undefined,
      );
    } catch (error) {
      this.log("shared.mirror.failed", { path: mirror.path, error: messageOf(error) });
    }
    return mirror;
  }

  /**
   * Writes a shared context's copy in one step, never through a link, so an agent reading it
   * never sees half of it. A copy this process has not met, changed here after the hub's version
   * was written, is edits its keeper had not shared (the hub could not be reached, say): they are
   * kept beside it, not overwritten.
   */
  private async writeMirror(path: string, text: string, hubWrittenAt: string | undefined) {
    const stat = await NodeFSP.lstat(path).catch(() => null);
    if (stat?.isSymbolicLink() === true) await NodeFSP.rm(path, { force: true });
    else if (
      stat?.isFile() === true &&
      hubWrittenAt !== undefined &&
      stat.mtimeMs > Date.parse(hubWrittenAt)
    ) {
      const there = await NodeFSP.readFile(path, "utf8").catch(() => null);
      if (there !== null && there !== text && contextWritten(there)) {
        await NodeFSP.writeFile(`${path}.unsent`, there);
        this.log("shared.stashed", { path });
      }
    }
    const temporary = `${path}.${process.pid}.tmp`;
    await NodeFSP.writeFile(temporary, text);
    await NodeFSP.rename(temporary, path);
  }

  /** Keeps what a keeper wrote that the hub refused beside its file, before the file takes the hub's text. */
  private async stash(mirror: SharedMirror): Promise<boolean> {
    try {
      await NodeFSP.writeFile(`${mirror.path}.unsent`, mirror.text);
      this.log("shared.stashed", { path: mirror.path, bytes: mirror.text.length });
      return true;
    } catch {
      return false;
    }
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
    session.contextPath = session.ownContextPath;
    session.sharedHeard = mirror.version;
    session.sharedHeardText = mirror.text;
    session.remindedAtStart = false;
    session.contextAt = Date.now();
    mirror.keeper = {
      session: session.id,
      email: this.deps.email() ?? "",
      environment: this.deps.environment,
      since: new Date().toISOString(),
      ...(mirror.epoch === undefined ? {} : { epoch: mirror.epoch }),
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
      .keepContext(
        session.workspace,
        session.project,
        scope,
        session.id,
        true,
        this.mirrorOf(session)?.epoch,
        newOp(),
      )
      .catch((error: unknown) =>
        this.log("shared.release.failed", { session: session.id, scope, error: messageOf(error) }),
      );
  }

  /** When the keeper changed the shared context, the hub gets the new version. */
  private async saveShared(session: LocalSession) {
    const mirror = this.mirrorOf(session);
    if (mirror === undefined) return;
    // A link where the file should be would share whatever it points to.
    const linked = await NodeFSP.lstat(mirror.path).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
    if (linked) {
      this.log("shared.linked", { path: mirror.path });
      return;
    }
    const text = await NodeFSP.readFile(mirror.path, "utf8").catch(() => null);
    if (text === null || text === mirror.text) return;
    session.contextAt = Date.now();
    session.contextKept = contextWritten(text);
    const before = new Set(projectLines(mirror.text));
    const after = projectLines(text);
    if (session.memoryMode !== "memory") {
      for (const line of after) if (!before.has(line)) session.marked.add(line);
      for (const line of before) if (!after.includes(line)) session.marked.delete(line);
    }
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
    if (session.memoryMode === "shadow" && this.deps.memory !== undefined)
      await this.deps.memory
        .legacySnapshot(this.memoryDescriptor(session), after.join("\n"), "project_marked")
        .catch((error) =>
          this.log("memory.legacy.failed", { session: session.id, error: messageOf(error) }),
        );
  }

  /**
   * Sends the keeper's change to the hub, one write at a time per context: a hook's write and a
   * sync's, both on the version before, would make the second see the first as another's change.
   */
  private pushShared(session: LocalSession, mirror: SharedMirror): Promise<void> {
    const run = (mirror.pushing ?? Promise.resolve()).then(() => this.pushNow(session, mirror));
    const tracked = run.finally(() => {
      if (mirror.pushing === tracked) mirror.pushing = undefined;
    });
    mirror.pushing = tracked;
    return tracked;
  }

  private async pushNow(session: LocalSession, mirror: SharedMirror) {
    // An earlier write took what there was to send.
    if (!mirror.unsent) return;
    // The text this write carries: the keeper may change the file again while it is on its way.
    const sent = mirror.text;
    let answer: HubContextText | ContextRefusal;
    try {
      answer = await this.deps.writeContext(
        mirror.workspace,
        mirror.project,
        mirror.scope,
        session.id,
        mirror.version,
        sent,
        mirror.epoch,
        newOp(),
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
      mirror.epoch = answer.epoch ?? answer.keeper?.epoch;
      mirror.updatedAt = answer.updatedAt;
      mirror.updatedBy = answer.updatedBy;
      mirror.updatedSession = answer.updatedSession;
      mirror.restoredFrom = undefined;
      // A change made while this write was on its way is still to be sent: the next write does.
      mirror.unsent = mirror.text !== sent;
      session.sharedHeard = answer.version;
      session.sharedHeardText = sent;
      const bytes = Buffer.byteLength(sent);
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
        bytes: sent.length,
      });
      this.deps.changed();
      return;
    }
    if (answer.refused === "stale" && answer.current.text === sent) {
      // Its own change, which the hub took already (a write that timed out): nothing was lost.
      mirror.version = answer.current.version;
      mirror.updatedAt = answer.current.updatedAt;
      mirror.updatedBy = answer.current.updatedBy;
      mirror.updatedSession = answer.current.updatedSession;
      mirror.unsent = mirror.text !== sent;
      session.sharedHeard = answer.current.version;
      session.sharedHeardText = sent;
      this.markDirty();
      this.log("shared.written", {
        session: session.id,
        scope: mirror.scope,
        version: answer.current.version,
        bytes: sent.length,
        already: true,
      });
      return;
    }
    if (answer.refused === "stale") {
      // What the keeper wrote is kept beside the file, which now takes the hub's version.
      const kept = await this.stash(mirror);
      await this.mirror(mirror.workspace, answer.current, true);
      const by = answer.current.updatedBy;
      session.pending.push(
        `Peer: the shared context of ${subject} changed meanwhile (version ${answer.current.version}${by === undefined ? "" : `, by ${this.deps.nameOf(mirror.workspace, by)}'s agent`}); ${mirror.path} now has that version. Make your change again on top of it.${kept ? ` What you wrote is in ${mirror.path}.unsent.` : ""}`,
      );
      this.log("shared.stale", {
        session: session.id,
        scope: mirror.scope,
        version: answer.current.version,
      });
      return;
    }
    const stashed = await this.stash(mirror);
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
      `Peer: ${who} keeps the shared context of ${subject} now, so your last change to it was not shared${stashed ? ` (it is in ${mirror.path}.unsent)` : ""}. Your working context is ${session.ownContextPath} again; put what the work should know under "## For the team" there.`,
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
      // The hub lists a session of this computer as the keeper that this process does not know to
      // keep it: Peer restarted since it began. It keeps the context again, where it was.
      const email = this.deps.email();
      const resumed = sessions.find(
        (s) =>
          !s.keeps &&
          !s.starting &&
          listed?.keeper?.session === s.id &&
          listed.keeper.email === email,
      );
      if (resumed !== undefined) {
        await this.takeUp(resumed);
        const back = this.mirrorOf(resumed);
        if (resumed.keeps && back !== undefined) {
          const stashed = await NodeFSP.stat(`${back.path}.unsent`).then(
            () => true,
            () => false,
          );
          resumed.pending.push(
            `Peer restarted, and you still keep the shared context of ${subject}: ${back.path} has it (version ${back.version}); go on keeping it there.${stashed ? ` Edits of yours the hub had not taken before are in ${back.path}.unsent.` : ""}`,
          );
          this.log("shared.resumed", { session: resumed.id, scope, version: back.version });
        }
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
      const before = listed?.keeper;
      const since = kept.version === 0 ? 0 : Date.parse(kept.updatedAt);
      const findings = findingsOnWork(this.holder(next), this.findingsOf(workspace), next.heard);
      for (const finding of findings) next.heard.add(finding.id);
      next.roster = this.agentsOn(next);
      const fresh = findings.filter((finding) => Date.parse(finding.at) > since).slice(0, 10);
      next.pending.push(
        [
          next.memoryMode === "memory"
            ? `Peer: you (${clip(neutral(this.me(next)), 50)}) edit the shared overview of ${clip(neutral(subject), 80)} now. Read: ${this.cli} context ${this.handleOf(workspace, next.project, scope)}. Record selected findings with ${this.cli} remember; private notes stay separate.`
            : `Peer: you (${clip(neutral(this.me(next)), 50)}) keep the shared context of ${clip(neutral(subject), 80)} now${before === undefined ? "" : `; ${clip(neutral(this.deps.nameOf(workspace, before.email)), 30)}'s agent kept it before`}. Shared v${kept.version}: ${clip(kept.path, 180)}. Read: ${this.cli} context ${this.handleOf(workspace, next.project, scope)}. Private notes stay separate. In ## Provides keep outputs, assumptions and verification; share at subtask boundaries.`,
          ...(fresh.length === 0
            ? []
            : [
                findingsForKeeper({
                  subject,
                  findings: fresh,
                  nameOf: this.nameOf(workspace),
                  cli: this.cli,
                }),
              ]),
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

  /** An agent at work elsewhere on the project, as the index shows it: whose, what it does now, and where. */
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
    // What it changes now says what it builds: the newest files, as far as the hub knows them.
    const files = other.files.slice(-3);
    const at =
      files.length === 0
        ? ""
        : `: ${files.join(", ")}${other.files.length > files.length ? ` (+${other.files.length - files.length})` : ""}`;
    return `${this.deps.nameOf(workspace, other.email)}'s agent (${agent}${doing}${where}${at})`;
  }

  /** The written shared contexts of a project the hub lists, by scope. */
  private writtenScopes(workspace: string, project: string): string[] {
    return (this.views.get(workspace)?.contexts ?? [])
      .filter((c) => c.project === project && c.version > 0)
      .map((c) => c.scope);
  }

  /**
   * The project's other works as an agent on `session`'s could hear of them: each task (or the
   * work outside tasks) with agents at work on it or a recent shared context, and what each says
   * about itself. A closed task, or one whose context nobody wrote lately, says nothing unless
   * agents work on it.
   */
  private works(session: LocalSession): WorkRow[] {
    const { workspace, project } = session;
    const view = this.views.get(workspace);
    const own = scopeOf(session.task);
    const others = this.merged(workspace, view).sessions.filter(
      (s) => s.project === project && s.id !== session.id,
    );
    const contexts = (view?.contexts ?? []).filter((c) => c.project === project);
    const unfinished = (this.deps.work?.(workspace, project) ?? []).filter(
      (thread) => thread.delivery !== "merged" && thread.delivery !== "closed",
    );
    const done = new Set(
      this.deps
        .tasks(workspace, project)
        .filter((t) => t.status === "done")
        .map((t) => `task:${t.id}`),
    );
    const scopes = new Set([
      ...contexts.map((c) => c.scope),
      ...others.map((s) => scopeOf(s.task)),
      ...unfinished.map((thread) => scopeOf(thread.task)),
    ]);
    scopes.delete(own);
    return [...scopes].flatMap((scope) => {
      const context = contexts.find((c) => c.scope === scope);
      const agents = others.filter((s) => scopeOf(s.task) === scope);
      const written = context !== undefined && context.version > 0;
      const recent =
        written && Date.now() - Date.parse(context.updatedAt) < BOARD_DAYS * 24 * 60 * 60 * 1000;
      const pending = unfinished.filter((thread) => scopeOf(thread.task) === scope);
      if (agents.length === 0 && (done.has(scope) || (!recent && pending.length === 0))) return [];
      const mirror = this.shared.get(this.sharedKey(workspace, project, scope));
      const updatedAt = written ? Date.parse(context.updatedAt) : undefined;
      return [
        {
          entry: {
            scope,
            handle: this.handleOf(workspace, project, scope),
            name:
              scope === "project"
                ? "Work outside tasks"
                : this.subjectOf(workspace, project, scope),
            agents:
              agents.length > 0
                ? agents.map((s) => this.boardAgent(workspace, s))
                : pending
                    .slice(0, 3)
                    .map(
                      (thread) =>
                        `${this.deps.nameOf(workspace, thread.email)}'s unfinished work (${thread.branch ?? thread.title}; runtime unavailable)`,
                    ),
            keeper:
              context?.keeper === undefined
                ? undefined
                : `${this.deps.nameOf(workspace, context.keeper.email)}'s agent`,
            version: context?.version,
            gist: context?.gist,
            // A copy that is behind the hub's version is no copy of the context the line names.
            path:
              mirror !== undefined && mirror.version > 0 && mirror.version === context?.version
                ? mirror.path
                : undefined,
            updatedAt,
          },
          labels: agents.flatMap((s) => [s.label, s.intent ?? ""]).filter((text) => text !== ""),
          text:
            mirror !== undefined && mirror.version > 0 && contextWritten(mirror.text)
              ? mirror.text
              : undefined,
          updatedAt,
          active: agents.length > 0,
          working: agents.some((s) => s.status === "working"),
        },
      ];
    });
  }

  /** Works with agents at work on them first, those being worked on now first of those, then the most recently written. */
  private static byActivity(a: WorkRow, b: WorkRow): number {
    return (
      Number(b.active) - Number(a.active) ||
      Number(b.working) - Number(a.working) ||
      (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    );
  }

  /** The project's other works for an agent on `session`'s, in the order of who is at work on them. */
  private board(session: LocalSession, limit = BOARD_SHOWN): BoardEntry[] {
    return this.works(session)
      .toSorted(CoordinationBroker.byActivity)
      .slice(0, limit)
      .map((row) => row.entry);
  }

  /** The board with what this agent did with each work: which version of its context it read, whether it asked its agents. */
  private indexWorks(session: LocalSession, limit: number): BoardEntry[] {
    return this.board(session, limit).map((entry) => {
      const read = session.read.get(entry.scope)?.version;
      const task = claimedTask(entry.scope);
      const asked = task !== undefined && session.asks.has(taskClaim(task));
      return {
        ...entry,
        ...(read === undefined ? {} : { read }),
        ...(asked ? { asked: true } : {}),
      };
    });
  }

  /** Work that showed up on the project since the session last heard: told once, at its next step. */
  private boardNewsFor(session: LocalSession): string | null {
    const fresh = this.board(session, BOARD_ALL)
      .filter((entry) => (entry.version ?? 0) > 0 && !session.boardHeard.has(entry.scope))
      .slice(0, 3);
    if (fresh.length === 0) return null;
    for (const entry of fresh) {
      session.boardHeard.add(entry.scope);
      // The news carries the line with its gist: the next ask need not say it again.
      session.told.set(entry.scope, gistKey(entry));
    }
    const text = boardNews(fresh, this.cli, Date.now());
    this.log("board.told", {
      session: session.id,
      scopes: fresh.map((entry) => entry.scope),
      text,
    });
    return text;
  }

  // ---- the index: what the agent chooses its context from ----

  /**
   * The index is advice: whatever goes wrong in it must never break the hook that also carries
   * Peer's decisions (a stopped edit, a note), so it is logged and the hook goes on without it.
   */
  private advise<T>(session: LocalSession, what: string, run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      this.log("index.failed", { session: session.id, what, error: messageOf(error) });
      return fallback;
    }
  }

  /** Remembers what an agent did with the team's work, for people to see in Peer (the last dozen per agent). */
  private noteAdvice(session: LocalSession, entry: Advice) {
    session.advice.push(entry);
    if (session.advice.length > 12) session.advice.splice(0, session.advice.length - 12);
    this.deps.changed();
  }

  /** A file the agent changes or is about to: the project's `.ai` may govern it. */
  private noteTouching(session: LocalSession, file: string) {
    if (session.touching.size < TOUCHING_KEPT) session.touching.add(file);
  }

  /**
   * The agent read a work's shared context (`peer context`): Peer keeps what it read, to tell it
   * what changes there, and has nothing more to say of the work.
   */
  private markRead(session: LocalSession, scope: string, version: number, text: string) {
    session.read.delete(scope);
    session.read.set(scope, { version, text: text.slice(0, SHARED_MAX_BYTES), toldAt: Date.now() });
    if (session.read.size > READ_KEPT) {
      const oldest = session.read.keys().next().value;
      if (oldest !== undefined) session.read.delete(oldest);
    }
    session.boardHeard.add(scope);
    const row = this.works(session).find((work) => work.entry.scope === scope);
    this.noteAdvice(session, {
      about: "work",
      scope,
      name: row?.entry.name ?? scope,
      how: "read",
      why: `read its shared context, version ${version}`,
      at: Date.now(),
    });
  }

  /** The agent asked a work's agents. */
  private markAsked(session: LocalSession, scope: string) {
    session.boardHeard.add(scope);
    const row = this.works(session).find((work) => work.entry.scope === scope);
    this.noteAdvice(session, {
      about: "work",
      scope,
      name: row?.entry.name ?? scope,
      how: "asked",
      why: "asked the agents at work on it",
      at: Date.now(),
    });
  }

  /**
   * What goes with an ask of the agent's person: the other works it was not told of yet, or whose
   * gist changed since, by name and with what each says it builds. Peer does not say which of them
   * relate to the ask: the agent reads the block, in the inference it runs anyway, and decides.
   *
   * It is said once. The agent was told what it was told; a block that repeated it would stay in
   * its context and be read in every turn after. So an ask with nothing new gets nothing, or one
   * line after a pause. A project with no other work (only its `.ai`) gets nothing at an ask: the
   * start named its entries, and an entry that governs a file says so when the file is changed.
   */
  private askIndexFor(session: LocalSession, prompt: string): string | null {
    if (!askedByPerson(prompt)) return null;
    const works = this.indexWorks(session, INDEX_ALL);
    if (works.length === 0) return null;
    // What the agent read, or asked the agents of, it knows more of than a gist says.
    const fresh = works.filter(
      (entry) =>
        entry.read === undefined &&
        entry.asked !== true &&
        session.told.get(entry.scope) !== gistKey(entry),
    );
    const now = Date.now();
    if (fresh.length === 0) {
      if (now - session.askIndexAt < ASK_REMIND_MS) return null;
      session.askIndexAt = now;
      this.log("index.asked", { session: session.id, kind: "reminder", works: [] });
      return askReminderText(this.cli);
    }
    const knowledge = standing(this.knowledgeBook(session)).length;
    const changed = session.told.size > 0;
    const text = askIndexText({
      works: fresh,
      changed,
      knowledge: knowledge > 0,
      cli: this.cli,
    });
    if (text === null) return null;
    // Only the works the block gave the gist of are told: the rest come with the next ask.
    const gisted = fresh.slice(0, ASK_GIST_SHOWN);
    for (const entry of gisted) session.told.set(entry.scope, gistKey(entry));
    session.askIndexAt = now;
    this.log("index.asked", {
      session: session.id,
      kind: changed ? "changed" : "first",
      works: fresh.slice(0, ASK_INDEX_SHOWN).map((entry) => entry.scope),
      told: gisted.map((entry) => entry.scope),
      knowledge,
    });
    return text;
  }

  /**
   * What changed in the contexts this agent chose to read, since it read them: the lines that came
   * and went. Reading a context is subscribing to it; nothing else says what bears on the agent.
   */
  private followedNews(session: LocalSession): string | null {
    const now = Date.now();
    const told: string[] = [];
    for (const [scope, read] of session.read) {
      if (told.length >= 2) break;
      if (now - read.toldAt < FOLLOW_GAP_MS) continue;
      const mirror = this.shared.get(this.sharedKey(session.workspace, session.project, scope));
      if (mirror === undefined || mirror.version <= read.version || !contextWritten(mirror.text)) {
        continue;
      }
      const text = followedChange({
        handle: this.handleOf(session.workspace, session.project, scope),
        name: this.subjectOf(session.workspace, session.project, scope),
        version: mirror.version,
        before: read.text,
        after: mirror.text,
        by:
          mirror.updatedBy === undefined
            ? undefined
            : this.deps.nameOf(mirror.workspace, mirror.updatedBy),
        cli: this.cli,
      });
      // Whatever it said, this is the version the agent has now.
      read.version = mirror.version;
      read.text = mirror.text.slice(0, SHARED_MAX_BYTES);
      read.toldAt = now;
      if (text === null) continue;
      told.push(text);
      this.log("follow.told", { session: session.id, scope, version: mirror.version, text });
    }
    return told.length === 0 ? null : told.join("\n\n");
  }

  /**
   * An entry of the project's `.ai` whose paths name a file the agent changes says so, once: a
   * fact about a file, as a lock is, not a guess about what the agent does.
   */
  private governsNews(session: LocalSession): string | null {
    const book = this.knowledgeBook(session);
    if (
      book.length === 0 ||
      (session.touching.size === session.governsChecked && book === session.governsBook)
    ) {
      return null;
    }
    session.governsChecked = session.touching.size;
    session.governsBook = book;
    const all = governing(book, session.touching, session.knowledgeTold);
    const found = all.slice(0, 3);
    if (found.length === 0) return null;
    // Those left over are said at the next step.
    if (all.length > found.length) session.governsChecked = -1;
    const now = Date.now();
    for (const { entry, pattern, path } of found) {
      session.knowledgeTold.add(entry.id);
      this.noteAdvice(session, {
        about: "knowledge",
        scope: `kx:${entry.id}`,
        name: entry.title,
        how: "governs",
        why: `it governs \`${pattern}\`, and you change \`${path}\``,
        entryKind: entry.kind,
        path: entry.file,
        at: now,
      });
    }
    const text = governingText(found, this.cli);
    this.log("knowledge.governs", {
      session: session.id,
      entries: found.map(({ entry, pattern, path }) => ({ id: entry.id, pattern, path })),
      text,
    });
    return text;
  }

  // ---- the project's `.ai`: read for the index, `peer knowledge` and what governs a file ----

  private knowledgeBook(session: LocalSession): ReadonlyArray<Known> {
    return this.knowledge.get(session.root)?.book ?? [];
  }

  /**
   * Has the repository's `.ai` read for the agent's next steps: at most once a minute, and a hook
   * waits for the read only a moment (a slow disk costs the agent one telling, not a stalled hook).
   */
  private async ensureKnowledge(session: LocalSession): Promise<void> {
    const root = session.root;
    const have = this.knowledge.get(root);
    if (have?.reading !== undefined) {
      await Promise.race([have.reading, sleepMs(KNOWLEDGE_READ_WAIT_MS)]);
      return;
    }
    if (have !== undefined && Date.now() - have.at < KNOWLEDGE_FRESH_MS) return;
    const before = have?.book ?? [];
    const settle = (book: ReadonlyArray<Known>) =>
      this.knowledge.set(root, { at: Date.now(), book, reading: undefined });
    const reading = readKnowledge(root).then(
      (entries) => {
        const book = entries.map(known);
        if (book.length !== before.length) {
          this.log("knowledge.read", { root, entries: book.length });
        }
        settle(book);
      },
      (error: unknown) => {
        this.log("knowledge.failed", { root, error: messageOf(error) });
        settle(before);
      },
    );
    // A computer's agents work in a handful of repositories: the oldest reading makes room.
    if (this.knowledge.size >= 24) {
      const oldest = [...this.knowledge].toSorted(([, a], [, b]) => a.at - b.at)[0];
      if (oldest !== undefined) this.knowledge.delete(oldest[0]);
    }
    this.knowledge.set(root, { at: have?.at ?? 0, book: before, reading });
    await Promise.race([reading, sleepMs(KNOWLEDGE_READ_WAIT_MS)]);
  }

  /** `peer knowledge [<id or words>]`: the entries of the project's `.ai`, one of them, or a search. */
  private async knowledgeCli(session: LocalSession, query: string): Promise<string> {
    await this.ensureKnowledge(session);
    const book = this.knowledgeBook(session);
    if (book.length === 0) {
      return "peer: this checkout has no `.ai` knowledge (no decisions, conventions, learnings or incidents).";
    }
    if (query === "") {
      return (
        knowledgeIndexText(book, { cli: this.cli, shown: 40 }) ?? "peer: nothing stands in `.ai`."
      );
    }
    const hits = searchKnowledge(book, query);
    if (hits.length === 0) {
      return `peer: no entry matches "${clip(query, 80)}". ${this.cli} knowledge lists them.`;
    }
    const [only] = hits;
    if (hits.length > 1 || only === undefined) {
      return [
        `Entries that match "${clip(query, 80)}" (\`${this.cli} knowledge <id>\` reads one):`,
        ...hits.map((entry) => `- ${knowledgeLine(entry)}`),
      ].join("\n");
    }
    session.knowledgeTold.add(only.id);
    this.log("knowledge.opened", { session: session.id, entry: only.id });
    this.noteAdvice(session, {
      about: "knowledge",
      scope: `kx:${only.id}`,
      name: only.title,
      how: "read",
      why: "read it",
      entryKind: only.kind,
      path: only.file,
      at: Date.now(),
    });
    return `${entryText(only)}\n\nThe project's people keep this in \`.ai\`; check your change against it, and if it no longer holds, say so to your person.`;
  }

  // ---- `peer find`: a model looks when the agent cannot tell ----

  /**
   * `peer find "<what you will do>"`: the fallback for an agent that cannot tell from the index
   * what bears on its work. A model (the person's own Claude Code; Sonnet 5.5 at medium effort
   * unless `PEER_RELATED_MODEL` and `PEER_RELATED_EFFORT` say otherwise) reads the goal against the
   * other works, with what their contexts say, and the project's `.ai` entries, and says which bear
   * on it. It runs only when an agent runs the command, in the project's that accept personal logins.
   */
  private async find(session: LocalSession, goal: string): Promise<string> {
    const cli = this.cli;
    const choose = `${cli} index lists the work and the entries to choose from.`;
    if (!modelEnabled()) {
      return `peer: a model is turned off on this computer (PEER_RELATED_MODEL=off). ${choose}`;
    }
    if (!projectAcceptsPersonal(readHubPolicyState(), session.workspace, session.project)) {
      this.log("find.skipped", {
        session: session.id,
        why: "the project does not accept personal capacity",
      });
      return `peer: ${session.project} does not accept the person's own login for this (its capacity policy wants commercial seats or shared capacity). ${choose}`;
    }
    await this.syncNow(session.workspace, 3000);
    await this.ensureKnowledge(session).catch(() => undefined);
    const rows = this.works(session).toSorted(CoordinationBroker.byActivity).slice(0, FIND_WORKS);
    const works: FindWork[] = rows.map((row) => ({
      id: row.entry.scope,
      name: row.entry.name,
      doing:
        row.entry.agents.length === 0 ? "nobody at work on it now" : row.entry.agents.join("; "),
      gist: row.entry.gist,
      // What its agents were asked, then what its context says.
      lines: [
        ...row.labels.slice(0, 2),
        ...(row.text === undefined ? [] : contextLines(row.text, 6)),
      ],
    }));
    const entries: FindEntry[] = standing(this.knowledgeBook(session))
      .slice(0, FIND_ENTRIES)
      .map((entry) => ({
        id: `kx:${entry.id}`,
        kind: entry.kind,
        title: entry.title,
        summary: entry.summary,
        paths: entry.paths,
      }));
    if (works.length === 0 && entries.length === 0) {
      return "peer: there is no other work on this project and no `.ai` entry here to look at.";
    }
    // Check and reserve together after asynchronous reads: another request may have started
    // a model while this one was synchronizing or reading the project's knowledge.
    const now = Date.now();
    session.findTimes.splice(
      0,
      session.findTimes.length,
      ...session.findTimes.filter((at) => now - at < 60 * 60 * 1000),
    );
    const refusal = findRefusal({
      now,
      lastAt: session.findAt,
      lastHour: session.findTimes.length,
      inFlight: this.findsRunning,
    });
    if (refusal !== undefined) return `peer: ${refusal}.`;
    session.findAt = now;
    session.findTimes.push(now);
    this.findsRunning += 1;
    const started = Date.now();
    let output: string;
    try {
      output = await runModel(
        findPrompt({
          goal,
          task:
            session.task === undefined
              ? undefined
              : this.deps.taskName(session.workspace, session.project, session.task),
          works,
          entries,
        }),
        { signal: this.modelAbort.signal },
      );
    } catch (error) {
      this.log("find.failed", {
        session: session.id,
        error: messageOf(error),
        ms: Date.now() - started,
      });
      return `peer: the model could not answer (${messageOf(error)}). ${choose}`;
    } finally {
      this.findsRunning -= 1;
    }
    const found = parseFound(output, new Set([...works, ...entries].map((one) => one.id)));
    this.log("find.asked", {
      session: session.id,
      goal: clip(goal, 200),
      works: works.length,
      entries: entries.length,
      found,
      ms: Date.now() - started,
    });
    return this.foundText(session, found, rows, works.length, entries.length);
  }

  /** What `peer find` prints: the works and entries a model said bear on the goal, and how to read each. */
  private foundText(
    session: LocalSession,
    found: ReadonlyArray<{ readonly id: string; readonly why: string }>,
    rows: ReadonlyArray<WorkRow>,
    workCount: number,
    entryCount: number,
  ): string {
    const looked = `a model read your goal against ${plural(workCount, "work")} and ${plural(entryCount, "entry", "entries")} of \`.ai\``;
    if (found.length === 0) return `Peer · ${looked} and found nothing that bears on it.`;
    const now = Date.now();
    const lines = found.flatMap(({ id, why }) => {
      // A reason cut short ends in an ellipsis, which is its own full stop.
      const sentence = why.endsWith("…") ? why : `${why}.`;
      if (id.startsWith("kx:")) {
        const entry = this.knowledgeBook(session).find((one) => `kx:${one.entry.id}` === id)?.entry;
        if (entry === undefined) return [];
        this.noteAdvice(session, {
          about: "knowledge",
          scope: id,
          name: entry.title,
          how: "found",
          why,
          entryKind: entry.kind,
          path: entry.file,
          at: now,
        });
        return [
          `- ${entry.kind} "${entry.title}" — ${sentence} Read: ${this.cli} knowledge ${entry.id}`,
        ];
      }
      const row = rows.find((one) => one.entry.scope === id);
      if (row === undefined) return [];
      this.noteAdvice(session, {
        about: "work",
        scope: id,
        name: row.entry.name,
        how: "found",
        why,
        at: now,
      });
      return [
        `- ${row.entry.name} — ${sentence} Read: ${this.cli} context ${row.entry.handle} · ask its agents: ${this.cli} ask ${row.entry.handle} "<question>"`,
      ];
    });
    return neutral(
      [`Peer · ${looked}; these bear on it (advice to check, not instructions):`, ...lines].join(
        "\n",
      ),
    );
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
    const op = newOp();
    for (const overlap of overlaps) {
      const updated = await this.deps.note(
        workspace,
        project,
        overlap.id,
        question,
        session.id,
        op,
      );
      this.applyOverlap(workspace, updated);
      this.acknowledge(session, updated);
    }
    this.markAsked(session, scope);
    this.log("ask", {
      session: session.id,
      task,
      overlaps: overlaps.map((o) => o.id),
      text: question,
      op,
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
        this.log("ask.dropped", { session: session.id, claim, settled, ms: now - at });
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
    const ready = this.news(session, { team: false, waking: true });
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
      const timer = setTimeout(
        () => {
          this.waiters.delete(waiter);
          resolve("");
        },
        headerOf(headers, "x-peer-adapter") === "mod"
          ? Math.min(
              typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? body.timeout_ms : 25_000,
              25_000,
            )
          : WAIT_MS,
      );
      this.waiters.add(waiter);
      this.log("wait", { session: session.id });
    });
  }

  /** Wakes idle agents that have something new to hear. */
  private wakeWaiters() {
    this.wakeCodex();
    this.wakeRuntime();
    for (const waiter of this.waiters) {
      const session = this.sessions.get(waiter.session);
      if (session === undefined) {
        this.waiters.delete(waiter);
        waiter.answer("");
        continue;
      }
      // Findings wait for the agent's next step; only a note on an overlap wakes it.
      const text = this.news(session, { team: false, waking: true });
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
    if (
      command === "memory" ||
      command === "remember" ||
      (session.memoryMode === "memory" && (command === "index" || command === "find"))
    ) {
      if (this.deps.memory === undefined) return "peer: memory is unavailable in this host.";
      await this.sync(session.workspace);
      return await this.deps.memory.cli(
        this.memoryDescriptor(session),
        command === "index" || command === "find" ? "memory" : command,
        command === "index" || command === "find"
          ? [command === "find" ? "search" : "index", ...args]
          : args,
      );
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
          now: Date.now(),
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
        // One command, one op; each overlap's note carries it with the overlap's id, so that it is
        // never taken for another's however the hub scopes it.
        const op = newOp();
        for (const overlap of targets) {
          const updated = await this.deps.note(
            session.workspace,
            session.project,
            overlap.id,
            text,
            session.id,
            `${op}:${overlap.id}`.slice(0, 64),
          );
          this.applyOverlap(session.workspace, updated);
          this.acknowledge(session, overlap);
        }
        this.log("note.agent", { session: session.id, overlaps: targets.map((o) => o.id), text });
        const closes = targets.every((o) => closerOf(o, view().sessions) === session.id);
        return `Noted on overlap ${targets.map((o) => shortId(o.id)).join(", ")}; the other agent hears it at its next step, or wakes up if idle. ${closes ? `Once you agree, close it: ${this.cli} resolve "<agreement>".` : "Once you agree, the other agent closes it."}`;
      }
      case "resolve": {
        if (text === "")
          return `peer: say what was agreed, e.g. ${this.cli} resolve "they rename first, I rebase"`;
        await this.syncNow(session.workspace, 3000);
        const targets = mine("open");
        if (targets.length === 0) return "peer: no open overlap to resolve.";
        const op = newOp();
        for (const overlap of targets) {
          const updated = await this.deps.resolve(
            session.workspace,
            session.project,
            overlap.id,
            text,
            session.id,
            `${op}:${overlap.id}`.slice(0, 64),
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
      case "review":
      case "done": {
        if (session.task === undefined || this.deps.finishTask === undefined)
          return "peer: this session must be on a task to hand it off.";
        const refusal = await this.handoffRefusal(session);
        if (refusal !== null) return refusal;
        try {
          await this.deps.finishTask(
            session.workspace,
            session.project,
            session.task,
            session.id,
            command,
            newOp(),
          );
          return `Task moved to ${command} with current shared input versions.`;
        } catch (error) {
          return `peer: the hub refused handoff: ${messageOf(error)}. Read the changed inputs and retry.`;
        }
      }
      case "ack": {
        const handle = plain[0];
        const scope =
          handle === undefined
            ? undefined
            : this.scopeNamed(session.workspace, session.project, handle);
        if (scope === undefined)
          return `peer: name the task whose changed context you accept. ${this.cli} ack <task>`;
        const current = await this.deps
          .readContext(session.workspace, session.project, scope)
          .catch(() => null);
        if (current === null || current.version === 0)
          return "peer: no current shared context is available.";
        if (this.deps.contextRead === undefined)
          return "peer: this hub cannot record version acknowledgements.";
        try {
          await this.deps.contextRead(
            session.workspace,
            session.project,
            scope,
            session.id,
            current.version,
            newOp(),
          );
          this.markRead(session, scope, current.version, current.text);
          this.log("context.ack", { session: session.id, scope, version: current.version });
          return `Acknowledged the change to ${handle}, version ${current.version}. You remain responsible for checking how it affects your work.`;
        } catch {
          return "peer: the context changed again or the hub is unreachable. Read and confirm its current version.";
        }
      }
      case "log": {
        if (this.deps.coordEvents === undefined)
          return "peer: this hub does not provide coordination history.";
        const task = flag("--task");
        const path = flag("--path");
        const scope =
          task === undefined
            ? undefined
            : this.scopeNamed(session.workspace, session.project, task);
        const events = await this.deps
          .coordEvents(session.workspace, session.project, {
            ...(scope?.startsWith("task:") ? { task: scope.slice(5) } : {}),
            ...(path === undefined ? {} : { path }),
            limit: 50,
          })
          .catch(() => null);
        if (events === null) return "peer: the hub cannot be reached now.";
        return events.length === 0
          ? "No coordination events yet."
          : events
              .map(
                (event) =>
                  `${event.at} ${event.kind} ${event.scope ?? event.task ?? ""}${event.version === undefined ? "" : ` v${event.version}`} ${event.paths.join(", ")}`,
              )
              .join("\n");
      }
      case "ask": {
        const [handle, ...rest] = plain;
        const question = clip(rest.join(" "), 600);
        if (handle === undefined || question === "") {
          return `peer: say which task and what to ask, e.g. ${this.cli} ask VL1 "Where do you keep the speaker names?"`;
        }
        return this.ask(session, handle, question);
      }
      case "index": {
        // The project's other work and its `.ai`, as at a start but all of it.
        await this.syncNow(session.workspace, 3000);
        await this.ensureKnowledge(session);
        const works = this.indexWorks(session, INDEX_ALL);
        for (const entry of works)
          if ((entry.version ?? 0) > 0) session.boardHeard.add(entry.scope);
        return (
          indexText({
            works,
            knowledge: knowledgeIndexText(this.knowledgeBook(session), {
              cli: this.cli,
              shown: 40,
            }),
            now: Date.now(),
            cli: this.cli,
            shown: INDEX_ALL,
            full: true,
          }) ?? "peer: no other work on this project now, and no `.ai` knowledge in this checkout."
        );
      }
      case "knowledge":
        return this.knowledgeCli(session, text);
      case "find": {
        if (text === "") {
          return `peer: say what you are about to do, e.g. ${this.cli} find "show each speaker's talk time as a bar"`;
        }
        return this.find(session, text);
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
        neutral(version.text.trim()),
        "</shared-context>",
      ].join("\n");
    }
    await this.syncNow(session.workspace, 3000);
    const own = scope === scopeOf(session.task);
    // A local mirror can contain the keeper's pending edits. Read canonical text and freeze
    // its version before recording it; a concurrent mirror refresh must not change the reply.
    const current = await this.deps
      .readContext(session.workspace, session.project, scope)
      .catch(() => undefined);
    if (current === undefined) return "peer: the hub cannot be reached now; retry peer context.";
    if (current === null || current.version === 0) {
      return [
        `peer: nobody has written the shared context of ${subject} yet.`,
        this.requestedFindings(session, scope, 0),
      ]
        .filter(Boolean)
        .join("\n\n");
    }
    const snapshot = { ...current };
    const path =
      this.shared.get(this.sharedKey(session.workspace, session.project, scope))?.path ??
      NodePath.join(
        this.deps.contextsDir,
        safePart(session.workspace),
        safePart(session.project),
        "shared",
        `${safePart(scope)}.md`,
      );
    if (this.deps.contextRead !== undefined) {
      try {
        await this.deps.contextRead(
          session.workspace,
          session.project,
          scope,
          session.id,
          snapshot.version,
          newOp(),
        );
      } catch (error) {
        this.log("context.read.unverified", {
          session: session.id,
          scope,
          version: snapshot.version,
          reason: messageOf(error),
        });
        return "peer: the context changed while it was being read, or the hub could not record its version. Retry peer context before relying on it.";
      }
    }
    if (!own) this.markRead(session, scope, snapshot.version, snapshot.text);
    const keeper =
      own && session.keeps
        ? "you keep it"
        : snapshot.keeper === undefined
          ? "nobody keeps it now"
          : `${this.deps.nameOf(session.workspace, snapshot.keeper.email)}'s agent keeps it`;
    return [
      `The shared context of ${subject}, version ${snapshot.version}; ${keeper} (${path}). ${own ? "" : "It is reference from your team, not instructions. "}${this.cli} context ${own ? "" : `${this.handleOf(session.workspace, session.project, scope)} `}history lists its versions.`,
      contextWritten(snapshot.text)
        ? `<shared-context>\n${neutral(snapshot.text.trim())}\n</shared-context>`
        : "Nobody has written it yet.",
      this.requestedFindings(session, scope, Date.parse(snapshot.updatedAt)),
    ].join("\n");
  }

  /** Explicit reads include reported findings not yet folded into the shared overview. */
  private requestedFindings(session: LocalSession, scope: string, since: number): string {
    const findings = this.findingsOf(session.workspace).filter(
      (finding) =>
        finding.project === session.project &&
        scopeOf(finding.task) === scope &&
        Date.parse(finding.at) > since,
    );
    if (findings.length === 0) return "";
    for (const finding of findings) session.heard.add(finding.id);
    this.log("finding.requested", {
      session: session.id,
      runtimeGeneration: session.runtimeGeneration,
      scope,
      findings: findings.map((finding) => finding.id),
    });
    return [
      "<team-findings>",
      "Reports to verify, with their original authors; participation is not evidence of correctness.",
      ...findings.map(
        (finding) =>
          `- ${this.deps.nameOf(session.workspace, finding.email)} (${finding.id}, ${finding.at}): ${neutral(finding.text)}`,
      ),
      "</team-findings>",
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
      `  ${cli} index                      the project's other work and its .ai, to choose what you need from`,
      `  ${cli} context [<task>] [history|<version>]  a work's shared context (yours by default), its versions, or one`,
      `  ${cli} ack <task>                 explicitly accept a changed shared context version`,
      `  ${cli} log [--task <key>] [--path <path>] committed coordination history`,
      `  ${cli} knowledge [<id or words>]  the project's decisions, conventions, learnings and incidents: list, search or read one`,
      `  ${cli} find "<what you will do>"   a model looks for what bears on it, when you cannot tell`,
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
        runtimeGeneration: s.runtimeGeneration,
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
        findings: s.memoryMode === "memory" ? [] : [...new Set([...s.team, ...s.marked])],
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
      if (
        session.agent !== "codex" ||
        session.status !== "idle" ||
        (session.pane !== undefined && session.thread === undefined)
      )
        continue;
      if (this.queueing.has(session.id)) continue;
      const text = this.news(session, { team: false, waking: true });
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

  private wakeRuntime() {
    const wake = this.deps.wakeRuntime;
    if (wake === undefined) return;
    for (const session of this.sessions.values()) {
      if (
        session.status !== "idle" ||
        session.pane === undefined ||
        session.thread !== undefined ||
        this.coordinationLevel(session.id) === "A" ||
        this.queueing.has(session.id)
      )
        continue;
      if ([...this.waiters].some((waiter) => waiter.session === session.id)) continue;
      const text = this.news(session, { team: false, waking: true });
      if (text === null) continue;
      session.pending.push(text);
      this.queueing.add(session.id);
      void wake(session.id, session.pane, "[Peer coordination update]").then(
        (outcome) => {
          this.log(`runtime.wake.${outcome.status}`, {
            session: session.id,
            reason: outcome.reason,
          });
          if (outcome.status === "unavailable") this.queueing.delete(session.id);
        },
        (error: unknown) => {
          this.queueing.delete(session.id);
          this.log("runtime.wake.unavailable", { session: session.id, reason: messageOf(error) });
        },
      );
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
        const runtime = this.deps.runtimeStatus?.(id, session.thread, session.pane);
        if (
          !runtimeStillPresent({
            runtime,
            lastActivity: session.lastActivity,
            lastPresent: session.lastPresent ?? session.startedAt,
            now,
          })
        ) {
          void this.release(session);
          if (this.deps.memory !== undefined)
            void this.deps.memory.end(this.memoryDescriptor(session));
          this.sessions.delete(id);
          this.log("session.expired", { session: id });
          continue;
        }
        // Presence is not activity: an idle runtime must not refresh the keeper's activity clock.
        if (runtime !== undefined && runtime !== null) {
          session.status = runtime === "done" ? "idle" : runtime;
          session.lastPresent = now;
        }
        await this.findThread(session);
        // Put on another task (or taken off one): its work, and the shared context with it, change.
        const task = this.taskFor(session);
        if (task !== session.task) {
          await this.release(session);
          this.log("session.task", { session: id, from: session.task, to: task });
          const from = session.task;
          session.task = task;
          session.sharedHeard = 0;
          session.sharedHeardText = "";
          // What belonged to its old work is no part of the new: lines it marked for the project,
          // the contexts it read for it, whom the roster was kept for.
          session.marked.clear();
          session.read.clear();
          session.toldClosed = false;
          session.sharedToldAt = 0;
          session.roster = undefined;
          session.compactedAt = 0;
          const name = (t: string | undefined) =>
            t === undefined ? "no task" : this.deps.taskName(session.workspace, session.project, t);
          session.pending.push(
            `Peer: your person put you on ${name(task)} (you were on ${name(from)}). Its shared context is ${this.cli} context${task === undefined ? "" : ` ${this.handleOf(session.workspace, session.project, scopeOf(task))}`}; your working context stays ${session.ownContextPath}.`,
          );
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
          this.reportedSessions.set(workspace, new Set(sessions.map((s) => s.id)));
          this.views.set(workspace, view);
          this.viewAt.set(workspace, Date.now());
          if (this.deps.memory !== undefined)
            for (const session of this.sessions.values()) {
              if (session.workspace !== workspace) continue;
              const before = session.memoryMode;
              const prepared = await this.deps.memory
                .prepare(this.memoryDescriptor(session), "mode")
                .catch(() => undefined);
              if (prepared === undefined) continue;
              this.applyMemoryMode(session, prepared.mode, prepared.currentPath);
              if (before !== prepared.mode) {
                await this.restoreContext(session);
                session.pending.push(
                  `Peer Memory mode is ${prepared.mode}; your working context is ${session.contextPath}. New memory records and pending local writes are preserved.`,
                );
              }
            }
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
      if (url === "/delivery" || url === "/usage") {
        if (request.method !== "POST" || headerOf(request.headers, "x-peer-adapter") !== "mod") {
          respond(response, 400, "");
          return;
        }
        const body = parseJson(raw);
        const session = this.sessions.get(`claude:${String(body.session_id)}`);
        if (session === undefined || session.modAt === undefined) {
          respond(response, 404, "");
          return;
        }
        if (url === "/delivery") {
          const receipt = session.deliveries.get(String(body.id));
          if (receipt === undefined || body.evidence !== "model-input") {
            respond(response, 400, "");
            return;
          }
          if (!receipt.acknowledged) {
            receipt.acknowledged = true;
            session.injected.set(
              receipt.event,
              (session.injected.get(receipt.event) ?? 0) + receipt.text.length,
            );
            this.log("delivery.verified", {
              session: session.id,
              runtimeGeneration: session.runtimeGeneration,
              id: body.id,
              evidence: body.evidence,
              chars: receipt.text.length,
            });
          }
        } else {
          const usage =
            typeof body.usage === "object" && body.usage !== null
              ? Object.fromEntries(
                  Object.entries(body.usage)
                    .filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n >= 0)
                    .slice(0, 30),
                )
              : {};
          if (Object.keys(usage).length === 0) {
            respond(response, 400, "");
            return;
          }
          this.log("provider.usage", {
            session: session.id,
            runtimeGeneration: session.runtimeGeneration,
            usage,
            turnId: typeof body.turnId === "string" ? body.turnId : undefined,
            index: typeof body.index === "number" ? body.index : undefined,
            agentId: typeof body.agentId === "string" ? body.agentId : undefined,
          });
        }
        respond(response, 204, "");
        return;
      }
      if (url === "/hook" || url === "/hook/wait") {
        const body = parseJson(raw);
        if (url === "/hook") {
          const out = await this.hookInTime(body, request.headers);
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

/** What a hook may carry: a shell command's whole output comes with it. Past this, Peer reads nothing of it. */
const MAX_BODY = 16 * 1024 * 1024;

function readBody(request: NodeHttp.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let over = false;
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      if (over) return;
      raw += chunk;
      if (raw.length > MAX_BODY) {
        over = true;
        raw = "";
      }
    });
    // A request that goes away must not leave its handler waiting for good.
    const done = () => resolve(over ? "" : raw);
    request.on("end", done);
    request.on("close", done);
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
