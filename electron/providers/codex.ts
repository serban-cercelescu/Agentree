import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { childIndex, countBranchPoints } from "../../shared/render.ts";
import type {
  ForkResult,
  SessionDetail,
  SessionId,
  SessionMeta,
  TurnNode,
  UsageSnapshot,
} from "../../shared/types.ts";
import { mergeSameRoleRuns } from "../transcripts.ts";
import { readMeta } from "../meta.ts";
import { stitchFamily, type FamilyMember } from "./stitch.ts";

export const SESSIONS = path.join(os.homedir(), ".codex", "sessions");

/**
 * Codex rollout: `rollout-<stamp>-<uuid>.jsonl` under Y/M/D directories.
 *
 * The DISPLAY stream is the `event_msg` records — `user_message` and
 * `agent_message` carry clean prose. The `response_item` records duplicate the
 * conversation as raw API items, including the harness plumbing Codex injects
 * as `role: "developer"` / `role: "user"` messages (`<permissions
 * instructions>`, `<environment_context>`, `<user_instructions>`, AGENTS.md
 * dumps). Parsing event_msgs sidesteps all of it; response_items are read only
 * for tool-call names and reasoning summaries.
 */
interface RawRecord {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    // session_meta
    id?: string;
    cwd?: string;
    forked_from_id?: string;
    thread_source?: unknown;
    // event_msg
    message?: string;
    info?: {
      last_token_usage?: Record<string, number>;
    };
    // response_item
    name?: string;
    summary?: { type?: string; text?: string }[];
  };
}

interface Header {
  id: string;
  cwd: string;
  forkedFrom: string | null;
  /** Subagent threads are Codex's sidechains; they get no listing of their own. */
  subagent: boolean;
}

function readHeader(file: string): Header | null {
  // The session_meta line embeds the FULL base instructions prompt, so "the
  // first line" is routinely 30–100 KB. Read in growing chunks until a newline
  // appears rather than assuming any fixed prefix holds it.
  let firstLine: string | null = null;
  try {
    const fd = fs.openSync(file, "r");
    try {
      // Accumulate raw bytes and decode once: a per-chunk decode could tear a
      // multibyte character at a chunk boundary and corrupt the JSON.
      const parts: Buffer[] = [];
      let pos = 0;
      let total = 0;
      while (total < 4 * 1024 * 1024) {
        const chunk = Buffer.alloc(65536);
        const n = fs.readSync(fd, chunk, 0, chunk.length, pos);
        if (n === 0) break;
        pos += n;
        total += n;
        parts.push(chunk.subarray(0, n));
        if (chunk.subarray(0, n).includes(0x0a)) break;
      }
      const acc = Buffer.concat(parts).toString("utf8");
      const nl = acc.indexOf("\n");
      firstLine = nl >= 0 ? acc.slice(0, nl) : acc;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  try {
    return readHeaderFromLine(firstLine);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ index

/** sessionId -> file, with headers, rebuilt cheaply (header cache by mtime). */
const headers = new Map<string, { mtimeMs: number; header: Header | null }>();

function scanFiles(): { file: string; header: Header }[] {
  if (!fs.existsSync(SESSIONS)) return [];
  const out: { file: string; header: Header }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl")) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(p).mtimeMs;
        } catch {
          continue;
        }
        const hit = headers.get(p);
        const header =
          hit && hit.mtimeMs === mtimeMs ? hit.header : readHeader(p);
        if (!hit || hit.mtimeMs !== mtimeMs) headers.set(p, { mtimeMs, header });
        if (header) out.push({ file: p, header });
      }
    }
  };
  walk(SESSIONS, 0);
  return out;
}

export function locateCodex(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  for (const { file, header } of scanFiles()) {
    if (header.id === sessionId) return file;
  }
  return null;
}

// ------------------------------------------------------------------ parsing

