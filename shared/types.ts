export type NodeId = string; // Claude Code message uuid
export type SessionId = string;

export type NodeStatus = "dead-end" | "favorite";
export type NodeRole = "user" | "assistant";

/**
 * One turn, projected from a Claude Code transcript record.
 *
 * The transcript is already a DAG — every record carries `uuid` and
 * `parentUuid` — so we read their lineage rather than maintaining our own.
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
  timestamp: number;
  /** Claude Code marks subagent turns; we dim them. */
  isSidechain?: boolean;
  /**
   * Reconstructed from a queued message that was delivered into a running turn.
   * The model saw it, but Claude Code never wrote a transcript record for it —
   * so it has no uuid of its own and cannot be a resume point.
   */
  injected?: boolean;
  /**
   * Ids of turns folded into this node by the consecutive-assistant merge.
   * Kept so sidecar annotations written against an absorbed turn still resolve,
   * and so the panel can say how many turns a node represents.
   */
  absorbedIds?: NodeId[];
  /**
   * uuid of the LAST raw transcript record this node covers.
   *
   * `id` is the first record of the turn, but a turn spans several records —
   * one per content block, plus whatever the same-role merge folded in. To fork
   * *after* a turn, Claude Code needs the record the turn ends on; pointing it
   * at `id` would resume in the middle of a reply.
   */
  lastRawId?: NodeId;

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
  /** Working directory the session belongs to — needed to resume it in the CLI. */
  cwd: string;
  project: string;
  title: string;
  updatedAt: number;
  nodeCount: number;
  branchPoints: number;
}

export interface SessionDetail {
  meta: SessionMeta;
  nodes: TurnNode[];
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
  patchNode(sessionId: string, nodeId: string, patch: NodeMeta): Promise<void>;
  /**
   * Build the `claude --resume … --resume-session-at …` command that continues
   * the session just after `nodeId`; the new exchange branches there, in this
   * same tree. Read-only — nothing is written until the user runs it.
   */
  forkAt(sessionId: string, nodeId: string): Promise<ForkResult>;

  /**
   * Watch a session's transcript (or, with `null`, the whole projects tree) and
   * fire the callback when it changes on disk. Returns an unsubscribe function.
   */
  watch(sessionId: string | null, onChange: (sessionId: string | null) => void): () => void;
}

/** Outcome of a fork. `ok: false` carries a reason fit to show the user. */
export type ForkResult =
  | {
      ok: true;
      /** The session to resume — the SAME id; the branch lives in this tree. */
      id: SessionId;
      cwd: string;
      /** Ready-to-paste shell command. */
      command: string;
    }
  | { ok: false; error: string };
