export type NodeId = string; // Claude Code message uuid
export type SessionId = string;

/**
 * The harness a session belongs to. Each stores transcripts differently:
 *
 * - `claude`   — ~/.claude/projects/**.jsonl, a native DAG (uuid/parentUuid);
 *                a VS Code "fork conversation" is a NEW file holding a copy of
 *                one chain of the source, matched back to it by API message ids;
 * - `codex`    — ~/.codex/sessions/Y/M/D/rollout-*.jsonl[.zst], paginated:
 *                each page links to the page it continues via `history_base`,
 *                so forks and prompt edits form an exact tree of pages;
 * - `copilot`  — ~/.copilot/session-state/<id>/events.jsonl, a linear
 *                id/parentId event chain; forks are copy-truncated dirs.
 */
export type ProviderId = "claude" | "codex" | "copilot";

export type NodeStatus = "dead-end" | "favorite";
export type NodeRole = "user" | "assistant";

/**
 * One turn, as a provider projects it from a harness's transcript records.
 *
 * Lineage comes from the harness's own data (Claude's uuid/parentUuid DAG,
 * Codex's page graph, Copilot's event chain), never from a store of our own.
 * Everything here except the sidecar metadata is strictly read-only.
 */
export interface TurnNode {
  id: NodeId;
  parentId: NodeId | null;
  role: NodeRole;
  text: string;
  thinking?: string;
  toolUses?: string[];

  usage?: UsageSnapshot;
  /**
   * Usage of the LAST API call in a merged agent-loop run. `usage` sums the
   * whole run — the honest cost of the turn, but useless for "how big is the
   * context here": every call replays history, so the sum over-counts it. The
   * final call's prompt already contains everything before it.
   */
  lastUsage?: UsageSnapshot;
  model?: string;
  stopReason?: string | null;
  /** When the node STARTS: its first record. Shown, and orders siblings. */
  timestamp: number;
  /**
   * When its LAST part was written, where that is later than `timestamp`: a
   * reply streamed as several records, or a merged run. Which branch was
   * active last is decided by this end (`endOf`), never by the start.
   */
  endedAt?: number;
  /** Claude Code marks subagent turns; we dim them. */
  isSidechain?: boolean;
  /**
   * Reconstructed from a queued message that was delivered into a running turn.
   * The model saw it, but Claude Code never wrote a transcript record for it —
   * so it has no uuid of its own and cannot be a resume point. Modern CLIs
   * record these as `queued_command` attachments instead (see `midTurn`); this
   * flag survives only for transcripts predating that.
   */
  injected?: boolean;
  /**
   * A mid-turn ("/btw") message backed by a real `queued_command` attachment
   * record. Unlike `injected`, the record IS in the lineage, so any fork of a
   * LATER turn retains this message — but the attachment uuid itself is not a
   * valid resume anchor, so the node cannot be forked at directly.
   */
  midTurn?: boolean;
  /**
   * This turn's resume anchor lies before the session's last `/compact`
   * boundary. The CLI only indexes messages after the last compaction, so a
   * fork here is impossible — the loader answers "No message found".
   */
  preCompact?: boolean;
  /**
   * Ids of turns folded into this node by the consecutive-assistant merge.
   * Kept so sidecar annotations written against an absorbed turn still resolve,
   * and so the panel can say how many turns a node represents.
   */
  absorbedIds?: NodeId[];
  /**
   * Semantic identity of the message(s) this node draws: the same in every
   * session holding a copy, whatever uuid each copy got (Claude:
   * `m:<message.id>` / `p:<promptId>|<digest>`; Codex: `<turnId>:<itemId>`;
   * text-only evidence is qualified by its parent's identity — see
   * electron/identity.ts). The node's own comes first, then any merged-in
   * parts'. Keys annotations, and keeps a selection across a reload that
   * re-roots the family.
   */
  stableIds?: string[];
  /**
   * The same parts' identities under the previous identity scheme, where they
   * differ — only so annotations saved under it are still found.
   */
  legacyIds?: string[];
  /**
   * The other sessions of the family that hold a copy of this turn, with the
   * id it has there. Stitching draws one node per turn; this keeps where else
   * it lives (`sourceSessionId` is the one drawn). Physical copies only; who
   * holds the turn is `heldBy`.
   */
  occurrences?: { sessionId: SessionId; id: NodeId }[];
  /**
   * Every member session whose history holds ALL of this node: the sessions
   * that open or resume onto it. Claude and Copilot: its owner and every
   * session with a copy (the display merge never folds across a session's
   * endpoint, so a copy of one part is a copy of all); Codex: the threads
   * whose current history holds the turn — a fork by reference copies
   * nothing. Set by the provider on a loaded family.
   */
  heldBy?: SessionId[];
  /**
   * The harness's own unit of work this node belongs to, where it has one
   * (Codex: the turn id). The display merge never folds across it, because a
   * fork can only cut between such units.
   */
  turnId?: string;
  /**
   * Why a fork can't be anchored at this node — absent when it can. Decided
   * by the provider while it builds the tree, from what the harness can
   * actually resume (Claude: no record, or before the last /compact; Codex:
   * not the end of a whole turn, or a branch no thread still holds), and kept
   * through the display merge: a merged node is forkable only if its LAST
   * part is, so a fork never stops before text the node shows. The panel
   * shows it instead of offering the fork; the fork call refuses with it.
   */
  forkBlocked?: string;
  /**
   * uuid of the LAST raw transcript record this node covers.
   *
   * `id` is the first record of the turn, but a turn spans several records —
   * one per content block, plus whatever the same-role merge folded in. To fork
   * *after* a turn, Claude Code needs the record the turn ends on; pointing it
   * at `id` would resume in the middle of a reply.
   */
  lastRawId?: NodeId;
  /**
   * The session (transcript file / thread) this turn belongs to. A family tree
   * mixes turns from several sessions; resume, open and fork act on this one.
   */
  sourceSessionId?: SessionId;
  /**
   * The edge INTO this node starts a branch stored apart from its parent:
   * `fork` — a new session (Claude fork file, Codex fork thread, Copilot
   * copy); `edit` — a Codex prompt edit, a new page of the SAME thread.
   * Drawn dashed either way; only a fork is a separate chat with its own name.
   */
  branchKind?: "fork" | "edit";

