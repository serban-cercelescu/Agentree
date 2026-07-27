import type { TurnNode } from "../../shared/types.ts";

/**
 * Stitch a fork family of LINEAR sessions into one tree.
 *
 * Codex and Copilot transcripts have no in-file branching: a fork is a NEW
 * session whose transcript begins with a verbatim copy of the parent's prefix
 * (Codex writes this itself on `codex fork`; Agentree's copy-truncate fork
 * does the same for both). So the tree Claude Code stores explicitly exists
 * here too — spread across files, encoded as shared prefixes.
 *
 * Reconstruction: walk each child's turns against its parent's full linear
 * chain; the first mismatch is the divergence point, everything after it hangs
 * off the last shared turn. Matching is on (role, normalised text) — safe
 * because the prefix is a byte copy, not a re-generation.
 *
 * A child's OWN chain (copied prefix + its suffix) is what grandchildren are
 * matched against, but the tree must hold each shared turn once — so alongside
 * the output nodes we keep, per session, the list of tree node ids standing in
 * for that session's positions (`chainIds`).
 */
export interface FamilyMember {
  sessionId: string;
  /** null for the family root. */
  parentSessionId: string | null;
  /** The session's full linear turn list, parsed from its own transcript. */
  nodes: TurnNode[];
}

const gist = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);
const sameTurn = (a: TurnNode, b: TurnNode) =>
  a.role === b.role && gist(a.text) === gist(b.text);

export function stitchFamily(members: FamilyMember[]): TurnNode[] {
  const byId = new Map(members.map((m) => [m.sessionId, m]));
  const root = members.find((m) => !m.parentSessionId || !byId.has(m.parentSessionId));
  if (!root) return [];

  const out: TurnNode[] = [];
  /** sessionId -> tree node id standing in for each position of its chain. */
  const chainIds = new Map<string, string[]>();

  // Root contributes its whole chain as-is (already linearly parented).
  out.push(...root.nodes);
  chainIds.set(root.sessionId, root.nodes.map((n) => n.id));

  // Children in BFS order so a parent's chainIds always exist first. A child
  // whose parent never resolves (deleted transcript) is skipped rather than
  // invented a place in the tree.
  const pending = members.filter((m) => m !== root);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const child = pending[i];
      const parentChain = chainIds.get(child.parentSessionId!);
      const parent = byId.get(child.parentSessionId!);
      if (!parentChain || !parent) continue;
      pending.splice(i--, 1);
      progressed = true;

      // Divergence: longest shared prefix of the child's turns and the
      // parent's. The parent may have grown past the fork point since — the
      // first mismatch (or the shorter chain ending) still marks the split.
      let k = 0;
      while (
        k < child.nodes.length &&
        k < parent.nodes.length &&
        sameTurn(child.nodes[k], parent.nodes[k])
      ) {
        k++;
      }

      const ids = parentChain.slice(0, k);
      const suffix = child.nodes.slice(k);
      let prevId = k > 0 ? ids[k - 1] : null;
      for (const n of suffix) {
        out.push({ ...n, parentId: prevId });
        ids.push(n.id);
        prevId = n.id;
      }
      chainIds.set(child.sessionId, ids);
    }
  }

  return out;
}
