import fs from "node:fs";
import path from "node:path";
import { assignTips, childIndex, copyHolders, countBranchPoints, cwdKey, endOf, forkSummaries } from "../shared/render.ts";
import type {
  MemberInfo,
  NodeId,
  ProviderHealth,
  SessionDetail,
  SessionId,
  SessionMeta,
  TurnNode,
} from "../shared/types.ts";
import { HealthScan, minorVersion } from "./health.ts";
import { readLineage } from "./lineage.ts";
import { applyAnnotations } from "./meta.ts";
import { claudeProjects } from "./paths.ts";
import { resumeCommandFor } from "./launch.ts";
import { assignStableIds, digest, foldedDigest } from "./identity.ts";
import { overlap, stitchFamily, type FamilyMember } from "./providers/stitch.ts";

function decodeProjectName(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

/** Last path segment of a POSIX or Windows path. */
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

// ------------------------------------------------------------------ parsing

export interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  /**
   * A `/compact` writes a `system/compact_boundary` record with
   * `parentUuid: null` and the pre-compaction tip here — following it keeps a
   * compacted session one connected tree instead of a forest.
   */
  logicalParentUuid?: string | null;
  /** `system` records only, e.g. "compact_boundary". */
  subtype?: string;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  sessionId?: string;
  /** CLI version that wrote the record. */
  version?: string;
  /** "claude-vscode" | "cli" | … — which front end drove the session. */
  entrypoint?: string;
  /** Shared by the prompt record and every tool_result of that prompt. */
  promptId?: string;
  /**
   * Written by forks made through the Agent SDK's `forkSession` and by
   * Agentree's own fork: the parent session and the message forked after.
   */
  forkedFrom?: { sessionId?: string; messageUuid?: string };
  /** `queue-operation` only: enqueue | dequeue | remove. */
  operation?: string;
  /** `queue-operation` only: the text the user typed. */
  content?: unknown;
  /** `custom-title` only: the name set with `/rename` (or "<title> (fork)"). */
  customTitle?: string;
  /** `ai-title` only: the CLI's own generated title. */
  aiTitle?: string;
  /**
   * `attachment` records. `type: "queued_command"` ones are the harness's OWN
   * splice of a delivered mid-turn message into the lineage — real uuid, real
   * position — and are preferred over reconstructing from queue-operations.
   */
  attachment?: {
    type?: string;
    prompt?: string;
    /** "prompt" for the user's own /btw messages, "task-notification" for plumbing. */
    commandMode?: string;
    origin?: { kind?: string } | null;
  };
  /** Agentree-internal marker set when projecting a queued_command attachment. */
  agentreeMidTurn?: boolean;
  message?: {
    /** API message id. Shared by every record belonging to one assistant turn. */
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: Record<string, number>;
  };
}

/**
 * Record types this parser has met and knows to be either a turn or
 * bookkeeping it can ignore. Anything else is counted in the health row — not
 * an error (the lineage pass tolerates any type), but the first sign of a
 * format change.
 */
const KNOWN_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "summary",
  "progress",
  "queue-operation",
  "custom-title",
  "ai-title",
  "agent-name",
  "tag",
  "last-prompt",
  "mode",
  "permission-mode",
  "file-history-snapshot",
  "file-history-delta",
  // Request-capture bookkeeping. `api-request-blob` carries `message` content
  // blocks but is NOT a turn — only user/assistant records ever become nodes.
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "bridge-session",
  "atis-latch",
  "cost-state",
  "pr-link",
  "frame-link",
  "artifact-autoreact-ledger",
  "artifact-comment-monitor",
]);

// Claude Code plumbing that leaks into `user` records as literal markup.
const ESC = String.fromCharCode(27);
/** CSI sequences — `\e[1m` and friends — from command output captured verbatim. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/**
 * Boilerplate addressed to the model, never written or read by the user. The
 * `ide_*` blocks are the VS Code extension's context injection ("The user
 * opened the file … in the IDE"); left in, they became most sessions' titles.
 */
const DROP_TAGS =
  "local-command-caveat|system-reminder|ide_opened_file|ide_selection|ide_diagnostics";
const DROP_BLOCKS = new RegExp(`<(${DROP_TAGS})>[\\s\\S]*?<\\/\\1>`, "g");
/**
 * A reminder can OPEN in one record and CLOSE in the next; when adjacent
 * records merge, the rejoined pair is caught by DROP_BLOCKS — but at a branch
 * point the merge doesn't happen and each half survives alone. After the
 * paired pass, an unpaired opener runs to end-of-record and an unpaired closer
 * back to its start, so drop those spans. The backtick guard spares prose
 * discussing the tag (`` `<system-reminder>` ``), which this repo's own
 * sessions are full of.
 */
const DROP_OPEN_TAIL = new RegExp("(?<!`)<(?:" + DROP_TAGS + ")>[\\s\\S]*$");
const DROP_CLOSE_HEAD = new RegExp("^[\\s\\S]*?<\\/(?:" + DROP_TAGS + ")>(?!`)");
const WRAPPERS = [
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "user-prompt-submit-hook",
  // `!`-prefixed bash mode in the CLI
  "bash-input",
  "bash-stdout",
  "bash-stderr",
].join("|");

/**
 * A background-task notification is a bundle of sub-tags (`task-id`,
 * `tool-use-id`, `output-file`, `status`, `summary`) that would render as raw
 * markup if merely unwrapped. Only `summary` is prose; the rest is plumbing —
 * so the whole block is rebuilt as its summary line. Handled before the
 * generic unwrap so the sub-tags never reach it (they're generic names like
 * `<status>` that must NOT be stripped when they appear in real content).
 */
const TASK_NOTIF = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/**
 * The same bundle WITHOUT its wrapper: queued mid-turn messages surface task
 * notifications inline, so `<task-id>…` runs appear bare inside user records.
 * `<task-id>` is distinctive enough to anchor on; the generic-named sub-tags
 * are only consumed as part of a run that starts with it.
 */
const BARE_NOTIF =
  /<task-id>[\s\S]*?<\/task-id>(?:\s*<(tool-use-id|output-file|status|summary)>[\s\S]*?<\/\1>)*/g;
/**
 * Boilerplate paragraph the harness prints above task notifications
 * ("[SYSTEM NOTIFICATION - NOT USER INPUT] …"). Addressed to the model, never
 * typed by the user; matched as one contiguous paragraph.
 */
const SYSTEM_NOTIF = /\[SYSTEM NOTIFICATION - NOT USER INPUT\][^\n]*(?:\n(?!\s*\n)[^\n]*)*/g;

function rebuildTaskNotification(inner: string): string {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(inner);
  if (summary) return summary[1].trim();
  // No summary tag — drop the known plumbing sub-tags, keep whatever remains.
  const rest = inner
    .replace(/<(task-id|tool-use-id|output-file|status)>[\s\S]*?<\/\1>/g, "")
    .trim();
  return rest || "[background task update]";
}
/** Real content in a wrapper: keep the inner text (trimmed), lose the tag. */
const UNWRAP_BLOCKS = new RegExp(`<(${WRAPPERS})>([\\s\\S]*?)<\\/\\1>`, "g");
/** A wrapper whose partner tag lives in another record. */
const UNWRAP_STRAY = new RegExp(`</?(?:${WRAPPERS})>`, "g");

/**
 * Strip Claude Code plumbing that leaks into records as literal markup.
 *
 * Deliberately a SHORT allow-list of known wrapper tags, not "remove anything
 * angle-bracketed": conversations are full of real `<doc>`, `<name>`, `<email>`
 * markup inside code samples and quoted XML, and eating those would corrupt the
 * content it's meant to clean.
 */
