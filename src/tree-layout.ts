import type { NodeId, TurnNode } from "../shared/types.ts";
import { ROOT_KEY } from "../shared/render.ts";

export const ROW_H = 40;
export const PAD = 40;

/** Clear space kept between two subtrees that sit side by side. */
export const NODE_GAP = 14;

/** Drawn size of an unlabelled node — a dot, plus a little breathing room. */
export const DOT_W = 20;
/** Height of a labelled node's box. */
export const BOX_H = 22;
/** Width of the count pill on a collapsed chain. */
export const CHAIN_W = 26;

/**
 * Visual height of a collapsed chain, in rows — fixed, not proportional to the
 * number of turns it hides. A 200-turn run drawn to scale is an 8000px line
 * that defeats the point of collapsing it; the count badge carries the length.
 */
export const CHAIN_ROWS = 1.8;

/**
 * Shortest filler run worth collapsing. A chain spans CHAIN_ROWS rows and
 * hides its turns behind a count pill; for one or two turns that saves almost
 * no vertical space and costs a click to see what's there — a "⋯ 1" placeholder
 * standing in for a single node is strictly worse than the node.
 */
export const MIN_CHAIN = 3;

/** Longest label drawn inside a box before it's ellipsised. */
const LABEL_MAX = 28;

/** The label drawn inside a node's box, or null for a plain dot. */
export function nodeLabel(n: TurnNode): string | null {
  if (!n.label) return null;
  return n.label.length > LABEL_MAX ? n.label.slice(0, LABEL_MAX - 1) + "…" : n.label;
}

/**
 * How much horizontal room a node needs.
 *
 * SVG cannot measure text without rendering it, so a labelled box is sized from
 * its character count. The estimate is deliberately generous: layout uses this
 * number to space siblings apart, and under-measuring puts a box on top of its
 * neighbour, which is far worse than a slightly wide gap.
 */
export function nodeWidth(n: TurnNode): number {
  const label = nodeLabel(n);
  if (!label) return DOT_W;
  return Math.max(38, label.length * 7 + 18);
}

/**
 * A drawable element. Conversation trees are caterpillars — long linear runs
 * with occasional splits — so a raw node-per-circle drawing is mostly a
 * featureless vertical line. A `chain` collapses one such run into a single
 * element, which is what makes the branch structure legible at a glance.
 *
 * A chain never terminates the drawing: the node it runs into is always
 * emitted below it, so every branch visibly ends in a real, selectable node.
 */
export type VNode =
  | { kind: "node"; id: NodeId; node: TurnNode; x: number; y: number }
  | { kind: "chain"; id: string; nodes: TurnNode[]; x: number; y: number };

export interface VEdge {
  from: VNode;
  to: VNode;
  onPath: boolean;
}

export interface Layout {
  vnodes: VNode[];
  edges: VEdge[];
  width: number;
  height: number;
}

interface BuildOpts {
  children: Map<string, TurnNode[]>;
  /** Nodes from root to the selection. Styling only — never geometry. */
  pathIds: Set<NodeId>;
  /** Chains the user has clicked open. */
  expanded: Set<string>;
  compress: boolean;
}

/**
 * A laid-out subtree in its own coordinate space: every x in `all` is relative
 * to the subtree's left edge, which is always 0. Packing two subtrees side by
 * side is then just shifting one of them by the other's width.
 *
 * Working in whole subtrees — rather than assigning nodes to fixed-width
 * columns — is what keeps a wide labelled box from landing on its neighbour:
 * two subtrees can never overlap, so two nodes in the same row never can.
 */
interface Placed {
  top: VNode;
  all: VNode[];
  width: number;
}

function shift(vs: VNode[], dx: number): void {
  if (dx === 0) return;
  for (const v of vs) v.x += dx;
}

/**
 * A node is "structural" if collapsing it would hide something meaningful:
 * roots, branch points, leaves, and anything annotated. Everything else — the
 * ordinary user↔assistant back-and-forth in between — is chain filler.
 *
 * Deliberately independent of the selection. Making the selected node
 * structural would split a chain on every click, changing the tree's
 * dimensions and making the whole diagram jump — selection is styling, not
 * geometry.
 */
function isStructural(n: TurnNode, children: Map<string, TurnNode[]>): boolean {
  const kidCount = children.get(n.id)?.length ?? 0;
  if (n.parentId === null) return true; // root
  if (kidCount === 0) return true; // leaf
  if (kidCount > 1) return true; // branch point
  if (n.status || n.label) return true; // annotated turns stay visible
  // Everything else — the ordinary user↔assistant back-and-forth between a
  // root, a branch point and a leaf — is chain filler. Notably a branch's
  // FIRST child is not special: keeping it would draw a stray dot under every
  // fork before compression could start.
  return false;
}