  // ---- sidecar metadata (Agentree's own store, never written to the transcript)
  label?: string;
  status?: NodeStatus;
  note?: string;
}

export interface UsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface SessionMeta {
  id: SessionId;
  provider: ProviderId;
  /** Working directory the session belongs to — needed to resume it in the CLI. */
  cwd: string;
  project: string;
  title: string;
  /**
   * Last conversational activity: the newest record that is part of the
   * conversation — a message, a tool call or result, a delivered mid-turn
   * message, a compaction — on any member. Which records count is a
   * per-harness rule (docs/design.md, "Welcome screen"); bookkeeping a harness
   * writes when it merely loads a thread doesn't. The list sorts by this.
   */
  activeAt: number;
  /** Newest timestamp on ANY record of any member ("last file change"). */
  touchedAt: number;
  nodeCount: number;
  branchPoints: number;
  /**
   * Ready-to-paste command that resumes this session at its tip, built by the
   * provider — the renderer must not hard-code any one CLI's flag spelling.
   */
  resumeCommand: string;
  /** Sessions stitched into this entry's tree (1 when it was never forked). */
  members?: number;
  /**
   * The family's other sessions — its forks, and forks of forks — newest
   * activity first. Enough for the card to name them and for search to
   * find them, without loading the tree.
   */
  forks?: ForkSummary[];
  /** Where the session was driven from, e.g. "claude-vscode" or "cli". */
  entrypoint?: string;
  /** Every session of the family is archived (listed only when the settings ask for it). */
  archived?: boolean;
}

/** A non-root member of a fork family, as the welcome list needs it. */
export interface ForkSummary {
  id: SessionId;
  title: string;
  activeAt: number;
  cwd: string;
}