export function cleanText(s: string): { text: string; synthetic: boolean } {
  let out = s
    .replace(ANSI, "")
    .replace(DROP_BLOCKS, "")
    .replace(DROP_OPEN_TAIL, "")
    .replace(DROP_CLOSE_HEAD, "")
    .replace(SYSTEM_NOTIF, "")
    .replace(TASK_NOTIF, (_m, inner: string) => rebuildTaskNotification(inner))
    .replace(BARE_NOTIF, (m) => rebuildTaskNotification(m));
  let synthetic = false;

  // A slash-command record is nothing but wrapper blocks, pretty-printed with
  // indentation. Unwrapping in place leaves that indentation stranded
  // ("/model\n            model"), so rebuild the record from the trimmed
  // inners instead. Only when the record is *entirely* wrappers — prose and
  // code must keep their whitespace.
  const inners = [...out.matchAll(UNWRAP_BLOCKS)].map((m) => m[2].trim());
  if (inners.length > 0 && out.replace(UNWRAP_BLOCKS, "").trim() === "") {
    out = inners.filter(Boolean).join("\n");
    // Nothing here but harness wrappers — real content never reaches this branch.
    synthetic = true;
  } else {
    out = out.replace(UNWRAP_BLOCKS, (_m, _tag, inner: string) => inner.trim());
  }

  const text = out
    .replace(UNWRAP_STRAY, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, synthetic };
}

function textOf(content: unknown): {
  text: string;
  thinking: string;
  tools: string[];
  synthetic: boolean;
} {
  if (typeof content === "string") {
    const c = cleanText(content);
    return { text: c.text, thinking: "", tools: [], synthetic: c.synthetic };
  }
  if (!Array.isArray(content)) return { text: "", thinking: "", tools: [], synthetic: false };

  let text = "";
  let thinking = "";
  let media = 0;
  const tools: string[] = [];
  for (const raw of content) {
    const b = raw as { type?: string; text?: string; thinking?: string; name?: string };
    switch (b.type) {
      case "text":
        text += b.text ?? "";
        break;
      case "thinking":
        thinking += b.thinking ?? "";
        break;
      case "tool_use":
        if (b.name) tools.push(b.name);
        break;
      case "image":
      case "document":
        media++;
        break;
      // tool_result blocks are the harness echoing output back; they'd swamp
      // the transcript view, so they're summarised by the tool_use name only.
      default:
        break;
    }
  }
  const cleaned = cleanText(text);
  text = cleaned.text;
  // An uncaptioned screenshot has no text but is a real turn, so label it
  // rather than letting the has-text filter drop it.
  if (!text && media > 0) text = media > 1 ? `[${media} attachments]` : "[image]";
  return { text, thinking: thinking.trim(), tools, synthetic: cleaned.synthetic };
}

/**
 * Fold a linear run of consecutive SAME-ROLE turns into one node.
 *
 * Assistant runs: once tool-result records are gone an agent loop is just
 * assistant → assistant → assistant. Each step is its own API message, but to a
 * reader it is one reply to one prompt.
 *
 * User runs: a slash command arrives as several records (the command name, its
 * stdout, hook output) before the next assistant turn.
 *
 * Either way the result is the alternating user↔assistant tree you want to look
 * at. Only merges where the parent has EXACTLY one child, so branch points are
 * never collapsed — a branch below the run simply re-parents onto the head. Nor
 * does a run cross from one session into another: a fork's first turn must
 * stay its own node, or the fork point (and its resume target) disappears.
 *
 * Nor across a session's END: a run only continues into a part held by
 * exactly the sessions that held the part before it (`copyHolders`). A quiet
 * fork copied through one reply but not the parent's next one; folding the
 * two would draw that fork's endpoint with text it never had, and make its
 * copy of the first reply look like a copy of both. So whoever holds a copy
 * of any part of a merged node holds all of it.
 */
