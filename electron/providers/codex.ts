import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  assignTips,
  childIndex,
  copyHolders,
  countBranchPoints,
  FORK_POINT_GONE,
  forkSummaries,
  resolveForkPoint,
} from "../../shared/render.ts";
import type {
  ForkPoint,
  ForkResult,
  MemberInfo,
  ProviderHealth,
  SessionDetail,
  SessionId,
  SessionMeta,
  TurnNode,
  UsageSnapshot,
} from "../../shared/types.ts";
import { HealthScan, minorVersion } from "../health.ts";
import { applyAnnotations } from "../meta.ts";
import { codexArchived, codexIndex, codexSessions } from "../paths.ts";
import { readSettings } from "../settings.ts";
import { resumeCommandFor } from "../launch.ts";
import { mergeSameRoleRuns } from "../transcripts.ts";
import { forkThread } from "./codex-appserver.ts";
import { assignStableIds, foldedTextKey, textKey } from "../identity.ts";
import { stitchFamily, type FamilyMember } from "./stitch.ts";

/**
 * Codex rollouts, paginated format (codex-cli ≥ ~0.151, 2026-09 on).
 *
 * A thread's history is a chain of PAGE files:
 *
 *   sessions/Y/M/D/rollout-<stamp>-<threadId>.jsonl[.zst]            first page
 *   sessions/Y/M/D/rollout-<stamp>-<threadId>_<pageId>.jsonl[.zst]   later pages
 *
 * Every non-first page starts with a `session_meta` whose `history_base`
 * `{thread_id: <pageId>, end_ordinal_exclusive}` says "my history is that
 * page's history, cut before this ordinal, then my own records". Ordinals are
 * global sequence numbers that continue across pages. A prompt edit
 * (`turn_trigger: "edit_user_message"`) starts a new page cut before the
 * edited turn; a fork (VS Code "fork from here", `thread/fork`) starts a new
 * THREAD whose first page is cut after the chosen turn, and also records
 * `forked_from_id`. Verified on 25 cuts: every one lands on a turn boundary.
 *
 * So the pages form an exact tree with no matching or inference: a page's
 * first turn hangs off the last turn of its base before the cut. This is
 * strictly more than `codex app-server` shows — `thread/turns/list` returns
 * only a thread's active path, hiding every prompt-edit branch — which is why
 * the tree is built from the files and the app-server is used only to fork.
 *
 * Two things vary independently and are read independently:
 *
 *  - VOCABULARY: `item_completed` items carrying turn ids, or the legacy
 *    `user_message` / `agent_message` events, which carry none — chosen per
 *    page by which of them carries its prose (`readsAsLegacy`);
 *  - HISTORY ENCODING: by reference (`history_base`), or a COPIED prefix
 *    (`forked_from_id` and no `history_base`). Codex 0.153–0.162 wrote forks
 *    of paginated threads both ways (7 copied-prefix forks on the target
 *    machine). A copy keeps the turn ids, so with the item vocabulary its
 *    prefix aligns on them exactly; legacy copies are stitched by content.
 *
 * Older pages are zstd-compressed; bases may live in `archived_sessions/`
 * (an archived thread can be the root of live forks). Guardian-review and
 * subagent threads are Codex's own plumbing and are hidden.
 */

// ------------------------------------------------------------------ records

interface RawRecord {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: {
    type?: string;
    // session_meta
    id?: string;
    cwd?: string;
    forked_from_id?: string;
    thread_source?: unknown;
    source?: unknown;
    cli_version?: string;
    originator?: string;
    history_mode?: string;
    history_base?: { thread_id?: string; end_ordinal_exclusive?: number };
    // event_msg / token_usage_record
    turn_id?: string;
    item?: CodexItem;
    message?: string;
    info?: { last_token_usage?: Record<string, number> };
    usage?: Record<string, number>;
    // turn_context
    model?: string;
    // response_item (legacy)
    name?: string;
    summary?: { type?: string; text?: string }[];
  };
}

interface CodexItem {
  type?: string;
  id?: string;
  content?: { type?: string; text?: string }[];
  phase?: string;
  summary_text?: string[];
  server?: string;
  tool?: string;
  kind?: string;
}

const KNOWN_RECORDS = new Set([
  "session_meta",
  "event_msg",
  "response_item",
  "token_usage_record",
  "turn_context",
  "world_state",
  "compacted",
]);
const KNOWN_EVENTS = new Set([
  "item_completed",
  "item_started",
  "task_started",
  "task_complete",
  "token_count",
  "thread_settings_applied",
  "turn_aborted",
  "context_compacted",
]);
const KNOWN_ITEMS = new Set([
  "UserMessage",
  "AgentMessage",
  "Reasoning",
  "CommandExecution",
  "FileChange",
  "McpToolCall",
  "WebSearch",
  "Extension",
  "ContextCompaction",
  "Plan",
  "ImageView",
  "HookPrompt",
]);

