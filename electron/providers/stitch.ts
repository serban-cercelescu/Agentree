import { childIndex, ROOT_KEY } from "../../shared/render.ts";
import type { NodeId, TurnNode } from "../../shared/types.ts";
import { textKey } from "../identity.ts";

/**
 * Stitch a fork family — several sessions that share prefixes — into one tree.
 *
 * Every harness forks by COPYING: Claude's VS Code "fork conversation" writes a
 * new transcript holding one chain up to the chosen message; Copilot
 * forks are copy-truncated session dirs; pre-paginated Codex rollouts carried a
 * verbatim prefix. So the tree the user branched exists, just spread across
 * files, encoded as shared prefixes.
 *
 * Reconstruction is structural, not positional. A child's node maps onto a
 * node already in the tree when both
 *
 *   - carry the same match key (see `keyOf`), and
 *   - hang off the same tree node (or are both roots).
 *
 * The second condition is what makes this safe on DAGs: matching can only
 * extend down a path that has matched so far, so the first unmatched node is
 * the divergence point, and everything below it is the fork's own suffix —
 * re-parented onto the last shared turn. Rewinds inside either transcript stay
 * branches of their own, and a parent that grew after the fork just keeps its
 * extra turns.
 *
 * The keys must be EVIDENCE the copy preserved, never a guess: Claude uses the
 * API message id and prompt id (copied verbatim; uuids are not), legacy Codex
 * and Copilot use role + text, safe there because the prefix is a byte copy.
 * Text is compared WHOLE and EXACT (as a digest, `identity.ts`), never by an
 * opening gist or with whitespace folded: two prompts that share a long
 * preamble, or differ only in a line's indentation, are different prompts.
 * A shared opening prompt alone never merges two sessions — the families are
 * chosen by the caller from lineage, and keys only align their prefixes.
 */
export interface FamilyMember {
  sessionId: string;
  /** null for a family root. */
  parentSessionId: string | null;
  /** The session's own turns, parsed from its own transcript. May be a DAG. */
  nodes: TurnNode[];
  /** Match key for one of this member's nodes. Defaults to role + full-text digest. */
  keyOf?: (n: TurnNode) => string;
}

/** Parents before children, siblings in file order. */
function topo(nodes: TurnNode[]): TurnNode[] {
  const kids = childIndex(nodes);
  const ids = new Set(nodes.map((n) => n.id));
  const out: TurnNode[] = [];
  const stack = [...(kids.get(ROOT_KEY) ?? [])];
  // Nodes whose parent is not in this member at all are roots too.
  for (const n of nodes) if (n.parentId && !ids.has(n.parentId)) stack.push(n);
  stack.reverse();
  const seen = new Set<NodeId>();
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    const cs = kids.get(n.id) ?? [];
    for (let i = cs.length - 1; i >= 0; i--) stack.push(cs[i]);
  }
  return out;
}

/**
 * How many of `child`'s nodes map onto `parent`'s tree under the same rule
 * stitching uses (same key, under a node that already mapped, roots onto
 * roots). It compares the WHOLE of both DAGs — every branch, not just the
 * newest chain — so a parent that rewound after it was forked from, or a
 * child that rewound into its copied prefix, still measures the history the
 * copy actually preserved. Callers use it to pick a member's parent: a fork
 * of a fork overlaps its direct parent more than any other member.
 */
export function overlap(child: FamilyMember, parent: FamilyMember): number {
  const keyOfC = child.keyOf ?? textKey;
  const keyOfP = parent.keyOf ?? textKey;
  const view = new Map<string, Map<string, NodeId>>();
  for (const n of parent.nodes) {
    const slot = n.parentId ?? ROOT_KEY;
    if (!view.has(slot)) view.set(slot, new Map());
    const k = keyOfP(n);
    if (!view.get(slot)!.has(k)) view.get(slot)!.set(k, n.id);
  }
  const alias = new Map<NodeId, NodeId>();
  let count = 0;
  for (const n of topo(child.nodes)) {
    const slot = n.parentId === null ? ROOT_KEY : alias.get(n.parentId);
    if (slot === undefined) continue;
    const hit = view.get(slot)?.get(keyOfC(n));
    if (hit === undefined) continue;
    alias.set(n.id, hit);
    count++;
  }
  return count;
}