export function mergeSameRoleRuns(nodes: TurnNode[]): TurnNode[] {
  const kids = new Map<string, TurnNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? "\0root";
    const arr = kids.get(key);
    if (arr) arr.push(n);
    else kids.set(key, [n]);
  }

  const absorbed = new Set<NodeId>();
  const remap = new Map<NodeId, NodeId>(); // absorbed id -> surviving head id
  const out: TurnNode[] = [];

  for (const head of nodes) {
    if (absorbed.has(head.id)) continue;

    const parts: TurnNode[] = [head];
    let cur = head;
    for (;;) {
      const cs = kids.get(cur.id) ?? [];
      if (cs.length !== 1 || cs[0].role !== head.role) break;
      if (cs[0].branchKind || cs[0].sourceSessionId !== head.sourceSessionId) break;
      // Nor across the harness's own turns (Codex): a fork cuts only between
      // them, so a node spanning two could never be forked after all it shows.
      if (cs[0].turnId !== head.turnId) break;
      if (!sameHolders(cur, cs[0])) break;
      cur = cs[0];
      parts.push(cur);
      absorbed.add(cur.id);
      remap.set(cur.id, head.id);
    }

    if (parts.length === 1) {
      out.push(head);
      continue;
    }

    const last = parts[parts.length - 1];
    // The run starts when its head did and ends with its latest part: which
    // branch was active last is read from the end (`endOf`).
    const endedAt = Math.max(...parts.map(endOf));
    out.push({
      ...head,
      endedAt: endedAt > head.timestamp ? endedAt : undefined,
      // Re-clean the joined text: a wrapper block can open in one record and
      // close in the next, which per-record cleaning cannot match.
      text: cleanText(parts.map((p) => p.text).join("\n\n")).text,
      thinking: parts.map((p) => p.thinking ?? "").filter(Boolean).join("\n\n") || undefined,
      toolUses: parts.flatMap((p) => p.toolUses ?? []),
      // Unlike the per-block merge — where every record repeats one message's
      // usage and summing would multiply it — each part here is a DISTINCT API
      // call, so summing is the real cost of the merged turn.
      usage: parts.reduce(
        (acc, p) => ({
          input_tokens: acc.input_tokens + (p.usage?.input_tokens ?? 0),
          output_tokens: acc.output_tokens + (p.usage?.output_tokens ?? 0),
          cache_creation_input_tokens:
            acc.cache_creation_input_tokens + (p.usage?.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens:
            acc.cache_read_input_tokens + (p.usage?.cache_read_input_tokens ?? 0),
        }),
        {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      ),
      // Context size at the end of the run lives in the LAST call's usage —
      // see TurnNode.lastUsage. Parts are unmerged single calls here.
      lastUsage: last.lastUsage ?? last.usage,
      model: last.model ?? head.model,
      stopReason: last.stopReason ?? null,
      absorbedIds: parts.slice(1).flatMap((p) => [p.id, ...(p.absorbedIds ?? [])]),
      stableIds: parts.flatMap((p) => p.stableIds ?? []),
      legacyIds: parts.some((p) => p.legacyIds?.length) ? parts.flatMap((p) => p.legacyIds ?? []) : undefined,
      occurrences: parts.some((p) => p.occurrences?.length)
        ? parts.flatMap((p) => p.occurrences ?? [])
        : undefined,
      // The fork anchor is the LAST part's, and so is its verdict. "Fork after
      // this turn" must include everything the node shows; falling back to an
      // earlier, anchorable part would silently cut before the later text (a
      // mid-turn message, a second prompt). A run whose last part can't
      // anchor (an injected or attachment tail) is unforkable as a whole —
      // the turn after it is where to fork, and that keeps the message.
      lastRawId: last.lastRawId ?? last.id,
      preCompact: last.preCompact,
      forkBlocked: last.forkBlocked,
      // Drawn hollow only when every part is synthetic.
      injected: parts.every((p) => p.injected) || undefined,
      midTurn: parts.every((p) => p.midTurn) || undefined,
    });
  }

  // Children of an absorbed turn now hang off the head that swallowed it.
  for (const n of out) {
    let p = n.parentId;
    while (p && remap.has(p)) p = remap.get(p)!;
    n.parentId = p ?? null;
  }
  return out;
}

function sameHolders(a: TurnNode, b: TurnNode): boolean {
  const x = copyHolders(a);
  const y = copyHolders(b);
  return x.length === y.length && x.every((s) => y.includes(s));
}

interface Interjection {
  text: string;
  timestamp?: string;
  /** Last record written before the user typed this. */
  afterUuid: string | null;
  seqAt: number;
  recAt: number;
}

/** Synthetic uuid prefix. Never collides: real uuids are hex-and-dashes. */
export const INJECTED_PREFIX = "queued:";

/**
 * Whole-text comparison for matching a queued message against a real record
 * in the SAME file. Not an opening gist: messages that share a long preamble
 * are still different. Whitespace is folded because the queue entry is the
 * text as typed and the record the text as delivered; this is a dedup within
 * one transcript, never an identity (those are exact, see identity.ts).
 */
const gist = foldedDigest;

/**
 * Give the user's mid-turn interjections a place in the tree.
 *
 * A message typed while Claude is still working never becomes a `user` record.
 * It is written once as `{"type":"queue-operation","operation":"enqueue",…}` —
 * no uuid, no parentUuid — and if it is then delivered *into* the running turn
 * (queue op `remove`, as opposed to `dequeue`) no record is ever created for
 * it. The conversation the model saw contains it; the transcript's DAG does
 * not, so the tree was silently dropping whole instructions.
 *
 * Each surviving interjection is synthesised as a user turn and spliced INTO
 * the chain — the record that followed it is re-parented onto it — rather than
 * hung off the side. Hanging it off the side would turn every interjection into
 * a spurious branch point, which is exactly the signal this app exists to show.
 *
 * The re-parent only happens when the following record still points at the
 * record the interjection came after. If it points somewhere else the user
 * rewound or branched in between, and inventing a link would misreport history.
 */
function spliceInterjections(
  sessionId: string,
  queued: Interjection[],
  records: RawRecord[],
  parentOf: Map<string, string | null>,
  seq: string[],
): void {
  if (queued.length === 0) return;

  // An enqueue that was later `dequeue`d became a normal prompt and is already
  // in the transcript. Match on content rather than on the queue ops: `remove`
  // is used both for "delivered mid-turn" and for "user deleted it", and the
  // record itself is the only reliable evidence of which happened.
  const said = new Set<string>();
  for (const r of records) {
    if (r.type !== "user") continue;
    const c = r.message?.content;
    if (typeof c === "string") said.add(gist(c));
    else if (Array.isArray(c)) {
      for (const b of c as { type?: string; text?: string }[]) {
        if (b.type === "text" && b.text) said.add(gist(b.text));
      }
    }
  }

  // Consecutive interjections must chain, not fan out from a shared parent.
  const tip = new Map<string, string>();
  const inserts: { at: number; rec: RawRecord }[] = [];
  let n = 0;

  for (const q of queued) {
    if (said.has(gist(q.text))) continue;

    const key = q.afterUuid ?? "\0root";
    const parent = tip.get(key) ?? q.afterUuid;
    // Session-qualified: a family tree holds several transcripts' interjections.
    const uuid = `${INJECTED_PREFIX}${sessionId.slice(0, 8)}:${n++}`;

    parentOf.set(uuid, parent);
    for (let k = q.seqAt; k < seq.length; k++) {
      if ((parentOf.get(seq[k]) ?? null) === parent) {
        parentOf.set(seq[k], uuid);
        break;
      }
    }
    tip.set(key, uuid);

    inserts.push({
      at: q.recAt,
      rec: {
        type: "user",
        uuid,
        parentUuid: parent,
        timestamp: q.timestamp,
        message: { role: "user", content: q.text },
      },
    });
  }

  // Back to front so earlier indices stay valid.
  for (let i = inserts.length - 1; i >= 0; i--) {
    records.splice(inserts[i].at, 0, inserts[i].rec);
  }
}

export interface Parsed {
  sessionId: string;
  /**
   * One node per API message / user record — NOT yet folded by
   * mergeSameRoleRuns, because family stitching must match turn-for-turn
   * before runs are merged (a merge boundary can differ between a parent,
   * which branches mid-run, and its fork, which doesn't).
   */
  nodes: TurnNode[];
  /** Stitch evidence per node id: `m:<message.id>` / `p:<promptId>|<digest>` / `u:|<digest>`. */
  keys: Map<NodeId, string>;
  /**
   * Every assistant API message id in the file. The API mints one per
   * response, and a copy-fork preserves the ones it copies, so two files
   * sharing ANY of them share history — whichever branch the fork copied.
   */
  messageIds: string[];
  /**
   * Set when the file should have been a session and isn't: unreadable, no
   * parseable line at all, or conversation records that yielded no turn.
   * Bookkeeping-only files (the CLI writes those) leave it unset.
   */
  problem?: "unreadable" | "malformed" | "unrecognized";
  /**
   * custom-title (last) > ai-title (last) > first real prompt. The prompt is
   * computed BEFORE merging: a merged node can start with slash-command
   * plumbing followed by the real question.
   */
  title: string;
  /** Newest timestamp on ANY record, displayed or not. 0 if none carried one. */
  touchedAt: number;
  /** Newest timestamp on a conversation record (`isActivity`). 0 if none. */
  activeAt: number;
  cwd: string;
  entrypoint?: string;
  version?: string;
  /** Explicit lineage stamped by SDK / Agentree forks. */
  forkedFrom?: string;
  unknownTypes: Record<string, number>;
}

const EMPTY = (sessionId: string, problem?: Parsed["problem"]): Parsed => ({
  sessionId,
  nodes: [],
  keys: new Map(),
  messageIds: [],
  problem,
  title: "",
  touchedAt: 0,
  activeAt: 0,
  cwd: "",
  unknownTypes: {},
});

/**
 * Read a transcript's records. Torn lines (a session mid-append) are skipped
 * but counted, so a file that is ALL unparseable can be told apart from an
 * empty one.
 */
function readLines(file: string): { records: RawRecord[]; bad: number } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const records: RawRecord[] = [];
  let bad = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as unknown;
      if (r && typeof r === "object") records.push(r as RawRecord);
      else bad++;
    } catch {
      bad++; // torn line
    }
  }
  return { records, bad };
}

export const readRecords = (file: string): RawRecord[] | null => readLines(file)?.records ?? null;

/**
 * Every record's parent, over ALL records (displayed or not) — the one
 * ancestry rule that both the parser and the fork writer use, so what is drawn
 * and what a fork copies can't disagree.
 *
 * `parentUuid` is the parent, except across a `/compact` boundary: its
 * physical parent is null and `logicalParentUuid` names the pre-compact tip.
 * Without following it a compacted session falls apart into a forest. In a
 * copy-fork that reference is STALE: the extension's fork gives every record
 * a fresh uuid but leaves the field pointing into the source's file (read
 * from its forkSession, 2.1.310). A copy is written in chain order, so the
 * record just before the boundary is that logical parent. Later records with
 * the same uuid win (the CLI rewrites a few in place).
 */
export function resolveLineage(records: RawRecord[]): Map<string, string | null> {
  const parentOf = new Map<string, string | null>();
  let prev: string | null = null;
  for (const rec of records) {
    if (!rec.uuid) continue;
    let parent = rec.parentUuid ?? null;
    if (parent === null && rec.logicalParentUuid) {
      parent = parentOf.has(rec.logicalParentUuid) ? rec.logicalParentUuid : prev;
    }
    parentOf.set(rec.uuid, parent);
    prev = rec.uuid;
  }
  return parentOf;
}

/**
 * Why a fork can't anchor at a turn — one place, so the panel and the fork
 * writer can't disagree.
 */
const BLOCK = {
  injected: "This message was delivered mid-turn and Claude Code wrote no record for it, so there is nothing to fork at.",
  midTurn:
    "This ends with a message sent mid-turn, which can't anchor a fork itself. Fork the turn after it — forks that pass this point keep the message.",
  preCompact:
    "This turn is from before the session's last /compact. Claude Code resumes a compacted session from its summary, so Agentree only forks after the compaction.",
};