/** `zlib.zstdDecompressSync` is Node ≥ 22.15 / 23.8; feature-detected, never assumed. */
const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;

function readText(file: string): string | null {
  try {
    const buf = fs.readFileSync(file);
    if (!file.endsWith(".zst")) return buf.toString("utf8");
    if (!zstd) return null;
    return zstd(buf).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * VS Code wraps the prompt in its editor context:
 *   "# Context from my IDE setup:\n\n## Active file: …\n## Open tabs: …\n## My request:\n<prompt>"
 * (also "# Files mentioned by the user:"). Keep the prompt, drop the context.
 */
function cleanUserText(s: string): string {
  const t = s.trim();
  if (/^# (Context from my IDE setup|Files mentioned by the user):/.test(t)) {
    const m = /\n## My request(?: for Codex)?:\s*\n([\s\S]*)$/.exec(t);
    if (m) return m[1].trim();
  }
  return t.replace(CODEX_WRAP, "").trim();
}

/** Codex plumbing occasionally embedded in legacy user_message events. */
const CODEX_WRAP =
  /<(user_instructions|environment_context|permissions instructions|turn-aborted)>[\s\S]*?<\/\1>/g;

function toolName(it: CodexItem): string | null {
  switch (it.type) {
    case "CommandExecution":
      return "shell";
    case "FileChange":
      return "apply_patch";
    case "McpToolCall":
      return it.server && it.tool ? `${it.server}.${it.tool}` : "mcp";
    case "WebSearch":
      return "web_search";
    case "Extension":
      return it.kind ?? "extension";
    case "ImageView":
      return "view_image";
    case "Plan":
      return "update_plan";
    default:
      return null;
  }
}

/** Codex counts cached tokens inside input_tokens; Agentree stores the Anthropic split. */
function toUsage(u: Record<string, number>): UsageSnapshot {
  const cached = u.cached_input_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
    output_tokens: u.output_tokens ?? 0,
    cache_creation_input_tokens: u.cache_write_input_tokens ?? 0,
    cache_read_input_tokens: cached,
  };
}

const addUsage = (a: UsageSnapshot | undefined, b: UsageSnapshot): UsageSnapshot => ({
  input_tokens: (a?.input_tokens ?? 0) + b.input_tokens,
  output_tokens: (a?.output_tokens ?? 0) + b.output_tokens,
  cache_creation_input_tokens: (a?.cache_creation_input_tokens ?? 0) + b.cache_creation_input_tokens,
  cache_read_input_tokens: (a?.cache_read_input_tokens ?? 0) + b.cache_read_input_tokens,
});

// ------------------------------------------------------------------ pages

type Source = "user" | "hidden";

interface Turn {
  id: string;
  firstOrdinal: number;
  /** Own nodes, chained among themselves; nodes[0].parentId is set by the tree. */
  nodes: TurnNode[];
}

interface Page {
  pageId: string;
  threadId: string;
  file: string;
  archived: boolean;
  cwd: string;
  /** `forked_from_id`. With no `base`, the page holds a COPY of that thread's prefix. */
  forkedFrom: string | null;
  base: { pageId: string; end: number } | null;
  source: Source;
  version?: string;
  /** Legacy event vocabulary: no turn ids, so linear nodes stitched by content. */
  legacy: boolean;
  /** Turn-bearing records that yielded no turn — what a vocabulary change looks like. */
  unrecognized?: boolean;
  turns: Turn[];
  lastOrdinal: number;
  touchedAt: number;
  /**
   * Newest conversational record: an item starting or completing, of ANY
   * item type (a tool call too, so a long agent loop stays live). Not the
   * settings, usage, task and `response_item` records the extension writes
   * when it merely loads a thread — those made untouched threads look new.
   * 0 when the page has no item at all (a fork nobody has spoken in yet).
   */
  activeAt: number;
  /** When the page was written: its `session_meta` timestamp. */
  createdAt: number;
  firstUserText: string;
  unknownTypes: Record<string, number>;
}

const FILE_RE =
  /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?\.jsonl(?:\.zst)?$/;

function sourceOf(meta: NonNullable<RawRecord["payload"]>): Source {
  const ts = meta.thread_source;
  if (ts === "guardian_review" || ts === "subagent") return "hidden";
  if (typeof ts === "object" && ts !== null) return "hidden"; // {subagent: …}
  const src = meta.source;
  if (typeof src === "object" && src !== null && "subagent" in src) return "hidden";
  return "user";
}

function parsePage(file: string, archived: boolean): Page | null {
  const m = FILE_RE.exec(path.basename(file));
  if (!m) return null;
  const text = readText(file);
  if (text === null) return null;
  const lines = text.split("\n");
  let head: RawRecord;
  try {
    head = JSON.parse(lines[0]) as RawRecord;
  } catch {
    return null;
  }
  const meta = head.payload;
  if (head.type !== "session_meta" || !meta?.id) return null;

  const hb = meta.history_base;
  const page: Page = {
    pageId: m[2] ?? m[1],
    threadId: meta.id,
    file,
    archived,
    cwd: meta.cwd ?? "",
    forkedFrom: meta.forked_from_id ?? null,
    base:
      hb?.thread_id && typeof hb.end_ordinal_exclusive === "number"
        ? { pageId: hb.thread_id, end: hb.end_ordinal_exclusive }
        : null,
    source: sourceOf(meta),
    version: meta.cli_version,
    legacy: meta.history_mode !== "paginated",
    turns: [],
    lastOrdinal: 0,
    touchedAt: 0,
    activeAt: 0,
    createdAt: head.timestamp ? Date.parse(head.timestamp) || 0 : 0,
    firstUserText: "",
    unknownTypes: {},
  };

  const records: RawRecord[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      records.push(JSON.parse(lines[i]) as RawRecord);
    } catch {
      /* torn tail of a live session */
    }
  }
  if (page.legacy && readsAsLegacy(records)) {
    parseLegacy(page, records);
  } else {
    page.legacy = false;
    parsePaginated(page, records);
  }
  page.firstUserText = page.turns.flatMap((t) => t.nodes).find((n) => n.role === "user")?.text ?? "";
  return page;
}