/** One session of a fork family, as listed in the panel. */
export interface MemberInfo {
  id: SessionId;
  title: string;
  /** The session this one was forked from; null for the family root. */
  parentId: SessionId | null;
  /**
   * How `parentId` is known. `explicit`: the harness or Agentree recorded it
   * (Codex `forked_from_id`, `forkedFrom`, the lineage sidecar). `inferred`:
   * shared history proves the two are related, but the direction is a guess
   * from file creation order (the Claude extension's own forks record
   * nothing), so the panel says so.
   */
  parentEvidence?: "explicit" | "inferred";
  cwd: string;
  resumeCommand: string;
  /** See SessionMeta.activeAt / touchedAt; this member's own. */
  activeAt: number;
  touchedAt: number;
  archived?: boolean;
  entrypoint?: string;
  /**
   * Where the session is stored: one transcript, or — a moved repo keeps its
   * session id — one copy per project folder, read as one session (Claude).
   */
  files?: string[];
  /**
   * The node to land on when the tree is opened on this session: the newest
   * leaf among the nodes it holds (`TurnNode.heldBy`) — its own, or copied
   * (or, in Codex, inherited) from its parent. A fork with no turn of its own
   * yet lands on the turn it was forked at, and nothing past it.
   */
  tipId?: NodeId;
}

export interface SessionDetail {
  meta: SessionMeta;
  nodes: TurnNode[];
  members: MemberInfo[];
}

/** A session to hand to its native harness (VS Code extension or CLI). */
export interface SessionRef {
  provider: ProviderId;
  sessionId: SessionId;
  cwd: string;
}

/**
 * The cut "fork after this turn" makes, as the user saw it: the drawn node,
 * and the record its LAST part ends on (`lastRawId`) in the session it is
 * drawn from. A node id names a display group's head, not where the group
 * ends — new membership can split or extend a group under the same head —
 * so the backend forks at the node that still ends there (`resolveForkPoint`)
 * or refuses; it never reads an old head id as a different range.
 */
export interface ForkPoint {
  nodeId: NodeId;
  sessionId?: SessionId;
  endId: NodeId;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * What a provider saw on its last scan — the "fail loudly" surface. A harness
 * that changes its format shows up here as files seen but not parsed, or as
 * record types nobody has taught the parser about, instead of as a silently
 * empty list.
 */
export interface ProviderHealth {
  provider: ProviderId;
  root: string;
  /** Root directory exists at all — false just means "not installed". */
  present: boolean;
  filesSeen: number;
  /** Files deliberately not listed (guardian reviews, subagents, bookkeeping-only). */
  skipped: number;
  /** Files that produced a session. */
  sessionsParsed: number;
  /**
   * Files that SHOULD have produced a session but didn't: unreadable,
   * malformed, or holding conversation records the parser couldn't turn into
   * a single turn. Kept apart from `skipped` so a format change can't pass
   * for intentional emptiness.
   */
  failed: number;
  /** Entries on the welcome screen (one per fork family). */
  listed: number;
  /** e.g. {"codex-cli 0.162": 44}. */
  formatVersions: Record<string, number>;
  unknownRecordTypes: Record<string, number>;
  backend: "raw" | "api";
  warnings: string[];
  error?: string;
}

// ---------------------------------------------------------------- settings

/**
 * Agentree's settings (`~/.agentree/settings.json`). A setting changes WHAT
 * YOU SEE or WHERE DATA LIVES — never how a transcript is interpreted: a tree
 * that depends on configuration the reader can't see is a bug nobody can
 * reproduce.
 */
export interface Settings {
  /** Sort (and date) the list by last conversational activity, or by last file change. */
  sortBy: "active" | "touched";
  /** Agents to scan at all. Off skips the scan; the list chips are only a filter. */
  providers: Record<ProviderId, boolean>;
  /** List Codex families whose every thread is archived (hidden by default). */
  showArchivedCodex: boolean;
  /** Keep compress-chains and the list filters across launches, in `view`. Off, no `view` is kept. */
  rememberView: boolean;
  view?: ViewState;
  /** Open a fresh fork in the harness's chat panel. Unset: yes in VS Code, no in the desktop app. */
  openForkInChat?: boolean;
  /** Data locations. The environment variable, when set, still wins. */
  paths: SettingsPaths;
  /** Desktop app only: check for a newer build at launch. */
  updateCheck: boolean;
}

export interface ViewState {
  compress: boolean;
  cwdFilter: string;
  providerFilter: ProviderId | "";
}

export interface SettingsPaths {
  /** `CLAUDE_CONFIG_DIR`. */
  claudeConfigDir?: string;
  /** `CODEX_HOME`. */
  codexHome?: string;
  /** `COPILOT_HOME`. */
  copilotHome?: string;
  /** `AGENTREE_CODEX_BIN`. */
  codexBin?: string;
}

/** A change to the settings. `null` clears an optional field (JSON drops `undefined`). */
export interface SettingsPatch {
  sortBy?: Settings["sortBy"];
  providers?: Partial<Record<ProviderId, boolean>>;
  showArchivedCodex?: boolean;
  rememberView?: boolean;
  view?: ViewState | null;
  openForkInChat?: boolean | null;
  paths?: { [K in keyof SettingsPaths]?: string | null };
  updateCheck?: boolean;
}

/** The settings, plus what overrides them, for the settings panel. */
export interface SettingsState {
  settings: Settings;
  /** Path settings an environment variable currently overrides, with its value. */
  env: { [K in keyof SettingsPaths]?: string };
  /** `AGENTREE_NO_UPDATE_CHECK` is set. */
  updateCheckDisabledByEnv: boolean;
  /** Where the settings live. */
  file: string;
}

/** Result of the launch-time "is this the latest build?" check. */
export interface UpdateInfo {
  /** Short commit sha (or version) of the running build. */
  current: string;
  /** Short commit sha (or version) of the latest build on GitHub. */
  latest: string;
  /** Ready-to-paste command that performs the update. */
  command: string;
}

// ---------------------------------------------------------------- IPC contract

/** The only fields Agentree itself owns; everything else is read-only. */
export type NodeMeta = Pick<TurnNode, "label" | "status" | "note">;

/**
 * The complete renderer→main surface, exposed on `window.agentree` by the
 * preload script. There is no HTTP server and no localhost port.
 */
export interface AgentreeApi {
  listSessions(): Promise<SessionMeta[]>;
  getSession(id: string): Promise<SessionDetail | null>;
  /**
   * Annotate a turn of the family `sessionId` belongs to. Written to every
   * member's sidecar under every id the turn has there, so the annotation
   * survives the family being re-rooted or a member being deleted.
   */
  patchNode(sessionId: string, nodeId: string, patch: NodeMeta): Promise<void>;
  /**
   * Fork the session just after the selected node: a NEW session holding the
   * prefix up to and including where that node ended when it was drawn
   * (`ForkPoint`), created in the harness's own fork format (Claude) or
   * through its API (Codex). Refused when the node carries `forkBlocked`, or
   * no longer ends there. Originals are never modified; the family tree picks
   * the fork up.
   */
  forkAt(sessionId: string, point: ForkPoint): Promise<ForkResult>;