/**
 * A record that is part of the conversation, for "last activity": every
 * user/assistant record — tool-only replies and tool results included, so a
 * session in a long tool loop stays live — a delivered mid-turn message, and
 * a compaction. Not titles, `last-prompt`, mode changes, file-history or
 * request-capture bookkeeping, which the CLI also writes when nobody talks.
 */
const isActivity = (rec: RawRecord) =>
  rec.type === "user" ||
  rec.type === "assistant" ||
  (rec.type === "attachment" && rec.attachment?.type === "queued_command") ||
  (rec.type === "system" && rec.subtype === "compact_boundary");

/** Project a transcript file into the node list. Read-only — we never write here. */
export function parseFile(file: string): Parsed {
  return parseRecords(
    path.basename(file).replace(/\.jsonl$/, ""),
    readLines(file),
    path.basename(path.dirname(file)),
  );
}

/** Claude Code's project-folder name for a directory: every non-alphanumeric becomes "-". */
const projectSlug = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-").toLowerCase();
const within = (dir: string, root: string) => {
  const r = cwdKey(root);
  const d = cwdKey(dir);
  return d !== r && d.startsWith(r.endsWith("/") ? r : `${r}/`);
};

/**
 * The directory a session belongs to, from the cwds its conversation records
 * carry, in order. The cwd is the SHELL's: it follows every `cd` the agent
 * runs, so the last one alone files sessions under subfolders. The project
 * folder the transcript sits in names the directory the CLI was started in,
 * and a moved repo continues in a new folder named after its new directory —
 * so the last cwd that folder encodes wins, in its latest spelling. Without
 * a match (a name too long to encode, a copied fixture), the last directory
 * that isn't merely inside, or above, the one before it.
 */
function sessionCwd(cwds: string[], dirName: string | undefined): string {
  const slug = dirName?.toLowerCase();
  const home = slug ? [...cwds].reverse().find((c) => projectSlug(c) === slug) : undefined;
  if (home) return [...cwds].reverse().find((c) => cwdKey(c) === cwdKey(home))!;
  let root = "";
  for (const c of cwds) {
    if (!root || cwdKey(c) === cwdKey(root) || !(within(c, root) || within(root, c))) root = c;
  }
  return root;
}

/**
 * Project one session's records — one file's, or the union of several
 * copies of the same session (`logicalRecords`) — into the node list.
 * `dirName` is the project folder they're filed in (see `sessionCwd`).
 */