/**
 * Which vocabulary a page that isn't `history_mode: "paginated"` speaks,
 * decided by its PROSE. Item records alone prove nothing: a VS Code
 * rollout of 0.164 (observed) is legacy prose plus one completed
 * `Extension` item. A page reads as items when items carry its prose — or
 * when it has items and no legacy prose at all, so an item vocabulary
 * nobody taught the parser still counts as a failure, not as empty. One
 * vocabulary per page: where item prose exists it wins (it carries turn
 * ids), and legacy prose events beside it are not read.
 */
function readsAsLegacy(records: RawRecord[]): boolean {
  let items = false;
  let legacyProse = false;
  for (const r of records) {
    if (r.type !== "event_msg") continue;
    const t = r.payload?.type;
    if (t === "item_completed") {
      const it = r.payload?.item?.type;
      if (it === "UserMessage" || it === "AgentMessage") return false;
      items = true;
    } else if (t === "user_message" || t === "agent_message") {
      legacyProse = true;
    }
  }
  return legacyProse || !items;
}

function parsePaginated(page: Page, records: RawRecord[]): void {
  const bump = (k: string) => (page.unknownTypes[k] = (page.unknownTypes[k] ?? 0) + 1);

  interface Builder {
    turn: Turn;
    cur: TurnNode | null;
    tools: string[];
    thinking: string[];
    lastAssistant: TurnNode | null;
    /** Usage reported before the turn's first prose; lands on its first reply. */
    usage?: UsageSnapshot;
    lastUsage?: UsageSnapshot;
    users: number;
  }
  const turns = new Map<string, Builder>();
  let model: string | undefined;
  let turnRecords = 0;

  const builder = (turnId: string, ordinal: number): Builder => {
    let b = turns.get(turnId);
    if (!b) {
      b = {
        turn: { id: turnId, firstOrdinal: ordinal, nodes: [] },
        cur: null,
        tools: [],
        thinking: [],
        lastAssistant: null,
        users: 0,
      };
      turns.set(turnId, b);
    }
    return b;
  };

  const push = (b: Builder, n: TurnNode) => {
    const prev = b.turn.nodes[b.turn.nodes.length - 1];
    n.parentId = prev ? prev.id : null;
    b.turn.nodes.push(n);
    b.cur = n;
  };

  for (const r of records) {
    const ts = r.timestamp ? Date.parse(r.timestamp) : 0;
    if (ts > page.touchedAt) page.touchedAt = ts;
    const ord = r.ordinal ?? 0;
    if (ord > page.lastOrdinal) page.lastOrdinal = ord;
    if (r.type && !KNOWN_RECORDS.has(r.type)) bump(r.type);
    const p = r.payload;
    if (!p) continue;

    if (r.type === "event_msg" && (p.type === "item_completed" || p.type === "item_started") && ts > page.activeAt) {
      page.activeAt = ts;
    }
    if (r.type === "turn_context" && p.model) model = p.model;
    // Each turn records where it ran; the last one is where the thread is.
    if (r.type === "turn_context" && p.cwd) page.cwd = p.cwd;
    if (r.type === "event_msg" && p.type && !KNOWN_EVENTS.has(p.type)) bump(`event_msg/${p.type}`);
    if (!p.turn_id) continue;
    turnRecords++;
    const b = builder(p.turn_id, ord);

    if (r.type === "token_usage_record" && p.usage) {
      // A response that produced only tools or reasoning reports usage before
      // any prose exists; hold it for the reply rather than drop it.
      const u = toUsage(p.usage);
      const target = b.lastAssistant;
      if (target) {
        target.usage = addUsage(target.usage, u);
        target.lastUsage = u;
      } else {
        b.usage = addUsage(b.usage, u);
        b.lastUsage = u;
      }
      continue;
    }
    if (r.type !== "event_msg" || p.type !== "item_completed" || !p.item) continue;

    const it = p.item;
    if (it.type && !KNOWN_ITEMS.has(it.type)) bump(`item/${it.type}`);
    const nodeId = `${b.turn.id}:${it.id ?? b.turn.nodes.length}`;
    const base = {
      lastRawId: b.turn.id,
      turnId: b.turn.id,
      // Turn and item ids are shared by every page and every copy holding
      // the turn, so the node id is already its semantic identity.
      stableIds: [nodeId],
      sourceSessionId: page.threadId,
      timestamp: ts,
    };

    if (it.type === "UserMessage") {
      const parts = it.content ?? [];
      let text = cleanUserText(parts.filter((c) => c.type === "text").map((c) => c.text ?? "").join(""));
      const media = parts.filter((c) => c.type !== "text").length;
      if (!text && media) text = media > 1 ? `[${media} attachments]` : "[image]";
      if (!text) continue;
      push(b, {
        ...base,
        id: nodeId,
        parentId: null,
        role: "user",
        text,
        // A second prompt inside one turn was typed while Codex was working
        // ("steering"); it rides the same turn, so it can't anchor a fork alone.
        midTurn: b.users++ > 0 || undefined,
      });
    } else if (it.type === "AgentMessage") {
      const text = (it.content ?? []).map((c) => c.text ?? "").join("").trim();
      if (!text) continue;
      if (b.cur?.role === "assistant") {
        // Commentary and final answer of one reply are one node, like Claude's
        // agent-loop merge, ending with its last message.
        b.cur.text += `\n\n${text}`;
        if (ts > b.cur.timestamp) b.cur.endedAt = ts;
      } else {
        push(b, { ...base, id: nodeId, parentId: null, role: "assistant", text, model });
      }
      const n = b.cur!;
      if (b.usage) {
        n.usage = addUsage(n.usage, b.usage);
        n.lastUsage ??= b.lastUsage;
        b.usage = b.lastUsage = undefined;
      }
      if (b.tools.length) n.toolUses = [...(n.toolUses ?? []), ...b.tools];
      if (b.thinking.length) n.thinking = [n.thinking, ...b.thinking].filter(Boolean).join("\n\n");
      b.tools = [];
      b.thinking = [];
      b.lastAssistant = n;
    } else if (it.type === "Reasoning") {
      const t = (it.summary_text ?? []).filter(Boolean).join("\n\n");
      if (t) b.thinking.push(t);
    } else {
      const name = toolName(it);
      if (name) b.tools.push(name);
    }
  }

  // Tools after a turn's last prose still belong to that reply.
  for (const b of turns.values()) {
    if (b.lastAssistant && b.tools.length) {
      b.lastAssistant.toolUses = [...(b.lastAssistant.toolUses ?? []), ...b.tools];
    }
  }
  page.turns = [...turns.values()]
    .map((b) => b.turn)
    .filter((t) => t.nodes.length > 0)
    .sort((a, c) => a.firstOrdinal - c.firstOrdinal);
  // A page can legitimately say nothing (just created), but not while holding
  // records of turns that all came out empty.
  page.unrecognized = turnRecords > 0 && page.turns.length === 0 && !records.some(
    (r) => r.type === "event_msg" && r.payload?.type === "turn_aborted",
  );
}

