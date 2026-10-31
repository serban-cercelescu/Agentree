import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scheme2Fingerprint } from "./identity.ts";
import { agentreeHome } from "./paths.ts";
import type { NodeId, NodeMeta, SessionId, TurnNode } from "../shared/types.ts";

/**
 * Agentree's sidecar metadata: labels, dead-end marks, notes.
 *
 * Kept strictly separate from Claude Code's transcripts. Those files are the
 * user's real work and are owned by the CLI — writing our annotations into
 * them would risk corrupting a session the CLI is mid-append on, and would
 * make our UI state indistinguishable from real conversation content.
 */
const DIR = () => path.join(agentreeHome(), "meta");

// The app used to be called AgentView and kept its sidecar in ~/.agentview.
// Carry existing annotations across once; a failed rename (permissions, race)
// just leaves the old dir in place for a later attempt.
const OLD_ROOT = path.join(os.homedir(), ".agentview");
try {
  if (!process.env.AGENTREE_HOME && fs.existsSync(OLD_ROOT) && !fs.existsSync(agentreeHome())) {
    fs.renameSync(OLD_ROOT, agentreeHome());
  }
} catch {
  /* keep reading/writing the new location; old annotations stay recoverable */
}

function fileFor(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  return path.join(DIR(), `${sessionId}.json`);
}

export function readMeta(sessionId: SessionId): Record<NodeId, NodeMeta> {
  const file = fileFor(sessionId);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<NodeId, NodeMeta>;
  } catch {
    return {};
  }
}

/** Merge a patch into an entry; a cleared field (undefined, null, "") is removed. */
function merged(prev: NodeMeta | undefined, patch: NodeMeta): NodeMeta | undefined {
  const next: NodeMeta = { ...prev, ...patch };
  for (const k of Object.keys(next) as (keyof NodeMeta)[]) {
    if (next[k] === undefined || next[k] === null || next[k] === "") delete next[k];
  }
  return Object.keys(next).length ? next : undefined;
}

/**
 * Apply several entry patches to ONE sidecar in one atomic replacement —
 * never a rewrite per entry. Atomic per file only: two Agentree processes
 * (the desktop app and the extension) writing the same sidecar at the same
 * moment can still lose one side's change. Last writer wins.
 */
function updateFile(sessionId: SessionId, patches: Map<string, NodeMeta>): void {
  const file = fileFor(sessionId);
  if (!file || patches.size === 0) return;
  const all = readMeta(sessionId);
  for (const [key, patch] of patches) {
    const next = merged(all[key], patch);
    if (next) all[key] = next;
    else delete all[key];
  }
  fs.mkdirSync(DIR(), { recursive: true });
  // Write-then-rename so a crash can't leave a half-written JSON file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), "utf8");
  fs.renameSync(tmp, file);
}

export function writeMeta(sessionId: SessionId, key: string, patch: NodeMeta): void {
  updateFile(sessionId, new Map([[key, patch]]));
}

/**
 * The keys a node's annotation is stored under: its semantic identities
 * (identity.ts, scheme 4), the same in every session holding a copy, so they
 * outlive any one file. Codex node ids already are such identities.
 */
const stableKeys = (n: TurnNode): string[] => (n.stableIds?.length ? n.stableIds : [n.id]);
/** Scheme 1 keys: raw per-file ids. */
const rawKeys = (n: TurnNode): NodeId[] => [
  n.id,
  ...(n.absorbedIds ?? []),
  ...(n.occurrences ?? []).map((o) => o.id),
];
/** Every key a node answers to, in any scheme. */
const allKeys = (n: TurnNode) => new Set([...stableKeys(n), ...(n.legacyIds ?? []), ...rawKeys(n)]);

/**
 * Which older-scheme keys a family can use: those exactly ONE of its nodes
 * answers to. An older key two nodes answer to — two prompts scheme 2 keyed
 * alike because they differ only in whitespace — belongs to neither: it is
 * neither shown, nor carried forward, nor patched by a write to one of them.
 */
type Owned = (key: string) => boolean;
function ownership(nodes: TurnNode[]): Owned {
  const claims = new Map<string, number>();
  for (const n of nodes) for (const k of allKeys(n)) claims.set(k, (claims.get(k) ?? 0) + 1);
  return (k) => claims.get(k) === 1;
}

/** One member's sidecar, its scheme-2 weak keys (`key@parent…`) indexed by fingerprint. */
interface Sidecar {
  sid: SessionId;
  entries: Record<string, NodeMeta>;
  scheme2: Map<string, string[]>;
}