export function parseRecords(
  sessionId: SessionId,
  read: { records: RawRecord[]; bad: number } | null,
  dirName?: string,
): Parsed {
  if (!read) return EMPTY(sessionId, "unreadable");
  if (read.records.length === 0) return EMPTY(sessionId, read.bad > 0 ? "malformed" : undefined);
  const all = read.records;

  // Pass 1: the FULL lineage, including record types we don't display.
  //
  // Claude Code interleaves `attachment`, `system`, `file-history-snapshot`
  // and friends into the same parent chain. Filtering them out without
  // re-linking leaves most parentUuid pointers dangling, which collapses the
  // whole tree to a handful of reachable nodes.
  const lineage = resolveLineage(all);
  const parentOf = new Map<string, string | null>();
  const records: RawRecord[] = [];
  let touchedAt = 0;
  let activeAt = 0;
  let cwd = "";
  const cwds: string[] = [];
  let entrypoint: string | undefined;
  let version: string | undefined;
  let forkedFrom: string | undefined;
  const unknownTypes: Record<string, number> = {};

  /** uuids in file order, so an interjection can be spliced at the right point. */
  const seq: string[] = [];
  const queued: Interjection[] = [];
  /** Name set with `/rename` or by a fork. Last one wins. */
  let customTitle = "";
  let aiTitle = "";
  /**
   * Everything recorded before the LAST `/compact` boundary. The CLI's loader
   * only indexes messages after it, so these uuids cannot anchor a fork.
   */
  const preCompact = new Set<string>();

  for (const rec of all) {
    if (rec.type && !KNOWN_TYPES.has(rec.type)) {
      unknownTypes[rec.type] = (unknownTypes[rec.type] ?? 0) + 1;
    }
    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (t > touchedAt) touchedAt = t;
      if (t > activeAt && isActivity(rec)) activeAt = t;
    }
    // Where the session continues (`sessionCwd`), from the conversation
    // records' cwds. Any record's first cwd is only the fallback.
    if (rec.cwd) {
      if (!cwd) cwd = rec.cwd;
      if ((rec.type === "user" || rec.type === "assistant") && rec.cwd !== cwds[cwds.length - 1]) cwds.push(rec.cwd);
    }
    if (!entrypoint && rec.entrypoint) entrypoint = rec.entrypoint;
    if (rec.version) version = rec.version;
    if (!forkedFrom && rec.forkedFrom?.sessionId) forkedFrom = rec.forkedFrom.sessionId;

    // Titles are uuid-less records, so this has to run before the `!rec.uuid` bail.
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
      customTitle = rec.customTitle;
      continue;
    }
    if (rec.type === "ai-title" && typeof rec.aiTitle === "string") {
      aiTitle = rec.aiTitle;
      continue;
    }

    if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {
      // Background-task notifications ride the SAME queue as the user's own
      // mid-turn (`/btw`) messages: the harness enqueues the notification text
      // and `remove`s it when delivered into the running turn. Splicing those
      // in would show system plumbing as hollow "user" turns the user never
      // typed — the very confusion this feature exists to avoid. Only entries
      // that BEGIN as a notification are dropped; a real message that quotes
      // one (e.g. "btw, <task-id>… renders weirdly") starts with prose and is
      // kept.
      if (/^\s*(\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification>)/.test(rec.content)) {
        continue;
      }
      queued.push({
        text: rec.content,
        timestamp: rec.timestamp,
        afterUuid: seq.length ? seq[seq.length - 1] : null,
        seqAt: seq.length,
        recAt: records.length,
      });
      continue;
    }

    if (!rec.uuid) continue;
    // Lineage is recorded for EVERY record, displayable or not, so that
    // resolveParent can re-link children across whatever we filter out.
    parentOf.set(rec.uuid, lineage.get(rec.uuid) ?? null);
    seq.push(rec.uuid);

    if (rec.type === "system" && rec.subtype === "compact_boundary") {
      for (const u of seq) preCompact.add(u);
    }

    if (rec.type === "user" || rec.type === "assistant") {
      records.push(rec);
    } else if (
      rec.type === "attachment" &&
      rec.attachment?.type === "queued_command" &&
      typeof rec.attachment.prompt === "string" &&
      rec.attachment.origin?.kind === "human" &&
      rec.attachment.commandMode !== "task-notification"
    ) {
      // The harness's own record of a delivered mid-turn message: project it
      // as a user turn. It has a real uuid at the real delivery point, and —
      // verified against the live CLI — any fork of a LATER turn retains it.
      // (Task notifications ride the same attachment type with
      // `commandMode: "task-notification"` and a null origin; those are
      // plumbing and are left out of the tree.)
      records.push({
        type: "user",
        uuid: rec.uuid,
        parentUuid: rec.parentUuid,
        timestamp: rec.timestamp,
        isSidechain: rec.isSidechain,
        promptId: rec.promptId,
        message: { role: "user", content: rec.attachment.prompt },
        agentreeMidTurn: true,
      });
    }
  }

  // Queue-operation reconstruction covers only transcripts old enough to lack
  // queued_command attachments; spliceInterjections' content dedup (`said`)
  // sees the attachment-projected user records above and drops duplicates.
  spliceInterjections(sessionId, queued, records, parentOf, seq);

  // Pass 1b: coalesce each assistant turn back into a single node.
  //
  // Claude Code writes ONE RECORD PER CONTENT BLOCK: a reply with thinking +
  // text + a tool call becomes three chained `assistant` records that share one
  // API `message.id`. Drawn naively that's three nodes per turn, two of them
  // with no text. Group by message.id and keep only the first record of each
  // group; `resolveParent` below then re-links children past the absorbed ones.
  const groups: RawRecord[][] = [];
  const groupOfKey = new Map<string, RawRecord[]>();
  const messageIds: string[] = [];

  for (const rec of records) {
    const key =
      rec.type === "assistant" && rec.message?.id ? `msg:${rec.message.id}` : null;
    const existing = key ? groupOfKey.get(key) : undefined;
    if (key && !existing) messageIds.push(rec.message!.id!);
    if (existing) {
      existing.push(rec);
    } else {
      const group = [rec];
      groups.push(group);
      if (key) groupOfKey.set(key, group);
    }
  }

  // Pass 1c: merge each group's blocks, then keep only turns that actually
  // SAID something.
  //
  // A turn whose whole content was a tool call renders as "(no text)" and tells
  // the reader nothing — in an agentic session those outnumber the real turns.
  // The filter is on merged text, so it has to run after the merge: a turn that
  // is thinking + tool_use + one line of prose must survive as that one line.
  // Whatever is dropped, `resolveParent` re-links children across.
  interface Draft {
    head: RawRecord;
    last: RawRecord;
    text: string;
    thinking: string;
    tools: string[];
    synthetic: boolean;
  }

  const drafts: Draft[] = groups.map((group) => {
    let text = "";
    let thinking = "";
    let synthetic = true;
    const tools: string[] = [];
    for (const rec of group) {
      const part = textOf(rec.message?.content);
      text += part.text;
      thinking += part.thinking;
      tools.push(...part.tools);
      if (part.text && !part.synthetic) synthetic = false;
    }
    return {
      head: group[0],
      last: group[group.length - 1],
      text,
      thinking,
      tools,
      synthetic,
    };
  });

  const visible = drafts.filter((d) => d.text.trim().length > 0);
  const kept = new Set(visible.map((d) => d.head.uuid!));

  /** Nearest ancestor that survives the display filter. */
  const resolveParent = (uuid: string): string | null => {
    const seen = new Set<string>([uuid]);
    let p = parentOf.get(uuid) ?? null;
    while (p !== null) {
      if (kept.has(p)) return p;
      if (seen.has(p)) return null; // malformed transcript; don't loop
      seen.add(p);
      p = parentOf.get(p) ?? null;
    }
    return null;
  };

  // Pass 2: project the surviving turns.
  const nodes: TurnNode[] = [];
  const keys = new Map<NodeId, string>();
  /** A prompt's key under identity schemes 2 and 3 (identity.ts), for old annotations. */
  const earlierKeys = new Map<NodeId, [string, string]>();
  const strongKeys = new Set<NodeId>();
  for (const { head, last, text, thinking, tools } of visible) {
    // Every record in a group repeats the same message-level usage, so take one
    // rather than summing — summing would multiply a turn's cost by its block
    // count and wreck the overlays.
    const u = last.message?.usage ?? head.message?.usage;
    const id = head.uuid!;
    const injected = id.startsWith(INJECTED_PREFIX);
    const midTurn = !!head.agentreeMidTurn;
    const beforeCompact = preCompact.has(last.uuid!);

    nodes.push({
      id,
      parentId: resolveParent(id),
      // Last record of the message group: a reply is written one record per
      // content block, and a fork must anchor on the block the turn ends with.
      lastRawId: last.uuid!,
      sourceSessionId: sessionId,
      role: head.type as TurnNode["role"],
      text,
      thinking: thinking || undefined,
      toolUses: tools.length ? tools : undefined,
      model: head.message?.model,
      // stop_reason lands on the final block of the turn.
      stopReason: last.message?.stop_reason ?? null,
      isSidechain: head.isSidechain || undefined,
      // No transcript record backs this turn — see spliceInterjections.
      injected: injected || undefined,
      // Backed by a queued_command attachment — real record, but not a valid
      // resume anchor itself.
      midTurn: midTurn || undefined,
      // Anchor predates the last /compact.
      preCompact: beforeCompact || undefined,
      forkBlocked: injected
        ? BLOCK.injected
        : midTurn
          ? BLOCK.midTurn
          : beforeCompact
            ? BLOCK.preCompact
            : undefined,
      timestamp: head.timestamp ? Date.parse(head.timestamp) : 0,
      // A reply streamed as several records ends with its last one.
      endedAt: last !== head && last.timestamp ? Date.parse(last.timestamp) : undefined,
      usage: u
        ? {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          }
        : undefined,
    });

    // Stitch evidence a copy-fork preserves verbatim (uuids are NOT preserved):
    // the API message id for replies, the prompt id plus the WHOLE text (as a
    // digest) for prompts. NOT the timestamp: a fork re-stamps its last copied
    // record, so a fork ending on a prompt without a promptId (older
    // transcripts) would no longer match its own source. Stitching only
    // matches under an already matched parent, so without a promptId two
    // prompts merge only if they are the same text, whitespace and all, in
    // the same place.
    // A prompt with a prompt id is keyed `p:` (strong); one without keeps
    // the `u:` form as the input its parent's identity qualifies.
    const strong = head.type === "assistant" && !!head.message?.id;
    if (strong) {
      keys.set(id, `m:${head.message!.id}`);
    } else {
      const pid = head.promptId ?? "";
      keys.set(id, `${pid ? "p" : "u"}:${pid}|${digest(text)}`);
      earlierKeys.set(id, [`u:${pid}|${foldedDigest(text)}`, `u:${pid}|${digest(text)}`]);
    }
    if (strong || head.promptId) strongKeys.add(id);
  }
  // Identity for annotations and selection: the key itself where it's unique
  // (a message id, a prompt id), else qualified by the parent's identity.
  assignStableIds(nodes, (n) => ({
    key: keys.get(n.id)!,
    strong: strongKeys.has(n.id),
    earlier: earlierKeys.get(n.id),
  }));
  // Conversation records that produced nothing is what a changed record shape
  // looks like — as opposed to a file of pure bookkeeping, which has none.
  const problem = nodes.length === 0 && records.some((r) => r.type === "user" || r.type === "assistant")
    ? "unrecognized"
    : nodes.length === 0 && read.bad > all.length
      ? "malformed"
      : undefined;
  const titleDraft = visible.find(
    (d) => d.head.type === "user" && !d.synthetic && !d.text.startsWith("[Request interrupted"),
  );

  return {
    sessionId,
    nodes,
    keys,
    messageIds,
    problem,
    // A name the user chose with `/rename` beats the CLI's generated title,
    // which beats anything inferred from the first prompt.
    title:
      customTitle.trim() ||
      aiTitle.trim() ||
      (titleDraft?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    touchedAt,
    activeAt,
    cwd: sessionCwd(cwds, dirName) || cwd,
    entrypoint,
    version,
    forkedFrom,
    unknownTypes,
  };
}

// ------------------------------------------------------------------ lookup

interface Located {
  /** The logical session: every physical copy, resolved (`resolveSource`). */
  source: SessionSummary;
  /** The copy that stands for it — the newest-activity one that is read. */
  file: string;
  /** Where the session continues: its last cwd. */
  cwd: string;
}

const isSessionId = (id: string) => /^[a-zA-Z0-9-]{8,64}$/.test(id);

/**
 * Find a session's transcripts: EVERY project folder holding one — a moved
 * repo leaves the same session id in two — resolved into one logical
 * session. Cheap: one existsSync per project dir, plus cached summaries.
 */