/** The pre-paginated format: one linear stream of event_msg prose. */
function parseLegacy(page: Page, records: RawRecord[]): void {
  const sid = page.threadId;
  const nodes: TurnNode[] = [];
  let pendingTools: string[] = [];
  let pendingThinking = "";

  const push = (role: TurnNode["role"], text: string, ts: number) => {
    const n = nodes.length;
    nodes.push({
      id: `${sid}#${n}`,
      parentId: n > 0 ? `${sid}#${n - 1}` : null,
      role,
      text,
      timestamp: ts,
      sourceSessionId: sid,
      thinking: role === "assistant" && pendingThinking ? pendingThinking : undefined,
      toolUses: role === "assistant" && pendingTools.length ? pendingTools : undefined,
    });
    if (role === "assistant") {
      pendingTools = [];
      pendingThinking = "";
    }
  };

  for (const rec of records) {
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (ts > page.touchedAt) page.touchedAt = ts;
    const p = rec.payload;
    if (!p) continue;
    // The legacy vocabulary's conversation: prose events and tool calls.
    if (
      ts > page.activeAt &&
      ((rec.type === "event_msg" && (p.type === "user_message" || p.type === "agent_message")) ||
        (rec.type === "response_item" && (p.type === "function_call" || p.type === "custom_tool_call")))
    ) {
      page.activeAt = ts;
    }
    if (rec.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") {
        const text = cleanUserText(p.message);
        if (text) push("user", text, ts);
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        if (p.message.trim()) push("assistant", p.message.trim(), ts);
      } else if (p.type === "token_count") {
        const u = p.info?.last_token_usage;
        const last = nodes[nodes.length - 1];
        if (u && last && last.role === "assistant") last.usage = last.lastUsage = toUsage(u);
      }
    } else if (rec.type === "response_item") {
      if ((p.type === "function_call" || p.type === "custom_tool_call") && p.name) {
        pendingTools.push(p.name);
      } else if (p.type === "reasoning" && Array.isArray(p.summary)) {
        const t = p.summary.map((s) => s.text ?? "").filter(Boolean).join("\n\n");
        if (t) pendingThinking += (pendingThinking ? "\n\n" : "") + t;
      }
    }
  }
  // Legacy rollouts can't be forked at a turn through the API (no turn ids),
  // so the whole stream is one pseudo-turn.
  // Its node ids are per-file, so identity comes from the text chain, the
  // same in a verbatim copy.
  for (const n of nodes) n.turnId = `${sid}#legacy`;
  assignStableIds(nodes, (n) => ({ key: textKey(n), strong: false, earlier: [foldedTextKey(n)] }));
  page.turns = nodes.length ? [{ id: `${sid}#legacy`, firstOrdinal: 0, nodes }] : [];
}

