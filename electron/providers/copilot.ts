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
} from "../../shared/types.ts";
import { mergeSameRoleRuns } from "../transcripts.ts";
import { readMeta } from "../meta.ts";
import { readLineage, recordLineage } from "../lineage.ts";
import { stitchFamily, type FamilyMember } from "./stitch.ts";

export const STATE = path.join(os.homedir(), ".copilot", "session-state");

/**
 * Copilot CLI session: a directory `~/.copilot/session-state/<uuid>/` holding
 * `events.jsonl` (the authoritative transcript — resume replays it),
 * `workspace.yaml` (id, cwd, name), `session.db` (todos), `checkpoints/`.
 *
 * events.jsonl is an id/parentId event chain — structurally the same DAG as a
 * Claude transcript, just linear in practice. `user.message` / `assistant.message`
 * events carry clean prose in `data.content`; `data.transformedContent` is the
 * same text wrapped in harness plumbing (`<current_datetime>` etc.) and is
 * deliberately ignored.
 *
 * There is also a central `~/.copilot/session-store.db` (SQLite) mirroring the
 * turns for search. It is copilot's derived state, not the source of truth —
 * Agentree never touches it; the CLI rebuilds its own rows on resume.
 */
interface RawEvent {
  type?: string;
  id?: string;
  parentId?: string;
  timestamp?: string;
  data?: {
    sessionId?: string;
    content?: string;
    toolRequests?: { name?: string }[];
  };
}

interface Workspace {
  id: string;
  cwd: string;
  name: string;
  forkedFrom: string | null;
}

function readWorkspace(dir: string): Workspace | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "workspace.yaml"), "utf8");
  } catch {
    return null;
  }
  // The file is flat key: value YAML; a real YAML parser would be a dependency
  // for four fields.
  const get = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(raw);
    if (!m) return "";
    let v = m[1].trim();
    if (
      (v.startsWith("'") && v.endsWith("'")) ||
      (v.startsWith('"') && v.endsWith('"'))
    ) {
      v = v.slice(1, -1).replace(/''/g, "'");
    }
    return v;
  };
  const id = get("id");
  if (!id) return null;
  return {
    id,
    cwd: get("cwd"),
    name: get("name"),
    forkedFrom: get("forked_from") || null,
  };
}

interface ParsedSession {
  ws: Workspace;
  nodes: TurnNode[];
  /** For each turn, the index of the LAST event line belonging to it. */
  endLine: number[];
  touchedAt: number;
}

function parseEvents(dir: string): ParsedSession | null {
  const ws = readWorkspace(dir);
  if (!ws) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8");
  } catch {
    return null; // pre-events.jsonl copilot version; nothing to draw
  }

  const nodes: TurnNode[] = [];
  const endLine: number[] = [];
  let touchedAt = 0;
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let ev: RawEvent;
    try {
      ev = JSON.parse(lines[i]) as RawEvent;
    } catch {
      continue;
    }
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : 0;
    if (ts > touchedAt) touchedAt = ts;

    if (ev.type === "user.message" || ev.type === "assistant.message") {
      const text = (ev.data?.content ?? "").trim();
      const tools = (ev.data?.toolRequests ?? [])
        .map((t) => t.name ?? "")
        .filter(Boolean);
      if (!text && tools.length === 0) continue;
      const n = nodes.length;
      nodes.push({
        // Real event uuids — stable, and unique across the whole family.
        id: ev.id ?? `${ws.id}#${n}`,
        parentId: n > 0 ? nodes[n - 1].id : null,
        role: ev.type === "user.message" ? "user" : "assistant",
        text,
        toolUses: tools.length ? tools : undefined,
        timestamp: ts,
      });
      endLine.push(i);
    } else if (nodes.length && (ev.type === "assistant.turn_end" || ev.type === "session.usage_checkpoint")) {
      // Closing events extend the turn they close, so a fork cut after the
      // turn keeps them.
      endLine[endLine.length - 1] = i;
    }
  }

  return { ws, nodes, endLine, touchedAt };
}

const parses = new Map<string, { mtimeMs: number; size: number; parsed: ParsedSession }>();

