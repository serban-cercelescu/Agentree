import crypto from "node:crypto";
import type { NodeId, TurnNode } from "../shared/types.ts";

/**
 * Semantic node identity (`TurnNode.stableIds`) — a PERSISTENCE contract:
 * annotations in `~/.agentree/meta/` are keyed by it, so a change here must
 * keep earlier keys findable (`legacyIds`, and `scheme2Fingerprint` below).
 *
 * Current scheme (4), per node:
 *
 *  - a STRONG own key — unique by itself: a Claude API message id
 *    (`m:<id>`), a prompt id with its text (`p:<promptId>|<digest>`), a
 *    Codex `<turnId>:<itemId>` — is the identity;
 *  - a WEAK own key — text alone (Copilot, legacy Codex, a Claude prompt
 *    with no prompt id) — is qualified by the parent's identity, as a
 *    fixed-size hash: `w:` + 24 hex of SHA-1 over JSON `[key, parentId]`
 *    (`"root"` for no parent). A copy repeats the whole prefix, so the chain
 *    and the hash are the same in every copy; the same text under another
 *    parent is another node; and an identity's size doesn't grow with the
 *    conversation's depth.
 *
 * Text is digested EXACTLY as the parser produced it: indentation and line
 * breaks are meaning in code, and a copy preserves them byte for byte.
 *
 * Every SAVED key of a scheme has a form no other scheme saves with a
 * different meaning, so where a key came from is never a guess:
 *
 *  - (1) raw per-file uuids;
 *  - (2) the digest folded whitespace runs, prompt keys were
 *    `u:<promptId>|<digest>`, and a weak key was the literal string
 *    `key@parentIdentity` — quadratic in a long text-keyed chain;
 *  - (3) exact digests and `w:` weak keys as now, but prompt keys still
 *    `u:<promptId>|<digest>` — the same form as scheme 2's, so a saved `u:`
 *    key can be either: scheme 2's key for one prompt is scheme 3's for
 *    another that differs from it only in whitespace;
 *  - (4) prompt keys moved to `p:`, a form no earlier scheme saved. (A weak
 *    prompt's hash input keeps its `u:|<digest>` form.)
 *
 * `m:` and Codex keys never changed meaning; `w:` keys mean the same in
 * schemes 3 and 4 wherever their chain of parents does.
 */

const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

/** Digest of the WHOLE text, whitespace included — an identity, unlike a display gist. */
export const digest = (s: string) => sha1(s).slice(0, 20);
/** Scheme 2's digest: whitespace runs folded. Only to find keys saved under it. */
export const foldedDigest = (s: string) => sha1(s.replace(/\s+/g, " ").trim()).slice(0, 20);

/** Role + whole-text digest: the match key where text is the only evidence a copy keeps. */
export const textKey = (n: TurnNode) => `${n.role}:${digest(n.text)}`;
export const foldedTextKey = (n: TurnNode) => `${n.role}:${foldedDigest(n.text)}`;

const ROOT = "root";
/** A weak key under its parent's identity, at a fixed size. */
export const qualify = (key: string, parent: string) => `w:${sha1(JSON.stringify([key, parent])).slice(0, 24)}`;

export interface OwnKey {
  key: string;
  /** Unique on its own, so not qualified by the parent. */
  strong: boolean;
  /**
   * The same node's own key under each earlier scheme still read — scheme 2,
   * then scheme 3 — where it differs from `key`.
   */
  earlier?: [scheme2?: string, scheme3?: string];
}

const EARLIER = 2;

/**
 * Give every node its identity (`stableIds[0]`) and, where an earlier scheme
 * keyed it differently, those schemes' identities (`legacyIds`): each chain is
 * qualified within its own scheme, so a scheme-2 weak identity is the bounded
 * fingerprint `scheme2Fingerprint` computes for its saved literal. `own`
 * returns the node's keys; parents come from `parentId`.
 */
export function assignStableIds(nodes: TurnNode[], own: (n: TurnNode) => OwnKey): void {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** Per node: [current, scheme 2, scheme 3]. */
  const done = new Map<NodeId, string[]>();
  for (const start of nodes) {
    // Iterative: a text-keyed (Copilot, legacy Codex) chain is as deep as the
    // conversation is long.
    const path: TurnNode[] = [];
    const onPath = new Set<NodeId>();
    let base: string[] = Array(EARLIER + 1).fill(ROOT);
    for (let cur: TurnNode | undefined = start; cur; ) {
      const hit = done.get(cur.id);
      if (hit) {
        base = hit;
        break;
      }
      if (onPath.has(cur.id)) break; // malformed (cyclic) transcript
      onPath.add(cur.id);
      path.push(cur);
      if (own(cur).strong) break;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const { key, strong, earlier = [] } = own(path[i]);
      const keys = [key, ...Array.from({ length: EARLIER }, (_, s) => earlier[s] ?? key)];
      const parent = base;
      base = keys.map((k, s) => (strong ? k : qualify(k, parent[s])));
      done.set(path[i].id, base);
    }
  }
  for (const n of nodes) {
    const [id, ...older] = done.get(n.id)!;
    const legacy = [...new Set(older)].filter((k) => k !== id);
    n.stableIds = [id];
    n.legacyIds = legacy.length ? legacy : undefined;
  }
}

/**
 * A scheme-2 key as the fingerprint `assignStableIds` computes for it
 * (`legacyIds`), so a saved key can be matched without rebuilding the
 * quadratic literal. A weak scheme-2 key reads `k_n@…@k_1@base`: the node's
 * own key, each weak ancestor's, then the nearest strong ancestor's key or
 * `root`. Folding it from the base re-applies the qualification. A key
 * without `@` was strong and is its own fingerprint.
 */
export function scheme2Fingerprint(saved: string): string {
  const parts = saved.split("@");
  let id = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) id = qualify(parts[i], id);
  return id;
}
