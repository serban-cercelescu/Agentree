import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childIndex, countBranchPoints } from "../shared/render.ts";
import type { NodeId, SessionDetail, SessionId, SessionMeta, TurnNode } from "../shared/types.ts";
import { readMeta } from "./meta.ts";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

function decodeProjectName(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dirName;
}

// ------------------------------------------------------------------ parsing

interface RawRecord {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  isSidechain?: boolean;
  cwd?: string;
  /** `queue-operation` only: enqueue | dequeue | remove. */
  operation?: string;
  /** `queue-operation` only: the text the user typed. */
  content?: unknown;
  /** `custom-title` only: the name set with `/rename`. */
  customTitle?: string;
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

// Claude Code plumbing that leaks into `user` records as literal markup.
const ESC = String.fromCharCode(27);
/** CSI sequences — `\e[1m` and friends — from command output captured verbatim. */
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/** Boilerplate addressed to the model, never written or read by the user. */
const DROP_BLOCKS = /<(local-command-caveat|system-reminder)>[\s\S]*?<\/\1>/g;
const WRAPPERS = [
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "user-prompt-submit-hook",
  "task-notification",
  // `!`-prefixed bash mode in the CLI
  "bash-input",
  "bash-stdout",
  "bash-stderr",
].join("|");
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
function cleanText(s: string): { text: string; synthetic: boolean } {
  let out = s.replace(ANSI, "").replace(DROP_BLOCKS, "");
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
 * never collapsed — a branch below the run simply re-parents onto the head.
 */
function mergeSameRoleRuns(nodes: TurnNode[]): TurnNode[] {
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
    out.push({
      ...head,
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
      lastUsage: last.usage,
      model: last.model ?? head.model,
      stopReason: last.stopReason ?? null,
      absorbedIds: parts.slice(1).map((p) => p.id),
      // The merged turn ends where its LAST part ends — that's the record a
      // fork has to resume after.
      lastRawId: last.lastRawId ?? last.id,
      // Only wholly-synthetic runs are unforkable; one real record in the run
      // gives the merged turn a resume point.
      injected: parts.every((p) => p.injected) || undefined,
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

interface Interjection {
  text: string;
  timestamp?: string;
  /** Last record written before the user typed this. */
  afterUuid: string | null;
  seqAt: number;
  recAt: number;
}

/** Synthetic uuid prefix. Never collides: real uuids are hex-and-dashes. */
const INJECTED_PREFIX = "queued:";

/** Normalised prefix, for matching an interjection against a real record. */
const gist = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 80);

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
    const uuid = `${INJECTED_PREFIX}${n++}`;

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

interface Parsed {
  nodes: TurnNode[];
  /**
   * First user turn that is actually a prompt. Computed BEFORE merging: a
   * merged node can start with slash-command plumbing followed by the real
   * question, and titling from the merged text surfaces the plumbing.
   */
  title: string;
  /** Newest timestamp on ANY record, displayed or not. 0 if none carried one. */
  touchedAt: number;
}

/** Project a transcript file into the node list. Read-only — we never write here. */
function parseFile(file: string): Parsed {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { nodes: [], title: "", touchedAt: 0 };
  }

  // Pass 1: the FULL lineage, including record types we don't display.
  //
  // Claude Code interleaves `attachment`, `system`, `file-history-snapshot`
  // and friends into the same parent chain. Filtering them out without
  // re-linking leaves most parentUuid pointers dangling, which collapses the
  // whole tree to a handful of reachable nodes.
  const parentOf = new Map<string, string | null>();
  const records: RawRecord[] = [];
  let touchedAt = 0;

  /** uuids in file order, so an interjection can be spliced at the right point. */
  const seq: string[] = [];
  const queued: Interjection[] = [];
  /** Name set with `/rename`. Last one wins — a session can be renamed twice. */
  let customTitle = "";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue; // tolerate a torn line from a session still being written
    }
    if (rec.timestamp) {
      const t = Date.parse(rec.timestamp);
      if (t > touchedAt) touchedAt = t;
    }

    // `/rename` appends a uuid-less `custom-title` record, so this has to run
    // before the `!rec.uuid` bail below.
    if (rec.type === "custom-title" && typeof rec.customTitle === "string") {
      customTitle = rec.customTitle;
      continue;
    }

    if (rec.type === "queue-operation" && rec.operation === "enqueue" && typeof rec.content === "string") {
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
    parentOf.set(rec.uuid, rec.parentUuid ?? null);
    seq.push(rec.uuid);

    if (rec.type === "user" || rec.type === "assistant") records.push(rec);
  }

  spliceInterjections(queued, records, parentOf, seq);

  // Pass 1b: coalesce each assistant turn back into a single node.
  //
  // Claude Code writes ONE RECORD PER CONTENT BLOCK: a reply with thinking +
  // text + a tool call becomes three chained `assistant` records that share one
  // API `message.id`. Drawn naively that's three nodes per turn, two of them
  // with no text. Group by message.id and keep only the first record of each
  // group; `resolveParent` below then re-links children past the absorbed ones.
  const groups: RawRecord[][] = [];
  const groupOfKey = new Map<string, RawRecord[]>();

  for (const rec of records) {
    const key =
      rec.type === "assistant" && rec.message?.id ? `msg:${rec.message.id}` : null;
    const existing = key ? groupOfKey.get(key) : undefined;
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
  for (const { head, last, text, thinking, tools } of visible) {
    // Every record in a group repeats the same message-level usage, so take one
    // rather than summing — summing would multiply a turn's cost by its block
    // count and wreck the overlays.
    const u = last.message?.usage ?? head.message?.usage;

    nodes.push({
      id: head.uuid!,
      parentId: resolveParent(head.uuid!),
      // Last record of the message group: a reply is written one record per
      // content block, and a fork must anchor on the block the turn ends with.
      lastRawId: last.uuid!,
      role: head.type as TurnNode["role"],
      text,
      thinking: thinking || undefined,
      toolUses: tools.length ? tools : undefined,
      model: head.message?.model,
      // stop_reason lands on the final block of the turn.
      stopReason: last.message?.stop_reason ?? null,
      isSidechain: head.isSidechain || undefined,
      // No transcript record backs this turn — see spliceInterjections.
      injected: head.uuid!.startsWith(INJECTED_PREFIX) || undefined,
      timestamp: head.timestamp ? Date.parse(head.timestamp) : 0,
      usage: u
        ? {
            input_tokens: u.input_tokens ?? 0,
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
          }
        : undefined,
    });
  }
  const titleDraft = visible.find(
    (d) => d.head.type === "user" && !d.synthetic && !d.text.startsWith("[Request interrupted"),
  );

  return {
    nodes: mergeSameRoleRuns(nodes),
    // A name the user chose with `/rename` beats anything inferred from the
    // first prompt — it is the only title they actually asked for.
    title:
      customTitle.trim() ||
      (titleDraft?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90),
    touchedAt,
  };
}

/**
 * When the conversation was last touched.
 *
 * The newest record's own timestamp, not the file's mtime, and not the newest
 * *displayed* turn either. mtime moves when the CLI rewrites bookkeeping for a
 * session nobody is talking in; the newest displayed turn stands still through
 * a long tool loop, making an actively-running session look minutes stale. The
 * newest record of any kind is the one that tracks real activity.
 */
function lastInteraction(parsed: Parsed, mtimeMs: number): number {
  return parsed.touchedAt || mtimeMs;
}

// ------------------------------------------------------------------ lookup

interface Located {
  file: string;
  cwd: string;
  dirName: string;
}

/** Index of sessionId -> file, rebuilt on demand (cheap: a readdir per project). */
export function locate(sessionId: SessionId): Located | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  if (!fs.existsSync(PROJECTS)) return null;

  for (const dirName of fs.readdirSync(PROJECTS)) {
    const file = path.join(PROJECTS, dirName, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) {
      // The cwd recorded inside the transcript is authoritative; the directory
      // name is a lossy encoding (both / and . collapse to -).
      const nodes = fs.readFileSync(file, "utf8").split("\n", 40);
      let cwd = "";
      for (const l of nodes) {
        try {
          const o = JSON.parse(l) as RawRecord;
          if (o.cwd) {
            cwd = o.cwd;
            break;
          }
        } catch {
          /* keep scanning */
        }
      }
      return { file, cwd, dirName };
    }
  }
  return null;
}

export function loadSession(sessionId: SessionId): SessionDetail | null {
  const loc = locate(sessionId);
  if (!loc) return null;

  const parsed = parseFile(loc.file);
  const { nodes, title } = parsed;
  const meta = readMeta(sessionId);
  for (const n of nodes) {
    const m = meta[n.id] ?? n.absorbedIds?.map((id) => meta[id]).find(Boolean);
    if (m) Object.assign(n, m);
  }

  const children = childIndex(nodes);
  const stat = fs.statSync(loc.file);

  return {
    meta: {
      id: sessionId,
      cwd: loc.cwd,
      project: loc.cwd ? path.basename(loc.cwd) : decodeProjectName(loc.dirName),
      title: title || "Untitled",
      updatedAt: lastInteraction(parsed, stat.mtimeMs),
      nodeCount: nodes.length,
      branchPoints: countBranchPoints(children),
    },
    nodes,
  };
}

/**
 * Lightweight listing for the welcome screen. Parses each transcript, so it is
 * O(all sessions) — fine at a few hundred files, worth an index beyond that.
 */
/**
 * Summary cache, keyed by file identity (mtime + size).
 *
 * The welcome screen scans every transcript, and there are hundreds of them
 * totalling hundreds of MB — one full scan is ~700ms and a few hundred MB of
 * garbage. With a live watcher that scan reruns whenever *any* session changes,
 * so re-parsing the ~284 files that didn't change is nearly all of the cost.
 *
 * Only the SessionMeta is cached, never the node array: keeping every session's
 * turns resident would trade a CPU problem for a much worse memory one.
 */
const summaries = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>();

function summarise(file: string, dirName: string): SessionMeta | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }

  const hit = summaries.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.meta;

  const parsed = parseFile(file);
  const { nodes, title } = parsed;
  if (nodes.length === 0) {
    summaries.delete(file);
    return null;
  }

  const cwd = readCwd(file);
  const meta: SessionMeta = {
    id: path.basename(file).slice(0, -6),
    cwd,
    project: cwd ? path.basename(cwd) : decodeProjectName(dirName),
    title: title || "Untitled",
    updatedAt: lastInteraction(parsed, stat.mtimeMs),
    nodeCount: nodes.length,
    branchPoints: countBranchPoints(childIndex(nodes)),
  };
  summaries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

export function listSessions(opts: { limit?: number } = {}): SessionMeta[] {
  if (!fs.existsSync(PROJECTS)) return [];
  const out: SessionMeta[] = [];
  const seen = new Set<string>();

  for (const dirName of fs.readdirSync(PROJECTS)) {
    const dir = path.join(PROJECTS, dirName);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const file = path.join(dir, f);
      seen.add(file);
      const meta = summarise(file, dirName);
      if (!meta) continue;
      out.push(meta);
    }
  }

  // Forget deleted transcripts, so the cache can't outgrow the directory.
  for (const key of summaries.keys()) if (!seen.has(key)) summaries.delete(key);

  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

function readCwd(file: string): string {
  try {
    for (const l of fs.readFileSync(file, "utf8").split("\n", 40)) {
      if (!l.trim()) continue;
      const o = JSON.parse(l) as RawRecord;
      if (o.cwd) return o.cwd;
    }
  } catch {
    /* fall through */
  }
  return "";
}