function sidecar(sid: SessionId): Sidecar {
  const entries = readMeta(sid);
  const scheme2 = new Map<string, string[]>();
  for (const k of Object.keys(entries)) {
    if (!k.includes("@")) continue;
    const fp = scheme2Fingerprint(k);
    scheme2.set(fp, [...(scheme2.get(fp) ?? []), k]);
  }
  return { sid, entries, scheme2 };
}

/**
 * Keys an EARLIER scheme stored this node under, as present in `sc` and
 * owned by it alone: schemes 2–3 (`legacyIds`; a scheme-2 weak key is a
 * saved literal chain, found by its fingerprint), then scheme 1 (raw ids).
 * Current keys are never among them: no earlier scheme saved a key of the
 * current form with another meaning (identity.ts).
 */
function olderKeys(sc: Sidecar, n: TurnNode, owned: Owned): string[] {
  const out: string[] = [];
  const legacy = n.legacyIds ?? [];
  for (const fp of [...stableKeys(n), ...legacy]) if (owned(fp)) out.push(...(sc.scheme2.get(fp) ?? []));
  for (const k of [...legacy, ...rawKeys(n)]) if (sc.entries[k] && owned(k)) out.push(k);
  return out;
}

const firstEntry = (sc: Sidecar, keys: string[]): NodeMeta | undefined =>
  keys.map((k) => sc.entries[k]).find(Boolean);

/**
 * Overlay a family's annotations onto its nodes, and make every member's
 * sidecar hold what is shown.
 *
 * A family's identity isn't stable: it gains members when a fork is found,
 * its root changes when the original is deleted, and one turn has a
 * different uuid in each file holding it. So every member's sidecar is read,
 * and a node matches on its semantic identity (`stableIds`) first, in member
 * order.
 *
 * Without one, entries saved under an earlier identity scheme are looked for
 * (`olderKeys`): schemes 2–3, then scheme 1's raw uuids (usually in the
 * root's file only), each only where the node alone owns it. Those are never
 * rewritten or deleted here; the hit is carried forward under the current
 * keys.
 *
 * Carried forward to WHICH sidecars: every member's that holds no entry for
 * the node under its current keys — a member found after the annotation was
 * written (a new fork), or all of them for an older-scheme hit. So the
 * annotation survives the member it was written in being deleted later. A
 * member's existing entry is never overwritten (no conflict is resolved
 * here), and once the family's sidecars agree a load writes nothing. A
 * cleared annotation is an absent entry, and absence is never copied, so a
 * clear can't be undone by this; nor can it reach a sidecar that isn't a
 * member's when the clear is made (there are no tombstones).
 */
export function applyAnnotations(nodes: TurnNode[], memberIds: SessionId[]): void {
  const cars = [...new Set(memberIds)].map(sidecar);
  const owned = ownership(nodes);

  const fill = new Map<SessionId, Map<string, NodeMeta>>();
  for (const n of nodes) {
    const keys = stableKeys(n);
    const current = cars.map((sc) => firstEntry(sc, keys));
    let hit = current.find(Boolean);
    for (const sc of cars) {
      if (hit) break;
      hit = firstEntry(sc, olderKeys(sc, n, owned));
    }
    if (!hit) continue;
    Object.assign(n, hit);
    cars.forEach((sc, i) => {
      if (current[i]) return;
      const patches = fill.get(sc.sid) ?? new Map<string, NodeMeta>();
      for (const k of keys) patches.set(k, hit!);
      fill.set(sc.sid, patches);
    });
  }
  for (const [sid, patches] of fill) {
    try {
      updateFile(sid, patches);
    } catch {
      /* read-only home: what was found still shows; retried next load */
    }
  }
}

/**
 * Write an annotation on `node` of the family `nodes` so it survives what
 * `applyAnnotations` has to cope with: into EVERY member's sidecar, under the
 * node's stable ids — one atomic write per sidecar. An older-scheme entry the
 * node alone owns gets the same patch, so clearing a label can't let it
 * resurface; one it shares with another node is left as it was.
 */
export function writeAnnotation(node: TurnNode, nodes: TurnNode[], memberIds: SessionId[], patch: NodeMeta): void {
  const owned = ownership(nodes);
  for (const sid of new Set(memberIds)) {
    const sc = sidecar(sid);
    const patches = new Map<string, NodeMeta>(stableKeys(node).map((k) => [k, patch]));
    for (const k of olderKeys(sc, node, owned)) patches.set(k, patch);
    updateFile(sid, patches);
  }
}