export function stitchFamily(members: FamilyMember[]): TurnNode[] {
  const byId = new Map(members.map((m) => [m.sessionId, m]));
  const out: TurnNode[] = [];
  const outById = new Map<NodeId, TurnNode>();
  const taken = new Set<NodeId>();
  /**
   * Per processed member: tree parent id → (match key → tree node id), i.e.
   * that member's view of the tree. A child is matched against its parent's
   * view, so it can only merge with turns its parent actually contains.
   */
  const views = new Map<string, Map<string, Map<string, NodeId>>>();

  const add = (m: FamilyMember, parentView: Map<string, Map<string, NodeId>> | null) => {
    const keyOf = m.keyOf ?? textKey;
    /** member node id → the tree node standing in for it. */
    const alias = new Map<NodeId, NodeId>();
    /** member node ids that merged into an existing tree node. */
    const matched = new Set<NodeId>();
    const view = new Map<string, Map<string, NodeId>>();

    for (const n of topo(m.nodes)) {
      const treeParent = n.parentId ? alias.get(n.parentId) ?? null : null;
      const parentMatched = n.parentId === null || matched.has(n.parentId);
      const key = keyOf(n);

      let treeId: NodeId | undefined;
      if (parentView && parentMatched) {
        treeId = parentView.get(treeParent ?? ROOT_KEY)?.get(key);
      }
      if (treeId !== undefined) {
        matched.add(n.id);
        // The copy is dropped from the drawing but not from the model: where
        // else the turn lives, and under which id, is kept per session.
        const kept = outById.get(treeId);
        if (kept) {
          kept.occurrences = [
            ...(kept.occurrences ?? []),
            { sessionId: m.sessionId, id: n.id },
            ...(n.occurrences ?? []),
          ];
        }
      } else {
        // COPIES, never the originals: callers keep parsed node arrays in
        // mtime-keyed caches, and the downstream same-role merge rewrites
        // parentIds in place.
        treeId = taken.has(n.id) ? `${m.sessionId}:${n.id}` : n.id;
        taken.add(treeId);
        const copy: TurnNode = {
          ...n,
          id: treeId,
          parentId: treeParent,
          sourceSessionId: n.sourceSessionId ?? m.sessionId,
          // A collision-renamed node still records its id in its own session.
          occurrences:
            treeId !== n.id ? [{ sessionId: m.sessionId, id: n.id }, ...(n.occurrences ?? [])] : n.occurrences,
          // First own turn under a shared prefix: the edge into it is the fork.
          branchKind: parentView !== null && parentMatched && treeParent !== null ? "fork" : n.branchKind,
        };
        out.push(copy);
        outById.set(treeId, copy);
      }
      alias.set(n.id, treeId);
      const slot = treeParent ?? ROOT_KEY;
      if (!view.has(slot)) view.set(slot, new Map());
      if (!view.get(slot)!.has(key)) view.get(slot)!.set(key, treeId);
    }
    views.set(m.sessionId, view);
  };

  // Roots first (no parent, or a parent that is no longer on disk), then
  // children in waves so a parent's view always exists before its forks.
  const pending = [...members];
  for (let i = 0; i < pending.length; i++) {
    const m = pending[i];
    if (!m.parentSessionId || !byId.has(m.parentSessionId) || m.parentSessionId === m.sessionId) {
      add(m, null);
      pending.splice(i--, 1);
    }
  }
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const view = views.get(pending[i].parentSessionId!);
      if (!view) continue;
      add(pending[i], view);
      pending.splice(i--, 1);
      progressed = true;
    }
  }
  // A lineage cycle — callers validate parentage so this shouldn't happen,
  // but if it does, draw the rest standalone, never drop it.
  for (const m of pending) add(m, null);

  return out;
}
