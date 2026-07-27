import type { NodeId, TurnNode, UsageSnapshot } from "./types.ts";

export type NodeMap = Map<NodeId, TurnNode>;
export const ROOT_KEY = "\0root";

export function toNodeMap(nodes: TurnNode[]): NodeMap {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** parentId -> children, ordered oldest-first. */
export function childIndex(nodes: TurnNode[]): Map<string, TurnNode[]> {
  const idx = new Map<string, TurnNode[]>();
  for (const n of nodes) {
    const key = n.parentId ?? ROOT_KEY;
    const bucket = idx.get(key);
    if (bucket) bucket.push(n);
    else idx.set(key, [n]);
  }
  for (const bucket of idx.values()) bucket.sort((a, b) => a.timestamp - b.timestamp);
  return idx;
}

/** Walk from a leaf to the root and return the path root-first. */
export function pathToRoot(leaf: NodeId | null, nodes: NodeMap): TurnNode[] {
  const path: TurnNode[] = [];
  const seen = new Set<NodeId>();
  let id: NodeId | null = leaf;
  while (id) {
    if (seen.has(id)) break; // a malformed transcript must not hang the UI
    seen.add(id);
    const node = nodes.get(id);
    if (!node) break;
    path.push(node);
    id = node.parentId;
  }
  return path.reverse();
}

/** Follow the most recently created child until we hit a leaf. */
export function descendToNewestLeaf(id: NodeId, children: Map<string, TurnNode[]>): NodeId {
  let cur = id;
  const seen = new Set<NodeId>([cur]);
  for (;;) {
    const kids = children.get(cur);
    if (!kids || kids.length === 0) return cur;
    const next = kids[kids.length - 1].id;
    if (seen.has(next)) return cur;
    seen.add(next);
    cur = next;
  }
}

/**
 * The newest leaf anywhere in the session — where the CLI would resume.
 *
 * Prefers a leaf that actually has text: many leaves are tool-result-only user
 * turns, and opening a session onto an empty "(no text)" node is a poor first
 * impression of the conversation.
 */
export function newestLeaf(nodes: TurnNode[], children: Map<string, TurnNode[]>): NodeId | null {
  const leaves = nodes.filter((n) => (children.get(n.id)?.length ?? 0) === 0);
  if (leaves.length === 0) return null;
  const newest = (list: TurnNode[]) =>
    list.reduce((a, b) => (a.timestamp >= b.timestamp ? a : b)).id;
  const withText = leaves.filter((n) => n.text.trim().length > 0);
  return withText.length > 0 ? newest(withText) : newest(leaves);
}

export function countBranchPoints(children: Map<string, TurnNode[]>): number {
  let n = 0;
  for (const [key, kids] of children) {
    if (key !== ROOT_KEY && kids.length > 1) n++;
  }
  return n;
}

// ------------------------------------------------------------------ cost

export interface CostBreakdown {
  /** input + cache_creation + cache_read. `input_tokens` alone is the uncached remainder. */
  promptTokens: number;
  outputTokens: number;
  cacheHitRate: number;
}

/**
 * Token weight for a turn, read straight from the transcript's `message.usage`.
 *
 * Deliberately not a dollar figure: the transcript records token counts, not
 * pricing, and on a Max subscription there is no per-token bill to report.
 */
export function costOf(node: TurnNode | undefined): CostBreakdown {
  const empty: CostBreakdown = { promptTokens: 0, outputTokens: 0, cacheHitRate: 0 };
  if (!node?.usage) return empty;
  const u: UsageSnapshot = node.usage;
  const promptTokens =
    u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return {
    promptTokens,
    outputTokens: u.output_tokens,
    cacheHitRate: promptTokens > 0 ? u.cache_read_input_tokens / promptTokens : 0,
  };
}

/**
 * Context at a point in the tree: the nearest usage-bearing turn's LAST API
 * call, prompt + output (see TurnNode.lastUsage — the summed `usage` of a
 * merged turn over-counts context, one replay per call). This is what the next
 * message from here sends.
 */
export function contextAt(id: NodeId | null, nodes: NodeMap): number | null {
  const seen = new Set<NodeId>();
  let cur = id ? nodes.get(id) : undefined;
  while (cur) {
    const u = cur.lastUsage ?? cur.usage;
    if (u) {
      return (
        u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens +
        u.output_tokens
      );
    }
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return null;
}

/**
 * The session's context window. Transcripts record no window size and the
 * model ids carry no marker, so it is inferred from usage: a conversation that
 * exceeds 200k must be on a 1M window. (A 1M session that never crossed 200k
 * reads as 200k — conservative, never past 100%.)
 */
export function inferWindow(nodes: TurnNode[]): number {
  let max = 0;
  for (const n of nodes) {
    const u = n.lastUsage ?? n.usage;
    if (!u) continue;
    const ctx =
      u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens +
      u.output_tokens;
    if (ctx > max) max = ctx;
  }
  return max > 200_000 ? 1_000_000 : 200_000;
}

export function sumCost(nodes: TurnNode[]): CostBreakdown {
  return nodes.reduce<CostBreakdown>(
    (acc, n) => {
      const c = costOf(n);
      acc.promptTokens += c.promptTokens;
      acc.outputTokens += c.outputTokens;
      return acc;
    },
    { promptTokens: 0, outputTokens: 0, cacheHitRate: 0 },
  );
}

// ------------------------------------------------------------------ text

export function shortLabel(node: TurnNode, max = 48): string {
  if (node.label) return node.label;
  const t = node.text.replace(/\s+/g, " ").trim();
  if (!t) {
    if (node.toolUses?.length) return `⚒ ${node.toolUses.join(", ")}`;
    return node.role === "assistant" ? "(thinking only)" : "(empty)";
  }
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}