interface ParsedRollout {
  header: Header;
  /** Linear turns; node ids are `<sessionId>#<n>`, stable under append. */
  nodes: TurnNode[];
  /** For each turn, the index of the LAST raw line belonging to it. */
  endLine: number[];
  touchedAt: number;
}

/** Codex plumbing occasionally embedded in user_message events. */
const CODEX_WRAP =
  /<(user_instructions|environment_context|permissions instructions|turn-aborted)>[\s\S]*?<\/\1>/g;

function parseRollout(file: string): ParsedRollout | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const first = lines[0];
  let header: Header | null = null;
  try {
    header = readHeaderFromLine(first);
  } catch {
    /* fall through */
  }
  if (!header) return null;

  const sid = header.id;
  const nodes: TurnNode[] = [];
  const endLine: number[] = [];
  let touchedAt = 0;
  let pendingTools: string[] = [];
  let pendingThinking = "";

  const push = (role: TurnNode["role"], text: string, ts: number, i: number) => {
    const n = nodes.length;
    nodes.push({
      id: `${sid}#${n}`,
      parentId: n > 0 ? `${sid}#${n - 1}` : null,
      role,
      text,
      timestamp: ts,
      thinking: role === "assistant" && pendingThinking ? pendingThinking : undefined,
      toolUses: role === "assistant" && pendingTools.length ? pendingTools : undefined,
    });
    endLine.push(i);
    if (role === "assistant") {
      pendingTools = [];
      pendingThinking = "";
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let rec: RawRecord;
    try {
      rec = JSON.parse(line) as RawRecord;
    } catch {
      continue; // torn tail of a live session
    }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : 0;
    if (ts > touchedAt) touchedAt = ts;
    const p = rec.payload;
    if (!p) continue;

    if (rec.type === "event_msg") {
      if (p.type === "user_message" && typeof p.message === "string") {
        const text = p.message.replace(CODEX_WRAP, "").trim();
        if (text) push("user", text, ts, i);
      } else if (p.type === "agent_message" && typeof p.message === "string") {
        if (p.message.trim()) push("assistant", p.message.trim(), ts, i);
      } else if (p.type === "token_count") {
        const u = p.info?.last_token_usage;
        const last = nodes[nodes.length - 1];
        if (u && last && last.role === "assistant") {
          const cached = u.cached_input_tokens ?? 0;
          const usage: UsageSnapshot = {
            // Codex's input_tokens INCLUDES the cached part; Agentree's
            // (Anthropic-shaped) input_tokens is the uncached remainder.
            input_tokens: Math.max(0, (u.input_tokens ?? 0) - cached),
            output_tokens: u.output_tokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: cached,
          };
          last.usage = usage;
          last.lastUsage = usage;
          endLine[endLine.length - 1] = i;
        }
      } else if (nodes.length) {
        // task_complete and friends extend the turn they close.
        if (p.type === "task_complete") endLine[endLine.length - 1] = i;
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

  return { header, nodes, endLine, touchedAt };
}

function readHeaderFromLine(line: string): Header | null {
  const rec = JSON.parse(line) as RawRecord;
  if (rec.type !== "session_meta" || !rec.payload?.id) return null;
  const src = rec.payload.thread_source;
  return {
    id: rec.payload.id,
    cwd: rec.payload.cwd ?? "",
    forkedFrom: rec.payload.forked_from_id ?? null,
    subagent: src === "subagent" || (typeof src === "object" && src !== null),
  };
}

/** Full-parse cache, keyed by file identity — same shape as the Claude one. */
const parses = new Map<string, { mtimeMs: number; size: number; parsed: ParsedRollout }>();

function parsed(file: string): ParsedRollout | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const hit = parses.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;
  const p = parseRollout(file);
  if (p) parses.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, parsed: p });
  else parses.delete(file);
  return p;
}

// ------------------------------------------------------------------ families

interface Family {
  rootId: string;
  /** All member session ids, root included. */
  members: { file: string; header: Header }[];
}