  /** Which shell the renderer runs in; decides which actions are offered. */
  readonly host: "electron" | "vscode";
  /** One row per provider, from the most recent scan. */
  providerHealth(): Promise<ProviderHealth[]>;
  getSettings(): Promise<SettingsState>;
  /** Apply a change and return the result. The caller refreshes what depends on it. */
  setSettings(patch: SettingsPatch): Promise<SettingsState>;
  /**
   * Open the session in its harness's VS Code extension: in-process in the
   * extension, through the extension's `vscode://` link from the desktop app.
   * The extension reads its own configuration, not Agentree's store paths.
   */
  openNative(ref: SessionRef): Promise<ActionResult>;
  /**
   * Run the harness's resume command in a new terminal — integrated in VS
   * Code, an OS window from the desktop app — with the environment that
   * points the harness at the store Agentree read the session from.
   */
  resumeInTerminal(ref: SessionRef): Promise<ActionResult>;

  /**
   * Watch a session's transcript (or, with `null`, the whole projects tree) and
   * fire the callback when it changes on disk. Returns an unsubscribe function.
   */
  watch(sessionId: string | null, onChange: (sessionId: string | null) => void): () => void;

  /**
   * Fires at most once per launch, if the main process's GitHub check found a
   * newer build than the one running. Returns an unsubscribe function.
   */
  onUpdateAvailable(cb: (info: UpdateInfo) => void): () => void;
}

/** Outcome of a fork. `ok: false` carries a reason fit to show the user. */
export type ForkResult =
  | {
      ok: true;
      /** The new session. Agentree stitches it into the family tree. */
      id: SessionId;
      cwd: string;
      /** Ready-to-paste command that resumes the fork, in the host OS's shell syntax. */
      command: string;
      /** Hand the fork to the harness's VS Code extension. */
      open?: SessionRef;
      /** Provider-specific caveat worth showing next to the command. */
      note?: string;
    }
  | { ok: false; error: string };