function parsed(dir: string): ParsedSession | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(path.join(dir, "events.jsonl"));
  } catch {
    return null;
  }
  const hit = parses.get(dir);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.parsed;
  const p = parseEvents(dir);
  if (p) parses.set(dir, { mtimeMs: stat.mtimeMs, size: stat.size, parsed: p });
  else parses.delete(dir);
  return p;
}

function sessionDirs(): string[] {
  if (!fs.existsSync(STATE)) return [];
  return fs
    .readdirSync(STATE)
    .map((d) => path.join(STATE, d))
    .filter((d) => {
      try {
        return fs.statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
}

export function locateCopilot(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  const dir = path.join(STATE, sessionId);
  return fs.existsSync(path.join(dir, "workspace.yaml")) ? dir : null;
}

// ------------------------------------------------------------------ families

interface Family {
  rootId: string;
  members: { dir: string; ws: Workspace }[];
}

function families(): Map<string, Family> {
  // Parentage source of truth is Agentree's lineage sidecar: Copilot
  // regenerates workspace.yaml on resume and drops the `forked_from` key we
  // put there (it survives only until the fork is first resumed).
  const lineage = readLineage();
  const all: { dir: string; ws: Workspace }[] = [];
  for (const dir of sessionDirs()) {
    const ws = readWorkspace(dir);
    if (!ws) continue;
    if (!ws.forkedFrom && lineage[ws.id]) ws.forkedFrom = lineage[ws.id];
    all.push({ dir, ws });
  }
  const byId = new Map(all.map((a) => [a.ws.id, a]));

  const rootOf = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      const f = byId.get(cur);
      if (!f || !f.ws.forkedFrom || !byId.has(f.ws.forkedFrom) || seen.has(cur)) return cur;
      seen.add(cur);
      cur = f.ws.forkedFrom;
    }
  };

  const out = new Map<string, Family>();
  for (const a of all) {
    const root = rootOf(a.ws.id);
    const fam = out.get(root) ?? { rootId: root, members: [] };
    fam.members.push(a);
    out.set(root, fam);
  }
  return out;
}

function stitched(fam: Family): TurnNode[] {
  const members: FamilyMember[] = [];
  for (const m of fam.members) {
    const p = parsed(m.dir);
    if (!p) continue;
    members.push({
      sessionId: m.ws.id,
      parentSessionId: m.ws.id === fam.rootId ? null : m.ws.forkedFrom,
      nodes: p.nodes,
    });
  }
  return mergeSameRoleRuns(stitchFamily(members));
}

const resumeCmd = (id: string, cwd: string) => {
  const resume = `copilot --resume=${id}`;
  return cwd ? `cd ${JSON.stringify(cwd)} && ${resume}` : resume;
};

function metaFor(fam: Family): SessionMeta | null {
  const rootMember = fam.members.find((m) => m.ws.id === fam.rootId);
  if (!rootMember) return null;
  const rootParsed = parsed(rootMember.dir);
  if (!rootParsed || rootParsed.nodes.length === 0) return null;

  const nodes = fam.members.length > 1 ? stitched(fam) : mergeSameRoleRuns(rootParsed.nodes);
  let updatedAt = 0;
  for (const m of fam.members) {
    const p = parsed(m.dir);
    if (p && p.touchedAt > updatedAt) updatedAt = p.touchedAt;
  }

  const firstUser = rootParsed.nodes.find((n) => n.role === "user");
  const title =
    rootMember.ws.name ||
    (firstUser?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 90) ||
    "Untitled";

  return {
    id: fam.rootId,
    provider: "copilot",
    cwd: rootMember.ws.cwd,
    project: rootMember.ws.cwd ? path.basename(rootMember.ws.cwd) : "copilot",
    title,
    updatedAt,
    nodeCount: nodes.length,
    branchPoints: countBranchPoints(childIndex(nodes)),
    resumeCommand: resumeCmd(fam.rootId, rootMember.ws.cwd),
  };
}

// ------------------------------------------------------------------ API

export function listCopilotSessions(): SessionMeta[] {
  const out: SessionMeta[] = [];
  for (const fam of families().values()) {
    const meta = metaFor(fam);
    if (meta) out.push(meta);
  }
  return out;
}

export function loadCopilotSession(sessionId: SessionId): SessionDetail | null {
  const fams = families();
  const fam =
    fams.get(sessionId) ??
    [...fams.values()].find((f) => f.members.some((m) => m.ws.id === sessionId));
  if (!fam) return null;
  const meta = metaFor(fam);
  if (!meta) return null;

  const nodes = stitched(fam);
  for (const m of fam.members) {
    const annotations = readMeta(m.ws.id);
    for (const n of nodes) {
      const a = annotations[n.id] ?? n.absorbedIds?.map((id) => annotations[id]).find(Boolean);
      if (a) Object.assign(n, a);
    }
  }
  return { meta, nodes };
}

// ------------------------------------------------------------------ fork

/**
 * Fork a Copilot session after a chosen turn: copy the session directory under
 * a fresh uuid, truncate `events.jsonl` at the cut, and rewrite the identity
 * the copy carries.
 *
 * Verified empirically before this was written:
 *  - `copilot --resume=<new-id>` resolves purely from the session-state dir;
 *    no row in the central SQLite is needed.
 *  - The truncated copy resumes with exactly the prefix as context (a probe
 *    fork answered from the kept turn, not the dropped one).
 *  - The sessionId inside the copied `session.start` event MUST be rewritten:
 *    left stale, the resumed CLI logs new turns under the PARENT's id in the
 *    central store, cross-contaminating the original session's mirror.
 *
 * The fork's parentage is recorded as a `forked_from` key in the copy's own
 * workspace.yaml — the same place Codex keeps `forked_from_id`. The parent
 * session is never written to.
 */
export function forkCopilotAt(sessionId: SessionId, nodeId: string): ForkResult {
  // A node in a stitched tree belongs to the session whose events file holds
  // its event id; search the family for the owner.
  const fams = families();
  const fam =
    fams.get(sessionId) ??
    [...fams.values()].find((f) => f.members.some((m) => m.ws.id === sessionId));
  if (!fam) return { ok: false, error: "That session is no longer on disk." };

  let owner: { dir: string; ws: Workspace } | null = null;
  let idx = -1;
  for (const m of fam.members) {
    const p = parsed(m.dir);
    if (!p) continue;
    const i = p.nodes.findIndex((n) => n.id === nodeId);
    if (i >= 0) {
      owner = m;
      idx = i;
      break;
    }
  }
  if (!owner) return { ok: false, error: "That turn is not in this session's transcript." };

  const p = parsed(owner.dir)!;
  const cut = p.endLine[idx];
  const newId = crypto.randomUUID();
  const dst = path.join(STATE, newId);

  try {
    fs.mkdirSync(dst);
    for (const entry of fs.readdirSync(owner.dir)) {
      // The events file is rebuilt below; editor metadata names the old id.
      if (entry === "events.jsonl" || entry === "vscode.metadata.json") continue;
      fs.cpSync(path.join(owner.dir, entry), path.join(dst, entry), { recursive: true });
    }

    const lines = fs.readFileSync(path.join(owner.dir, "events.jsonl"), "utf8").split("\n");
    const kept = lines.slice(0, cut + 1).map((line) => {
      if (!line.trim()) return line;
      try {
        const ev = JSON.parse(line) as RawEvent;
        if (ev.data?.sessionId === owner!.ws.id) {
          ev.data.sessionId = newId;
          return JSON.stringify(ev);
        }
      } catch {
        /* keep the line as-is */
      }
      return line;
    });
    fs.writeFileSync(path.join(dst, "events.jsonl"), kept.join("\n") + "\n", { flag: "wx" });

    // Rewrite the copy's identity. Parentage goes in the lineage sidecar —
    // Copilot rewrites workspace.yaml on resume, so a key there wouldn't last.
    const wsPath = path.join(dst, "workspace.yaml");
    let ws = fs.readFileSync(wsPath, "utf8");
    ws = ws.replace(/^id: .*$/m, `id: ${newId}`);
    fs.writeFileSync(wsPath, ws);
    recordLineage(newId, owner.ws.id);
  } catch (e) {
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      /* leave partial dir for inspection */
    }
    return { ok: false, error: `Could not write the forked session: ${String(e)}` };
  }

  const cwd = owner.ws.cwd;
  return {
    ok: true,
    id: newId,
    cwd,
    command: resumeCmd(newId, cwd),
    note: "Copilot has no resume-at flag, so the fork is a copy-truncated session. Agentree draws the family as one tree.",
  };
}