export function locate(sessionId: SessionId): Located | null {
  if (!isSessionId(sessionId)) return null;
  const root = claudeProjects();
  if (!fs.existsSync(root)) return null;

  const copies: FileSummary[] = [];
  for (const dirName of fs.readdirSync(root)) {
    const file = path.join(root, dirName, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const s = summarise(file, dirName);
    if (s) copies.push(s);
  }
  if (copies.length === 0) return null;
  const source = resolveSource(copies);
  return { source, file: source.file, cwd: source.cwd };
}

/** Sessions are per-directory, so the change of directory is part of the command. */
const claudeResume = (sessionId: SessionId, cwd: string) => resumeCommandFor("claude", sessionId, cwd);

// ------------------------------------------------------------------ summaries

/**
 * Per-file summary cache, keyed by file identity (mtime + size).
 *
 * The welcome screen scans every transcript, and there are hundreds of them
 * totalling hundreds of MB — one full scan is ~700ms and a few hundred MB of
 * garbage. With a live watcher that scan reruns whenever *any* session changes,
 * so re-parsing the files that didn't change is nearly all of the cost.
 *
 * Only metadata is cached, never the node array: keeping every session's turns
 * resident would trade a CPU problem for a much worse memory one.
 */
interface FileSummary {
  file: string;
  dirName: string;
  id: SessionId;
  mtimeMs: number;
  size: number;
  /** File creation time — orders a fork after the session it was copied from. */
  createdMs: number;
  title: string;
  cwd: string;
  activeAt: number;
  touchedAt: number;
  nodeCount: number;
  branchPoints: number;
  entrypoint?: string;
  version?: string;
  messageIds: string[];
  forkedFrom?: string;
  problem?: Parsed["problem"];
  unknownTypes: Record<string, number>;
}

const summaries = new Map<string, FileSummary>();

function summarise(file: string, dirName: string): FileSummary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = summaries.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit;

  const s = summaryOf(parseFile(file), file, dirName, stat);
  summaries.set(file, s);
  return s;
}

function summaryOf(
  parsed: Parsed,
  file: string,
  dirName: string,
  stat: { mtimeMs: number; size: number; birthtimeMs?: number },
): FileSummary {
  const merged = mergeSameRoleRuns(parsed.nodes);
  return {
    file,
    dirName,
    id: parsed.sessionId,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    createdMs: stat.birthtimeMs || parsed.nodes[0]?.timestamp || stat.mtimeMs,
    title: parsed.title,
    cwd: parsed.cwd,
    // Record timestamps, not the file's mtime (which moves when the CLI
    // rewrites bookkeeping for a session nobody is talking in). Activity is
    // not the newest *displayed* turn either: that stands still through a
    // long tool loop, making a running session look minutes stale.
    touchedAt: parsed.touchedAt || stat.mtimeMs,
    activeAt: parsed.activeAt || parsed.touchedAt || stat.mtimeMs,
    nodeCount: merged.length,
    branchPoints: countBranchPoints(childIndex(merged)),
    entrypoint: parsed.entrypoint,
    version: parsed.version,
    messageIds: parsed.messageIds,
    forkedFrom: parsed.forkedFrom,
    problem: parsed.problem,
    unknownTypes: parsed.unknownTypes,
  };
}

/** Every transcript in one project directory, summarised. */
function summariseDir(dirName: string, seen?: Set<string>): FileSummary[] {
  const dir = path.join(claudeProjects(), dirName);
  const out: FileSummary[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const file = path.join(dir, f);
    seen?.add(file);
    const s = summarise(file, dirName);
    if (s) out.push(s);
  }
  return out;
}

// ------------------------------------------------------------------ copies

/**
 * One logical session. Usually one file — but a session id can exist in
 * several project folders: a moved or renamed repo leaves the old folder's
 * copy behind and the session continues in a new one (verified: an 11.8 MB
 * copy in the old folder, every record of which is in the 23.5 MB copy in
 * the new one). The summary fields describe the session as a whole;
 * `file`/`dirName` name the copy that stands for it.
 */
interface SessionSummary extends FileSummary {
  /** Every physical copy, shadows included: they are watched and keyed on. */
  copies: FileSummary[];
  /** The copies whose conversation is read, oldest activity first: one, unless they diverged. */
  parse: FileSummary[];
}

/** Record uuids per copy, by file identity — only read for ids with several copies. */
const uuidCache = new Map<string, { mtimeMs: number; size: number; uuids: Set<string> }>();

export function uuidsOf(c: FileSummary): Set<string> {
  const hit = uuidCache.get(c.file);
  if (hit && hit.mtimeMs === c.mtimeMs && hit.size === c.size) return hit.uuids;
  const uuids = new Set<string>();
  for (const r of readRecords(c.file) ?? []) if (r.uuid) uuids.add(r.uuid);
  uuidCache.set(c.file, { mtimeMs: c.mtimeMs, size: c.size, uuids });
  return uuids;
}

const contains = (big: Set<string>, small: Set<string>) => {
  if (small.size > big.size) return false;
  for (const u of small) if (!big.has(u)) return false;
  return true;
};

/** Logical summaries of sessions with several copies, keyed by every copy's identity. */
const logicalSummaries = new Map<string, SessionSummary>();
const copiesSig = (copies: FileSummary[]) => copies.map((c) => `${c.file}:${c.mtimeMs}:${c.size}`).sort().join("|");

/**
 * Resolve one session id's copies into a logical session.
 *
 * Two reductions, kept apart (`logicalRecords`). The CONVERSATION is
 * deduplicated by record uuid: copies of ONE session share them (it is the
 * same transcript, grown in different places), so a copy whose uuids are all
 * in another copy is a SHADOW — every conversation record it has is already
 * read there — and its conversation is not parsed. Picking a copy by recency
 * or size instead would silently drop a real branch when two copies share a
 * prefix and then each grew; copies neither of which contains the other are
 * read as the union of their records, so both continuations are drawn.
 * METADATA (titles, summaries) has no uuid, so containment says nothing about
 * it: a shadow can hold a newer rename. It is read from every copy.
 */
function resolveSource(copies: FileSummary[]): SessionSummary {
  if (copies.length === 1) return { ...copies[0], copies, parse: copies };
  const sig = copiesSig(copies);
  const hit = logicalSummaries.get(sig);
  if (hit) return hit;

  const largestFirst = [...copies].sort((a, b) => uuidsOf(b).size - uuidsOf(a).size || b.activeAt - a.activeAt);
  const kept: FileSummary[] = [];
  for (const c of largestFirst) if (!kept.some((k) => contains(uuidsOf(k), uuidsOf(c)))) kept.push(c);
  const parse = kept.sort((a, b) => a.activeAt - b.activeAt);
  const primary = parse[parse.length - 1];
  const summary = summaryOf(
    parseRecords(primary.id, logicalRecords(parse, copies), primary.dirName),
    primary.file,
    primary.dirName,
    primary,
  );
  const s: SessionSummary = {
    ...summary,
    // The session began when its oldest copy did: that orders it among forks.
    createdMs: Math.min(...copies.map((c) => c.createdMs)),
    // A shadow's bookkeeping can be newer than anything read for the tree.
    touchedAt: Math.max(summary.touchedAt, ...copies.map((c) => c.touchedAt)),
    copies,
    parse,
  };
  logicalSummaries.set(sig, s);
  return s;
}

/**
 * Uuid-less records Agentree reads that have no place in the conversation:
 * titles (the parser) and compaction summaries (the fork writer).
 */
const METADATA = new Set(["custom-title", "ai-title", "summary"]);

/**
 * One session's records from all of its copies, as one stream.
 *
 * Conversation: the read copy with the oldest activity whole, then each
 * other read copy from its first record the stream doesn't hold yet, minus
 * the records it does. Every copy starts with the shared prefix, so each
 * keeps its own order. Copies share uuids, so this deduplicates without
 * matching content — though a uuid two copies rewrote differently keeps the
 * first copy's payload.
 *
 * Metadata (`METADATA`) follows, from EVERY copy — shadows and the part of a
 * diverged copy before its first new uuid included — ordered by when each
 * copy was last written (file mtime, then activity, then path), each in file
 * order. Those records carry no timestamp, so the write order of the files
 * holding them is the only order there is; the parser and the fork writer
 * take the last, so the copy written last names the session.
 */