// ------------------------------------------------------------------ scan

/** Full-parse cache by file identity. Pages are small; the tree needs all of them. */
const pages = new Map<string, { mtimeMs: number; size: number; page: Page | null }>();

interface Scan {
  pages: Page[];
  byPage: Map<string, Page>;
  health: HealthScan;
}

function scanPages(): Scan {
  const health = new HealthScan("codex", codexSessions());
  if (!zstd) health.error("This Node runtime has no zstd support; compressed .jsonl.zst rollouts can't be read.");
  const out: Page[] = [];
  const seen = new Set<string>();

  const visit = (file: string, archived: boolean) => {
    seen.add(file);
    health.file();
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return;
    }
    const hit = pages.get(file);
    const page =
      hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit.page : parsePage(file, archived);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      pages.set(file, { mtimeMs: st.mtimeMs, size: st.size, page });
    }
    if (!page) {
      // Unreadable, not a rollout name, or no session_meta head.
      health.failed();
      return;
    }
    health.version(page.version ? `codex-cli ${minorVersion(page.version)}` : undefined);
    if (page.source === "hidden") {
      health.skipped();
      return;
    }
    health.unknown(page.unknownTypes);
    // An unrecognised page still links the pages continuing it, so it stays
    // in the graph; it just counts as a failure, not as a session.
    if (page.unrecognized) health.failed();
    else health.parsed();
    out.push(page);
  };

  const walk = (dir: string, depth: number, archived: boolean) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1, archived);
      } else if (/\.jsonl(\.zst)?$/.test(e.name)) {
        visit(p, archived);
      }
    }
  };
  walk(codexSessions(), 0, false);
  walk(codexArchived(), 0, true);
  for (const key of pages.keys()) if (!seen.has(key)) pages.delete(key);

  const byPage = new Map(out.map((p) => [p.pageId, p]));
  for (const p of out) {
    if (p.base && !byPage.has(p.base.pageId)) {
      health.warn("Some rollout pages continue a page that is no longer on disk; they are drawn as separate roots.");
    }
  }
  return { pages: out, byPage, health };
}

/** `session_index.jsonl`: `{id, thread_name}` lines, last one per id wins. */
let indexCache: { stamp: string; names: Map<string, string> } | null = null;
/**
 * Identity of the index — part of every family-meta cache key, since a rename
 * lives there. Its path is part of it: a moved CODEX_HOME must not reuse the
 * old home's names.
 */