export function buildLayout(opts: BuildOpts): Layout {
  const { children, compress, expanded } = opts;
  const roots = children.get(ROOT_KEY) ?? [];

  const edges: VEdge[] = [];
  const link = (from: VNode, to: VNode) =>
    edges.push({ from, to, onPath: onSelectedPath(from, opts) && onSelectedPath(to, opts) });

  /** Filler run starting at `start`, and the structural node it runs into. */
  function collectRun(start: TurnNode) {
    const run: TurnNode[] = [];
    let cur = start;
    if (compress) {
      for (;;) {
        const kids = children.get(cur.id) ?? [];
        if (isStructural(cur, children) || kids.length !== 1) break;
        run.push(cur);
        cur = kids[0];
      }
    }
    return { run, tail: cur };
  }

  /**
   * Grow a subtree so an element of width `w` centred on `cx` fits inside it,
   * re-normalising the left edge back to 0. Used wherever something is centred
   * over a subtree that may be narrower than the thing itself.
   */
  function envelop(p: Placed, cx: number, w: number): Placed {
    const min = Math.min(0, cx - w / 2);
    const max = Math.max(p.width, cx + w / 2);
    if (min < 0) shift(p.all, -min);
    p.width = max - min;
    return p;
  }

  /** Draw one real node and, recursively, everything beneath it. */
  function placeNode(node: TurnNode, y: number): Placed {
    const v: VNode = { kind: "node", id: node.id, node, x: 0, y };
    const w = nodeWidth(node);
    const kids = children.get(node.id) ?? [];

    if (kids.length === 0) {
      v.x = w / 2;
      return { top: v, all: [v], width: w };
    }

    // Pack the child subtrees left to right, then centre the parent on them.
    const placed: Placed[] = [];
    let cursor = 0;
    for (const k of kids) {
      const p = place(k, y + ROW_H);
      shift(p.all, cursor);
      cursor += p.width + NODE_GAP;
      placed.push(p);
    }
    const spanned = cursor - NODE_GAP;

    for (const p of placed) link(v, p.top);
    v.x = (placed[0].top.x + placed[placed.length - 1].top.x) / 2;

    const all = [v, ...placed.flatMap((p) => p.all)];
    return envelop({ top: v, all, width: spanned }, v.x, w);
  }

  /**
   * Place the subtree rooted at `start`, compressing leading filler.
   * Returns the topmost drawn element so the caller can attach an edge.
   */
  function place(start: TurnNode, y: number): Placed {
    const { run, tail } = collectRun(start);
    // Structural start (empty run) or a run too short to be worth a chain:
    // draw the node plainly. placeNode recurses into the child, which lands
    // back here with a run one shorter — so a short run unrolls node by node.
    if (run.length < MIN_CHAIN) return placeNode(start, y);

    const chainId = `chain:${run[0].id}`;

    if (expanded.has(chainId)) {
      // Expanded: draw every hidden turn, then the terminal node. Done here
      // rather than by re-entering `place` so the whole run opens at once
      // instead of revealing one turn per click.
      const runVs: VNode[] = [];
      let yy = y;
      for (const n of run) {
        const v: VNode = { kind: "node", id: n.id, node: n, x: 0, y: yy };
        if (runVs.length > 0) link(runVs[runVs.length - 1], v);
        runVs.push(v);
        yy += ROW_H;
      }

      const below = placeNode(tail, yy);
      link(runVs[runVs.length - 1], below.top);
      for (const v of runVs) v.x = below.top.x; // a linear run occupies one column

      // The run's own boxes can be wider than everything under it.
      const runW = Math.max(...run.map(nodeWidth));
      const out = envelop(
        { top: runVs[0], all: [...runVs, ...below.all], width: below.width },
        below.top.x,
        runW,
      );
      out.top = runVs[0];
      return out;
    }

    const chain: VNode = { kind: "chain", id: chainId, nodes: run, x: 0, y };
    // The terminal node is ALWAYS drawn. Without it a collapsed run ends in
    // empty space, hiding exactly the leaf you'd want to inspect or resume at.
    const below = placeNode(tail, y + CHAIN_ROWS * ROW_H);
    link(chain, below.top);
    chain.x = below.top.x;

    const out = envelop(
      { top: chain, all: [chain, ...below.all], width: below.width },
      chain.x,
      CHAIN_W,
    );
    out.top = chain;
    return out;
  }

  const vnodes: VNode[] = [];
  let cursor = 0;
  for (const r of roots) {
    const p = place(r, 0);
    shift(p.all, cursor);
    cursor += p.width + NODE_GAP;
    vnodes.push(...p.all);
  }
  const totalW = Math.max(0, cursor - NODE_GAP);

  // A chain is anchored at its top and extends CHAIN_ROWS below, so measuring
  // by `y` alone underestimates the height and "fit" leaves the tail clipped.
  const maxY = Math.max(
    0,
    ...vnodes.map((v) => v.y + (v.kind === "chain" ? CHAIN_ROWS * ROW_H : BOX_H / 2)),
  );

  return { vnodes, edges, width: totalW + PAD * 2, height: maxY + PAD * 2 };
}

export function onSelectedPath(v: VNode, opts: { pathIds: Set<NodeId> }): boolean {
  if (v.kind === "node") return opts.pathIds.has(v.id);
  return v.nodes.some((n) => opts.pathIds.has(n.id));
}

/** Cubic bezier leaving the parent's bottom and entering the child's top. */
export function edgePath(from: VNode, to: VNode): string {
  const x1 = from.x;
  const y1 = from.kind === "chain" ? from.y + CHAIN_ROWS * ROW_H : from.y;
  const x2 = to.x;
  const y2 = to.y;
  if (Math.abs(x1 - x2) < 0.5) return `M${x1},${y1} L${x2},${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}