function logicalRecords(parse: FileSummary[], copies: FileSummary[]): { records: RawRecord[]; bad: number } | null {
  const reads = new Map<FileSummary, { records: RawRecord[]; bad: number } | null>();
  const read = (c: FileSummary) => {
    if (!reads.has(c)) reads.set(c, readLines(c.file));
    return reads.get(c)!;
  };

  const records: RawRecord[] = [];
  const held = new Set<string>();
  let bad = 0;
  let any = false;
  for (const c of parse) {
    const r = read(c);
    if (!r) continue;
    any = true;
    bad += r.bad;
    const conversation = r.records.filter((x) => !(x.type && METADATA.has(x.type)));
    const from = records.length === 0 ? 0 : conversation.findIndex((x) => !!x.uuid && !held.has(x.uuid));
    if (from < 0) continue;
    for (const x of conversation.slice(from)) {
      if (x.uuid && held.has(x.uuid)) continue;
      records.push(x);
    }
    for (const x of records) if (x.uuid) held.add(x.uuid);
  }
  if (!any) return null;

  const byWrite = [...copies].sort(
    (a, b) => a.mtimeMs - b.mtimeMs || a.activeAt - b.activeAt || a.file.localeCompare(b.file),
  );
  for (const c of byWrite) {
    for (const x of read(c)?.records ?? []) if (x.type && METADATA.has(x.type)) records.push(x);
  }
  return { records, bad };
}

/** A logical session's records, as the parser reads them — the fork writer's input too. */
export function readSourceRecords(s: SessionSummary): RawRecord[] | null {
  return s.copies.length === 1 ? readRecords(s.copies[0].file) : (logicalRecords(s.parse, s.copies)?.records ?? null);
}

function parseSource(s: SessionSummary): Parsed {
  return s.copies.length === 1
    ? parseFile(s.copies[0].file)
    : parseRecords(s.id, logicalRecords(s.parse, s.copies), s.parse[s.parse.length - 1].dirName);
}

/**
 * Every transcript under every project folder, summarised, and resolved into
 * logical sessions. Warm, this is one stat per file.
 */
function scanSources(seen?: Set<string>): { files: FileSummary[]; sources: SessionSummary[] } {
  const root = claudeProjects();
  const files: FileSummary[] = [];
  if (fs.existsSync(root)) {
    for (const dirName of fs.readdirSync(root)) {
      try {
        if (!fs.statSync(path.join(root, dirName)).isDirectory()) continue;
      } catch {
        continue;
      }
      files.push(...summariseDir(dirName, seen));
    }
  }
  const byId = new Map<string, FileSummary[]>();
  for (const f of files) {
    const arr = byId.get(f.id);
    if (arr) arr.push(f);
    else byId.set(f.id, [f]);
  }
  return { files, sources: [...byId.values()].map(resolveSource) };
}

// ------------------------------------------------------------------ families

/**
 * Group sessions into fork families — across ALL project folders: API
 * message ids are global, and a family's members can live in different
 * folders (a fork taken after the repo moved).
 *
 * The VS Code extension's "Fork conversation" writes a NEW transcript holding a
 * copy of one chain of its source (fresh uuids, same API message ids, same
 * prompt ids, same timestamps) and records no lineage at all. The API mints a
 * message id once per response, so two files that share ANY assistant message
 * id share history, however similar or different their opening prompts. Any,
 * not the first: a fork copies the branch it was taken on, which need not
 * contain the file's earliest reply (a regenerated first answer, say).
 * Explicit lineage (`forkedFrom` on SDK/Agentree forks, Agentree's sidecar)
 * links families too.
 */
function groupFamilies(files: SessionSummary[]): SessionSummary[][] {
  const byId = new Map(files.map((f) => [f.id, f]));
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

  const lineage = readLineage();
  const byMessage = new Map<string, string>();
  for (const f of files) {
    if (f.nodeCount === 0) continue;
    if (f.forkedFrom && byId.has(f.forkedFrom)) union(f.id, f.forkedFrom);
    const side = lineage[f.id];
    if (side && byId.has(side)) union(f.id, side);
    for (const m of f.messageIds) {
      const other = byMessage.get(m);
      if (other) union(f.id, other);
      else byMessage.set(m, f.id);
    }
  }

  const groups = new Map<string, SessionSummary[]>();
  for (const f of files) {
    if (f.nodeCount === 0) continue;
    const r = find(f.id);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  }
  return [...groups.values()];
}

const asMember = (id: string, p: Parsed, parentSessionId: string | null = null): FamilyMember => ({
  sessionId: id,
  parentSessionId,
  nodes: p.nodes,
  keyOf: (n) => p.keys.get(n.id) ?? n.id,
});

/**
 * Files created within this long of each other were created together — a
 * copied or restored directory, not a user forking. Their creation order
 * says nothing about who forked whom.
 */
const SAME_BATCH_MS = 1000;

interface Parentage {
  parent: string | null;
  evidence?: MemberInfo["parentEvidence"];
}

/**
 * Decide who forked from whom inside one family.
 *
 * Shared API message ids prove two transcripts share history; they say
 * nothing about direction. The extension's own forks record no lineage, so
 * direction comes from the weakest evidence there is, and is labelled as
 * inferred. Three steps, none able to contradict the one before:
 *
 *  1. Explicit lineage (`forkedFrom`, the sidecar) — an edge that would close
 *     a cycle is dropped rather than trusted.
 *  2. An order with every explicit ancestor before its descendants; inside
 *     that, chronologically by file creation — a fork's file is created after
 *     its source's, and a rename can't change that. Only among files created
 *     together (a copied or restored directory, see SAME_BATCH_MS) does the
 *     count of " (fork)" suffixes the extension stamped on titles decide.
 *  3. A member without explicit lineage takes the EARLIER member whose tree
 *     holds the most of its history (`overlap`, over every branch of both): a
 *     fork of a fork overlaps its direct parent more than the root, even after
 *     that parent rewound. Every edge points backwards in the order, so the
 *     result is a forest — never a cycle.
 */
function familyParents(group: FileSummary[], parsed: Map<string, Parsed>): Map<string, Parentage> {
  const lineage = readLineage();
  const ids = new Set(group.map((g) => g.id));
  const byCreation = [...group].sort((a, b) => a.createdMs - b.createdMs);

  const explicit = new Map<string, string>();
  const isAncestor = (a: string, of: string) => {
    const seen = new Set<string>();
    for (let cur = explicit.get(of); cur && !seen.has(cur); cur = explicit.get(cur)) {
      if (cur === a) return true;
      seen.add(cur);
    }
    return false;
  };
  for (const m of byCreation) {
    const p = [m.forkedFrom, lineage[m.id]].find((x) => x && ids.has(x) && x !== m.id);
    if (p && !isAncestor(m.id, p)) explicit.set(m.id, p);
  }

  // Chronological, with each same-batch run re-ordered by title evidence.
  const forkDepth = (t: string) => (t.match(/\(fork\)/g) ?? []).length;
  const chrono: FileSummary[] = [];
  for (let i = 0; i < byCreation.length; ) {
    let j = i + 1;
    while (j < byCreation.length && byCreation[j].createdMs - byCreation[j - 1].createdMs < SAME_BATCH_MS) j++;
    chrono.push(...byCreation.slice(i, j).sort((a, b) => forkDepth(a.title) - forkDepth(b.title)));
    i = j;
  }
  const order: FileSummary[] = [];
  const placed = new Set<string>();
  while (chrono.length) {
    const i = Math.max(
      0,
      chrono.findIndex((m) => !explicit.has(m.id) || placed.has(explicit.get(m.id)!)),
    );
    const [m] = chrono.splice(i, 1);
    order.push(m);
    placed.add(m.id);
  }

  const fm = new Map(group.map((g) => [g.id, asMember(g.id, parsed.get(g.id)!)]));
  const out = new Map<string, Parentage>();
  order.forEach((m, i) => {
    const e = explicit.get(m.id);
    if (e) {
      out.set(m.id, { parent: e, evidence: "explicit" });
      return;
    }
    let best: string | null = null;
    let bestN = 0;
    for (let j = 0; j < i; j++) {
      const n = overlap(fm.get(m.id)!, fm.get(order[j].id)!);
      if (n > bestN) {
        bestN = n;
        best = order[j].id;
      }
    }
    out.set(m.id, best ? { parent: best, evidence: "inferred" } : { parent: null });
  });
  return out;
}