function indexStamp(): string {
  try {
    const st = fs.statSync(codexIndex());
    return `${codexIndex()}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}
function threadNames(): Map<string, string> {
  const file = codexIndex();
  const stamp = indexStamp();
  if (stamp === "none") return new Map();
  if (indexCache && indexCache.stamp === stamp) return indexCache.names;
  const names = new Map<string, string>();
  for (const line of (readText(file) ?? "").split("\n")) {
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string };
      if (o.id && o.thread_name) names.set(o.id, o.thread_name);
    } catch {
      /* skip */
    }
  }
  indexCache = { stamp, names };
  return names;
}

// ------------------------------------------------------------------ families

interface Family {
  rootThread: string;
  pages: Page[];
}

/** Connected components over page bases, thread membership and fork lineage. */
function families(scan: Scan): Family[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const threadKey = (t: string) => `t:${t}`;
  for (const p of scan.pages) {
    union(p.pageId, threadKey(p.threadId));
    if (p.base && scan.byPage.has(p.base.pageId)) union(p.pageId, p.base.pageId);
    // Explicit lineage, whatever the vocabulary or history encoding.
    if (p.forkedFrom) union(threadKey(p.threadId), threadKey(p.forkedFrom));
  }
  const groups = new Map<string, Page[]>();
  for (const p of scan.pages) {
    const r = find(p.pageId);
    const g = groups.get(r);
    if (g) g.push(p);
    else groups.set(r, [p]);
  }
  return [...groups.values()].map((ps) => {
    // The root page: no base on disk, not a copy of a thread in the family,
    // earliest first.
    const roots = ps
      .filter((p) => !p.base || !scan.byPage.has(p.base.pageId))
      .filter((p) => !p.forkedFrom || !ps.some((q) => q.threadId === p.forkedFrom));
    const root = (roots.length ? roots : ps).sort((a, b) => a.pageId.localeCompare(b.pageId))[0];
    return { rootThread: root.threadId, pages: ps };
  });
}

/**
 * The last own turn of `page` before ordinal `cut`, else recurse into its
 * base. Returns the tree node a page continuing at `cut` hangs off.
 */
function tailBefore(scan: Scan, page: Page, cut: number, seen = new Set<string>()): TurnNode | null {
  if (seen.has(page.pageId)) return null;
  seen.add(page.pageId);
  for (let i = page.turns.length - 1; i >= 0; i--) {
    const t = page.turns[i];
    if (t.firstOrdinal < cut) return t.nodes[t.nodes.length - 1];
  }
  if (!page.base) return null;
  const base = scan.byPage.get(page.base.pageId);
  return base ? tailBefore(scan, base, Math.min(cut, page.base.end), seen) : null;
}

/** Pages grouped by thread, oldest page first — the last one is the thread's current head. */
function threadsOf(fam: Family): Map<string, Page[]> {
  const t = new Map<string, Page[]>();
  for (const p of fam.pages) {
    const arr = t.get(p.threadId);
    if (arr) arr.push(p);
    else t.set(p.threadId, [p]);
  }
  // Page ids are UUIDv7 — lexical order is creation order.
  for (const arr of t.values()) arr.sort((a, b) => a.pageId.localeCompare(b.pageId));
  return t;
}

/**
 * The turn ids on a thread's CURRENT history: from its newest page down its
 * bases — into other threads too, since a fork's history continues into its
 * parent's pages — narrowing the cut at each step. A page a later prompt edit
 * cut short is still a base, but its turns past the cut are no longer held.
 * "Newest page = current head" agreed with app-server's active turns on all
 * ten multi-page threads of the target machine.
 */
function currentHistory(scan: Scan, head: Page): Set<string> {
  const held = new Set<string>();
  let cut = Infinity;
  const seen = new Set<string>();
  for (let p: Page | undefined = head; p && !seen.has(p.pageId); ) {
    seen.add(p.pageId);
    for (const t of p.turns) if (t.firstOrdinal < cut) held.add(t.id);
    if (!p.base) break;
    cut = Math.min(cut, p.base.end);
    p = scan.byPage.get(p.base.pageId);
  }
  return held;
}

/** Why a Codex node can't anchor a fork. */
const BLOCK = {
  legacy: "This rollout predates Codex's paginated format; its turns have no ids to fork at.",
  partial:
    "Codex forks whole turns, and this turn continues below this message. Fork at the turn's last reply to keep all of it, or at the previous turn's reply to leave it out.",
  abandoned:
    "A prompt edit replaced this turn, and Codex can only fork history a thread still holds. Fork at the last turn before the edit and resend the prompt from there.",
};

interface Tree {
  nodes: TurnNode[];
  /** turn id → the thread a `thread/fork` through that turn goes to. */
  forkVia: Map<string, string>;
  /** thread id → the turn ids on its current history. */
  held: Map<string, Set<string>>;
}

/**
 * Build the family tree: page-graph links for referenced history, turn-id
 * alignment for copied prefixes, content stitching for the legacy vocabulary.
 * Also decides, per node, whether Codex can fork there.
 */
function buildTree(scan: Scan, fam: Family): Tree {
  const out: TurnNode[] = [];
  const legacy: FamilyMember[] = [];
  /** Turns already placed, with the page that placed them. A copied prefix
   * repeats its source's turn ids; they are drawn once, where first placed. */
  const placed = new Map<string, { turn: Turn; page: Page }>();

  // Base pages before the pages continuing them, and a thread before the
  // threads that copied it: page ids are UUIDv7, so this is creation order.
  for (const page of [...fam.pages].sort((a, b) => a.pageId.localeCompare(b.pageId))) {
    if (page.legacy) {
      legacy.push({
        sessionId: page.threadId,
        parentSessionId: page.forkedFrom,
        nodes: page.turns.flatMap((t) => t.nodes),
      });
      continue;
    }
    const base = page.base ? scan.byPage.get(page.base.pageId) : undefined;
    let prev: TurnNode | null = base && page.base ? tailBefore(scan, base, page.base.end) : null;
    // A branch, not a mere continuation: a fork into another thread, or a cut
    // that drops some of the base page's own records (a prompt edit).
    const branches =
      !!base && !!page.base && (base.threadId !== page.threadId || page.base.end <= base.lastOrdinal);
    let afterCopy = false;
    page.turns.forEach((t, i) => {
      const dup = placed.get(t.id);
      if (dup) {
        prev = dup.turn.nodes[dup.turn.nodes.length - 1];
        afterCopy = true;
        return;
      }
      placed.set(t.id, { turn: t, page });
      // Where a branch begins, and how it was made: the first turn of a page
      // that cuts into its base is a fork if the page is another thread's,
      // else a prompt edit of this one; the first own turn after a prefix
      // copied from ANOTHER thread is a fork too.
      const kind: TurnNode["branchKind"] =
        prev === null
          ? undefined
          : i === 0 && branches
            ? base!.threadId !== page.threadId ? "fork" : "edit"
            : afterCopy && prev.sourceSessionId !== page.threadId
              ? "fork"
              : undefined;
      afterCopy = false;
      t.nodes.forEach((n, j) => {
        out.push({
          ...n,
          parentId: j === 0 ? prev?.id ?? null : n.parentId,
          branchKind: j === 0 ? kind : undefined,
          forkBlocked: j < t.nodes.length - 1 ? BLOCK.partial : undefined,
        });
      });
      prev = t.nodes[t.nodes.length - 1];
    });
  }

  // Forks go through a thread whose current history still holds the turn:
  // the one that placed it if it does, else any other (a fork of it, say —
  // verified: thread/fork on a fork thread accepts a turn it only inherits
  // through history_base, codex-cli 0.164). A turn no thread holds was cut
  // away by a prompt edit, and app-server refuses to fork stale pages.
  const holders = [...threadsOf(fam).entries()].map(([id, ps]) => ({
    id,
    held: currentHistory(scan, ps[ps.length - 1]),
  }));
  const forkVia = new Map<string, string>();
  for (const [turnId, { page }] of placed) {
    const own = holders.find((h) => h.id === page.threadId && h.held.has(turnId));
    const via = own ?? holders.find((h) => h.held.has(turnId));
    if (via) forkVia.set(turnId, via.id);
  }
  for (const n of out) {
    if (!n.forkBlocked && n.lastRawId && !forkVia.has(n.lastRawId)) n.forkBlocked = BLOCK.abandoned;
  }

  if (legacy.length) {
    for (const n of stitchFamily(legacy)) out.push({ ...n, forkBlocked: BLOCK.legacy });
  }
  return { nodes: mergeSameRoleRuns(out), forkVia, held: new Map(holders.map((h) => [h.id, h.held])) };
}

const resumeCmd = (id: string, cwd: string) => resumeCommandFor("codex", id, cwd);

function describe(fam: Family, nodes: TurnNode[] | null): { meta: SessionMeta; members: MemberInfo[] } {
  const names = threadNames();
  const threads = threadsOf(fam);
  const members: MemberInfo[] = [...threads.entries()].map(([id, ps]) => ({
    id,
    title: (names.get(id) ?? ps.find((p) => p.firstUserText)?.firstUserText ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90) || "Untitled",
    parentId: ps.find((p) => p.forkedFrom)?.forkedFrom ?? null,
    // Codex records every fork's source itself.
    parentEvidence: ps.some((p) => p.forkedFrom) ? "explicit" : undefined,
    // The newest page is where the thread continues (pages are oldest first).
    cwd: ps[ps.length - 1].cwd,
    resumeCommand: resumeCmd(id, ps[ps.length - 1].cwd),
    // A thread with no item of its own (a fork nobody has spoken in) dates
    // from its creation, never from the records a reload appends.
    activeAt: Math.max(...ps.map((p) => p.activeAt)) || Math.min(...ps.map((p) => p.createdAt || p.touchedAt)),
    touchedAt: Math.max(...ps.map((p) => p.touchedAt)),
    archived: ps.every((p) => p.archived) || undefined,
  }));
  members.sort((a, b) => (a.id === fam.rootThread ? -1 : b.id === fam.rootThread ? 1 : a.id.localeCompare(b.id)));
  const root = members[0];
  const all = nodes ?? [];
  return {
    meta: {
      id: fam.rootThread,
      provider: "codex",
      cwd: root.cwd,
      project: root.cwd ? root.cwd.split(/[\\/]/).filter(Boolean).pop() ?? "codex" : "codex",
      title: root.title,
      // The family's last conversation: items only. A quiet fork's creation
      // is not a conversation — and its reloads must not float the family up.
      activeAt: Math.max(...fam.pages.map((p) => p.activeAt)) || Math.max(...members.map((m) => m.activeAt)),
      touchedAt: Math.max(...members.map((m) => m.touchedAt)),
      nodeCount: all.length,
      branchPoints: countBranchPoints(childIndex(all)),
      resumeCommand: root.resumeCommand,
      members: members.length,
      forks: forkSummaries(members, fam.rootThread),
      entrypoint: "codex",
      archived: members.every((m) => m.archived) || undefined,
    },
    members,
  };
}

// ------------------------------------------------------------------ API

let lastHealth: ProviderHealth | null = null;
export const codexHealth = (): ProviderHealth =>
  lastHealth ?? new HealthScan("codex", codexSessions()).done();

/**
 * Family-meta cache: one entry per family, keyed by its pages' file
 * identities AND the thread-name index's — a rename touches only the index.
 */
const metas = new Map<string, SessionMeta>();

export function listCodexSessions(): SessionMeta[] {
  const showArchived = readSettings().showArchivedCodex;
  const scan = scanPages();
  const out: SessionMeta[] = [];
  const live = new Set<string>();
  const index = indexStamp();
  for (const fam of families(scan)) {
    // Only conversations the user can still see: an all-archived family stays
    // reachable as the base of live forks, but gets no entry of its own —
    // unless the settings ask for archived conversations too.
    if (fam.pages.every((p) => p.archived) && !showArchived) continue;
    if (!fam.pages.some((p) => p.turns.length)) continue;
    const sig =
      fam.pages
        .map((p) => {
          const c = pages.get(p.file);
          return `${p.file}:${c?.mtimeMs}:${c?.size}`;
        })
        .sort()
        .join("|") + `|index:${index}`;
    live.add(sig);
    let meta = metas.get(sig);
    if (!meta) {
      meta = describe(fam, buildTree(scan, fam).nodes).meta;
      metas.set(sig, meta);
    }
    out.push(meta);
  }
  for (const k of metas.keys()) if (!live.has(k)) metas.delete(k);
  scan.health.listed(out.length);
  lastHealth = scan.health.done();
  return out;
}

function familyOf(scan: Scan, threadId: string): Family | undefined {
  return families(scan).find((f) => f.pages.some((p) => p.threadId === threadId));
}

export function locateCodex(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  for (const { page } of pages.values()) if (page?.threadId === sessionId) return page.file;
  // Cold cache (first call before any listing): scan once.
  return scanPages().pages.find((p) => p.threadId === sessionId)?.file ?? null;
}

export function loadCodexSession(sessionId: SessionId): SessionDetail | null {
  const scan = scanPages();
  const fam = familyOf(scan, sessionId);
  if (!fam) return null;
  const { nodes, held } = buildTree(scan, fam);
  const { meta, members } = describe(fam, nodes);
  applyAnnotations(nodes, members.map((m) => m.id));
  // A thread holds what its current history holds — its own turns and the
  // ones it continues by reference (a fork copies nothing). Legacy rollouts
  // have no turn ids; their copies are stitched, so occurrences say it.
  const threads = [...held];
  for (const n of nodes) {
    n.heldBy = n.turnId?.endsWith("#legacy")
      ? copyHolders(n)
      : threads.filter(([, turns]) => !!n.turnId && turns.has(n.turnId)).map(([id]) => id);
  }
  assignTips(nodes, members);
  return { meta, nodes, members };
}

// ------------------------------------------------------------------ fork

/**
 * Fork a Codex thread through a chosen turn (inclusive), via the app-server's
 * `thread/fork` — the same call the Codex VS Code extension makes, so the new
 * thread is a first-class Codex thread with real lineage (`forked_from_id`,
 * `history_base`). Agentree writes nothing itself.
 *
 * Which nodes can be forked, and through which thread, was decided when the
 * tree was built (`forkBlocked`, `forkVia`): Codex cuts only at whole turns,
 * and only in history some thread still holds.
 */
export async function forkCodexAt(familyId: SessionId, point: ForkPoint): Promise<ForkResult> {
  const scan = scanPages();
  const fam = familyOf(scan, familyId);
  const tree = fam ? buildTree(scan, fam) : undefined;
  const node = tree && resolveForkPoint(tree.nodes, point);
  if (!fam || !tree || !node) return { ok: false, error: FORK_POINT_GONE };
  if (node.forkBlocked) return { ok: false, error: node.forkBlocked };
  const turnId = node.lastRawId!;
  const via = tree.forkVia.get(turnId);
  if (!via) return { ok: false, error: BLOCK.abandoned };

  const res = await forkThread({ threadId: via, lastTurnId: turnId });
  if (!res.ok) return res;
  const cwd = res.cwd || fam.pages.find((p) => p.threadId === via)?.cwd || "";
  return {
    ok: true,
    id: res.threadId,
    cwd,
    command: resumeCmd(res.threadId, cwd),
    open: { provider: "codex", sessionId: res.threadId, cwd },
    note:
      via !== node.sourceSessionId
        ? "This turn's own thread was edited past it, so the fork was taken through a fork of that thread that still holds it."
        : undefined,
  };
}