/**
 * Group rollouts by fork lineage. `forked_from_id` points at the parent; the
 * family root is the transitive top. A fork whose ancestor was deleted becomes
 * its own root — its transcript is self-contained (copied prefix), so nothing
 * is lost.
 */
function families(): Map<string, Family> {
  const all = scanFiles().filter((f) => !f.header.subagent);
  const byId = new Map(all.map((f) => [f.header.id, f]));

  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      const f = byId.get(cur);
      if (!f || !f.header.forkedFrom || !byId.has(f.header.forkedFrom) || seen.has(cur)) return cur;
      seen.add(cur);
      cur = f.header.forkedFrom;
    }
  };

  const out = new Map<string, Family>();
  for (const f of all) {
    const root = rootOf(f.header.id);
    const fam = out.get(root) ?? { rootId: root, members: [] };
    fam.members.push(f);
    out.set(root, fam);
  }
  return out;
}

function stitched(fam: Family): TurnNode[] {
  const members: FamilyMember[] = [];
  for (const m of fam.members) {
    const p = parsed(m.file);
    if (!p) continue;
    members.push({
      sessionId: m.header.id,
      parentSessionId: m.header.id === fam.rootId ? null : m.header.forkedFrom,
      nodes: p.nodes,
    });
  }
  return mergeSameRoleRuns(stitchFamily(members));
}

const resumeCmd = (id: string, cwd: string) => {
  const resume = `codex resume ${id}`;
  return cwd ? `cd ${JSON.stringify(cwd)} && ${resume}` : resume;
};

// ------------------------------------------------------------------ API

export function listCodexSessions(): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const fam of families().values()) {
    const rootFile = fam.members.find((m) => m.header.id === fam.rootId);
    if (!rootFile) continue;
    const rootParsed = parsed(rootFile.file);
    if (!rootParsed || rootParsed.nodes.length === 0) continue;

    // Always via stitched(): it copies nodes before the merge mutates them,
    // protecting the parse cache. (A single-member family stitches to itself.)
    const nodes = stitched(fam);
    let updatedAt = 0;
    for (const m of fam.members) {
      const p = parsed(m.file);
      if (p && p.touchedAt > updatedAt) updatedAt = p.touchedAt;
    }

    const firstUser = rootParsed.nodes.find((n) => n.role === "user");
    out.push({
      id: fam.rootId,
      provider: "codex",
      cwd: rootParsed.header.cwd,
      project: rootParsed.header.cwd ? path.basename(rootParsed.header.cwd) : "codex",
      title: (firstUser?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "Untitled",
      updatedAt,
      nodeCount: nodes.length,
      branchPoints: countBranchPoints(childIndex(nodes)),
      resumeCommand: resumeCmd(fam.rootId, rootParsed.header.cwd),
    });
  }
  return out;
}

export function loadCodexSession(sessionId: SessionId): SessionDetail | null {
  const fams = families();
  // Loading a child fork opens its whole family, rooted where the tree roots.
  const fam =
    fams.get(sessionId) ??
    [...fams.values()].find((f) => f.members.some((m) => m.header.id === sessionId));
  if (!fam) return null;
  const rootFile = fam.members.find((m) => m.header.id === fam.rootId);
  const rootParsed = rootFile ? parsed(rootFile.file) : null;
  if (!rootParsed) return null;

  const nodes = stitched(fam);
  // Sidecar annotations live under each contributing session's id; a node id
  // is `<sid>#<n>`, so read every member's meta.
  for (const m of fam.members) {
    const meta = readMeta(m.header.id);
    for (const n of nodes) {
      const mm = meta[n.id] ?? n.absorbedIds?.map((id) => meta[id]).find(Boolean);
      if (mm) Object.assign(n, mm);
    }
  }

  let updatedAt = 0;
  for (const m of fam.members) {
    const p = parsed(m.file);
    if (p && p.touchedAt > updatedAt) updatedAt = p.touchedAt;
  }
  const firstUser = rootParsed.nodes.find((n) => n.role === "user");

  return {
    meta: {
      id: fam.rootId,
      provider: "codex",
      cwd: rootParsed.header.cwd,
      project: rootParsed.header.cwd ? path.basename(rootParsed.header.cwd) : "codex",
      title: (firstUser?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90) || "Untitled",
      updatedAt,
      nodeCount: nodes.length,
      branchPoints: countBranchPoints(childIndex(nodes)),
      resumeCommand: resumeCmd(fam.rootId, rootParsed.header.cwd),
    },
    nodes,
  };
}