interface Family {
  rootId: string;
  nodes: TurnNode[];
  members: MemberInfo[];
}

/** Parse, order and stitch one family into a single merged tree. */
function buildFamily(group: SessionSummary[]): Family {
  const parsed = new Map(group.map((g) => [g.id, parseSource(g)]));
  const parents: Map<string, Parentage> =
    group.length > 1 ? familyParents(group, parsed) : new Map([[group[0].id, { parent: null }]]);
  const parentOf = (id: string) => parents.get(id)?.parent ?? null;
  const rootId = [...group].sort((a, b) => a.createdMs - b.createdMs).find((g) => !parentOf(g.id))!.id;

  const fm = group.map((g) => asMember(g.id, parsed.get(g.id)!, parentOf(g.id)));
  // Root first so its node ids are the ones the shared prefix keeps.
  fm.sort((a, b) => (a.sessionId === rootId ? -1 : b.sessionId === rootId ? 1 : 0));

  const nodes = mergeSameRoleRuns(group.length > 1 ? stitchFamily(fm) : parsed.get(group[0].id)!.nodes.map((n) => ({ ...n })));
  // A copied history's holders are its copies; the merge kept every part of
  // a node held by the same sessions, so they hold all of it.
  for (const n of nodes) n.heldBy = copyHolders(n);
  const members: MemberInfo[] = group.map((g) => ({
    id: g.id,
    title: g.title || "Untitled",
    parentId: parentOf(g.id),
    parentEvidence: parents.get(g.id)?.evidence,
    cwd: g.cwd,
    resumeCommand: claudeResume(g.id, g.cwd),
    activeAt: g.activeAt,
    touchedAt: g.touchedAt,
    entrypoint: g.entrypoint,
    files: g.copies.map((c) => c.file),
  }));
  assignTips(nodes, members);
  return { rootId, nodes, members };
}

/** Family-level meta cache, keyed by the identity of every member's every copy. */
const familyMetas = new Map<string, SessionMeta>();
const signature = (group: SessionSummary[]) => copiesSig(group.flatMap((g) => g.copies));

function familyMeta(group: SessionSummary[], built?: Family): SessionMeta {
  const activeAt = Math.max(...group.map((g) => g.activeAt));
  const touchedAt = Math.max(...group.map((g) => g.touchedAt));

  if (group.length === 1) {
    const g = group[0];
    return {
      id: g.id,
      provider: "claude",
      cwd: g.cwd,
      project: g.cwd ? baseName(g.cwd) : decodeProjectName(g.dirName),
      title: g.title || "Untitled",
      activeAt,
      touchedAt,
      nodeCount: g.nodeCount,
      branchPoints: g.branchPoints,
      resumeCommand: claudeResume(g.id, g.cwd),
      members: 1,
      entrypoint: g.entrypoint,
    };
  }

  const sig = signature(group);
  const hit = familyMetas.get(sig);
  if (hit) return hit;
  const fam = built ?? buildFamily(group);
  const r = group.find((g) => g.id === fam.rootId)!;
  const meta: SessionMeta = {
    id: fam.rootId,
    provider: "claude",
    cwd: r.cwd,
    project: r.cwd ? baseName(r.cwd) : decodeProjectName(r.dirName),
    title: r.title || "Untitled",
    activeAt,
    touchedAt,
    nodeCount: fam.nodes.length,
    branchPoints: countBranchPoints(childIndex(fam.nodes)),
    resumeCommand: claudeResume(fam.rootId, r.cwd),
    members: group.length,
    forks: forkSummaries(fam.members, fam.rootId),
    entrypoint: r.entrypoint,
  };
  familyMetas.set(sig, meta);
  return meta;
}

// ------------------------------------------------------------------ API

let lastHealth: ProviderHealth | null = null;
export const claudeHealth = (): ProviderHealth =>
  lastHealth ?? new HealthScan("claude", claudeProjects()).done();

export function listSessions(opts: { limit?: number } = {}): SessionMeta[] {
  const health = new HealthScan("claude", claudeProjects());
  const seen = new Set<string>();
  const { files, sources } = scanSources(seen);

  // Every physical file lands in exactly one health bucket; a shadow copy is
  // deliberately not read, so it counts as hidden.
  const shadows = new Set<string>();
  let copied = 0;
  let diverged = 0;
  for (const s of sources) {
    if (s.copies.length < 2) continue;
    copied++;
    if (s.parse.length > 1) diverged++;
    for (const c of s.copies) if (!s.parse.includes(c)) shadows.add(c.file);
  }
  for (const f of files) {
    health.file();
    if (f.problem) health.failed();
    else if (shadows.has(f.file) || f.nodeCount === 0) health.skipped();
    else health.parsed();
    health.version(f.version ? `claude ${minorVersion(f.version)}` : undefined);
    health.unknown(f.unknownTypes);
  }
  if (copied) {
    health.warn(
      `${copied} session${copied === 1 ? " has copies" : "s have copies"} in more than one project folder (a moved repo); each is read as one session` +
        (diverged ? `, and ${diverged} of them diverged, so both continuations are drawn.` : "."),
    );
  }

  const out = groupFamilies(sources).map((group) => familyMeta(group));

  // Forget deleted transcripts, so the caches can't outgrow the directory.
  for (const key of summaries.keys()) if (!seen.has(key)) summaries.delete(key);
  for (const key of uuidCache.keys()) if (!seen.has(key)) uuidCache.delete(key);
  const live = new Set(sources.filter((s) => s.copies.length > 1).map((s) => copiesSig(s.copies)));
  for (const key of logicalSummaries.keys()) if (!live.has(key)) logicalSummaries.delete(key);
  if (familyMetas.size > 500) familyMetas.clear();

  health.listed(out.length);
  lastHealth = health.done();
  out.sort((a, b) => b.activeAt - a.activeAt);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/** The family holding `sessionId`, across every project folder; null if no such session. */
function familyOf(sessionId: SessionId): { group: SessionSummary[] | null; self: SessionSummary } | null {
  if (!isSessionId(sessionId)) return null;
  const { sources } = scanSources();
  const self = sources.find((s) => s.id === sessionId);
  if (!self) return null;
  return { group: groupFamilies(sources).find((g) => g.includes(self)) ?? null, self };
}

/** Load the family containing `sessionId` — any member id opens the whole tree. */
export function loadSession(sessionId: SessionId): SessionDetail | null {
  const found = familyOf(sessionId);
  if (!found) return null;
  if (!found.group) {
    // A transcript with no displayable turn yet (e.g. a fork nobody has
    // spoken in): open it as an empty tree rather than "not found".
    return { meta: familyMeta([found.self]), nodes: [], members: [] };
  }

  const fam = buildFamily(found.group);
  applyAnnotations(fam.nodes, fam.members.map((m) => m.id));

  return {
    meta: familyMeta(found.group, fam),
    nodes: fam.nodes,
    members: fam.members,
  };
}

/**
 * Every folder the live view of `sessionId` must watch: wherever any copy of
 * any member of its family lives. A family can span folders.
 */
export function claudeWatchDirs(sessionId: SessionId): string[] {
  const found = familyOf(sessionId);
  if (!found) return [];
  const group = found.group ?? [found.self];
  return [...new Set(group.flatMap((g) => g.copies.map((c) => path.dirname(c.file))))];
}