// ------------------------------------------------------------------ fork

/** RFC 9562 UUIDv7 — Codex session ids are v7, so forks sort correctly by id. */
function uuidv7(): string {
  const b = crypto.randomBytes(16);
  const t = Date.now();
  b[0] = (t / 2 ** 40) & 0xff;
  b[1] = (t / 2 ** 32) & 0xff;
  b[2] = (t / 2 ** 24) & 0xff;
  b[3] = (t / 2 ** 16) & 0xff;
  b[4] = (t / 2 ** 8) & 0xff;
  b[5] = t & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Fork a Codex session after a chosen turn.
 *
 * Codex has no `--resume-session-at`; its own `codex fork` command forks only
 * at the tip. But its fork FORMAT is exactly reproducible: a new rollout whose
 * lines are a copy of the parent's up to the cut, with a fresh `session_meta`
 * carrying `forked_from_id`. Writing that file is non-destructive (the parent
 * transcript is never touched) and native tooling understands the result —
 * `codex resume <new-id>` picks it up, and the lineage marker is the same one
 * `codex fork` writes.
 *
 * The node id encodes the owning session and turn index (`<sid>#<n>`): in a
 * stitched tree, forking from a turn inside a fork's suffix must cut THAT
 * fork's rollout, not the root's.
 */
export function forkCodexAt(nodeId: string): ForkResult {
  const m = /^(.+)#(\d+)$/.exec(nodeId);
  if (!m) return { ok: false, error: "That turn does not map to a Codex transcript record." };
  const [, sid, idxStr] = m;
  const file = locateCodex(sid);
  if (!file) return { ok: false, error: "That session's rollout is no longer on disk." };
  const p = parsed(file);
  const idx = Number(idxStr);
  if (!p || idx >= p.nodes.length) {
    return { ok: false, error: "That turn is not in this transcript." };
  }

  const cut = p.endLine[idx];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const head = JSON.parse(lines[0]) as RawRecord & { payload: Record<string, unknown> };

  const newId = uuidv7();
  const now = new Date();
  const iso = now.toISOString();
  head.timestamp = iso;
  head.payload.id = newId;
  if ("session_id" in head.payload) head.payload.session_id = newId;
  head.payload.timestamp = iso;
  head.payload.forked_from_id = sid;

  // Codex names rollouts in LOCAL time (both the Y/M/D directory and the
  // filename stamp). Deriving the stamp from the UTC iso put forks an hour off
  // their real creation time — and near midnight, in the wrong day's folder.
  const two = (n: number) => String(n).padStart(2, "0");
  const day = [String(now.getFullYear()), two(now.getMonth() + 1), two(now.getDate())];
  const stamp = `${day.join("-")}T${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`;
  const dir = path.join(SESSIONS, ...day);
  const out = path.join(dir, `rollout-${stamp}-${newId}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const body = [JSON.stringify(head), ...lines.slice(1, cut + 1)].join("\n") + "\n";
    fs.writeFileSync(out, body, { flag: "wx" }); // never clobber
  } catch (e) {
    return { ok: false, error: `Could not write the forked rollout: ${String(e)}` };
  }

  const cwd = p.header.cwd;
  return {
    ok: true,
    id: newId,
    cwd,
    command: cwd ? `cd ${JSON.stringify(cwd)} && codex resume ${newId}` : `codex resume ${newId}`,
    note: "Codex has no resume-at flag, so the fork is a new session (prefix copied, forked_from_id set). Agentree draws the family as one tree.",
  };
}
