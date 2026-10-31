import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.ts";
import { newestLeaf, pathToRoot, shortLabel } from "../../shared/render.ts";
import {
  BOX_H, buildLayout, CHAIN_ROWS, edgePath, forkTags, nodeLabel, nodeWidth,
  onSelectedPath, PAD, ROW_H, tagBox, type VNode,
} from "../tree-layout.ts";
import type { MemberInfo } from "../../shared/types.ts";

interface View {
  tx: number;
  ty: number;
  k: number;
}

export function TreeCanvas() {
  const {
    session, nodes, children, selected, expanded, compress,
    select, toggleChain,
  } = useStore();

  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, k: 1 });
  const [hover, setHover] = useState<VNode | null>(null);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);

  const pathIds = useMemo(
    () => new Set(pathToRoot(selected, nodes).map((n) => n.id)),
    [selected, nodes],
  );

  // Each fork's first turn is tagged with its session's title, so the tree
  // says WHICH chat a dashed edge starts, not just where.
  const tags = useMemo(
    () => forkTags(session?.nodes ?? [], session?.members ?? []),
    [session],
  );
  const members = useMemo(() => new Map((session?.members ?? []).map((m) => [m.id, m])), [session]);

  // Geometry depends only on tree shape, tags and what's expanded. `pathIds`
  // feeds edge highlighting; it never moves anything.
  const layout = useMemo(
    () => buildLayout({ children, tags, pathIds, expanded, compress }),
    [children, tags, pathIds, expanded, compress],
  );

  // The conversation's tip — where a plain `--resume` would continue. Marked
  // with a pulsing ring so the "now" of a live session is visible at a glance.
  const tip = useMemo(
    () => newestLeaf(session?.nodes ?? [], children),
    [session, children],
  );
  const tipColor = (tip && nodes.get(tip)?.role === "user") ? "var(--user)" : "var(--assistant)";
  // The legend only explains dashed edges when the tree actually has one.
  const hasCross = layout.edges.some((e) => e.cross);

  // A dead-end mark covers the whole exploration beneath it: everything under
  // a marked turn is equally abandoned, so the subtree dims as one.
  const deadIds = useMemo(() => {
    const dead = new Set<string>();
    const sweep = (id: string) => {
      if (dead.has(id)) return;
      dead.add(id);
      for (const c of children.get(id) ?? []) sweep(c.id);
    };
    for (const n of session?.nodes ?? []) if (n.status === "dead-end") sweep(n.id);
    return dead;
  }, [session, children]);

  // Kept in a ref so the auto-fit effect below can call the latest version
  // without taking it as a dependency — otherwise any layout change would
  // re-fit, yanking the viewport out from under the user.
  const fitRef = useRef<() => void>(() => {});
  fitRef.current = () => {
    const el = svgRef.current;
    if (!el || layout.width === 0) return;
    const { width: w, height: h } = el.getBoundingClientRect();
    const k = Math.min(w / layout.width, h / layout.height, 1.4);
    setView({ tx: w / 2 - (layout.width / 2 - PAD) * k, ty: PAD * k, k });
  };
  const fit = () => fitRef.current();

  // Fit ONCE per session. Not on selection, not on expand/collapse, not on
  // compress — the viewport is the user's to control after the first frame.
  useEffect(() => {
    fitRef.current();
  }, [session?.meta.id]);

  // ---- pan & zoom -------------------------------------------------------

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    setView((v) => {
      const k = Math.min(4, Math.max(0.05, v.k * factor));
      // Keep the point under the cursor fixed while scaling.
      return { k, tx: px - ((px - v.tx) * k) / v.k, ty: py - ((py - v.ty) * k) / v.k };
    });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setView((v) => ({ ...v, tx: d.tx + (e.clientX - d.x), ty: d.ty + (e.clientY - d.y) }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  if (!session || layout.vnodes.length === 0) {
    return (
      <div className="canvas empty">
        <p className="muted">No turns in this session.</p>
      </div>
    );
  }

  return (
    <div className="canvas">
      <div className="canvas-tools">
        <button className="ghost" onClick={fit} title="Fit tree to view">
          fit
        </button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, k: v.k * 1.25 }))}>
          +
        </button>
        <button className="ghost" onClick={() => setView((v) => ({ ...v, k: v.k / 1.25 }))}>
          −
        </button>
        <span className="muted small">{Math.round(view.k * 100)}%</span>
      </div>

      <svg
        ref={svgRef}
        className="tree-svg"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
          {/* Edges first so nodes draw on top. */}
          <g className="edges">
            {layout.edges.map((e, i) => (
              <path
                key={i}
                d={edgePath(e.from, e.to)}
                className={`edge ${e.onPath ? "on-path" : ""} ${e.cross ? "cross" : ""}`}
              />
            ))}
          </g>

          <g className="nodes">
            {layout.vnodes.map((v) =>
              v.kind === "chain" ? (
                <Chain
                  key={v.id}
                  v={v}
                  dead={deadIds.has(v.nodes[0].id)}
                  onPath={onSelectedPath(v, { pathIds })}
                  onOpen={() => toggleChain(v.id)}
                  onHover={setHover}
                />
              ) : (
                <Node
                  key={v.id}
                  v={v}
                  tag={tags.get(v.id)}
                  onPath={pathIds.has(v.id)}
                  isSelected={v.id === selected}
                  isTip={v.id === tip}
                  isDead={deadIds.has(v.id)}
                  onSelect={() => select(v.id)}
                  onHover={setHover}
                />
              ),
            )}
          </g>
        </g>
      </svg>

      {hover && <Tooltip v={hover} members={members} />}

      {/* Always-on legend instead of overlay modes: everything the drawing
          encodes, decoded in one quiet line. */}
      {/* The hover tooltip occupies the same bottom strip; the legend yields
          while it's up rather than stacking under it. */}
      <div className={`legend muted small ${hover ? "legend-hidden" : ""}`}>
        <span><i className="lg-dot lg-user" /> User</span>
        <span><i className="lg-dot lg-assistant" /> Agent</span>
        <span><i className="lg-dot lg-tip" style={{ borderColor: tipColor }} /> latest turn</span>
        {hasCross && (
          <span title="The dashed edge enters a fork (a new session), or a Codex prompt edit (a new branch of the same thread)">
            <i className="lg-cross" /> fork / edited branch
          </span>
        )}
      </div>
    </div>
  );
}

function Node({
  v,
  tag,
  onPath,
  isSelected,
  isTip,
  isDead,
  onSelect,
  onHover,
}: {
  v: Extract<VNode, { kind: "node" }>;
  tag?: string;
  onPath: boolean;
  isSelected: boolean;
  isTip: boolean;
  isDead: boolean;
  onSelect: () => void;
  onHover: (v: VNode | null) => void;
}) {
  const n = v.node;
  const r = isSelected ? 9 : 6;
  const fill = n.role === "user" ? "var(--user)" : "var(--assistant)";

  // A labelled node is drawn as a box with the text inside, not a dot with the
  // text floating beside it. The size comes from the layout module so that the
  // box drawn here is exactly the box siblings were spaced around.
  const label = nodeLabel(n);
  const box = { w: nodeWidth(n), h: BOX_H };
  const mark = n.status === "favorite" ? "★" : n.status === "dead-end" ? "✕" : null;
  const tagAt = tag ? tagBox(n, tag) : null;

  return (
    <g
      className={[
        "vnode",
        n.role,
        onPath ? "on-path" : "",
        isSelected ? "selected" : "",
        isDead ? "dead" : "",
        n.isSidechain ? "sidechain" : "",
        // Mid-turn messages are drawn hollow: `injected` ones are reconstructed
        // from the queue (no record, unresumable); `midTurn` ones are backed by
        // a queued_command attachment (real record, retained by later forks).
        n.injected || n.midTurn ? "injected" : "",
        isTip ? "tip" : "",
      ].join(" ")}
      transform={`translate(${v.x},${v.y})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      onMouseEnter={() => onHover(v)}
      onMouseLeave={() => onHover(null)}
    >
      {isTip && <circle r={label ? box.h : 12} className="tip-ring" />}
      {label ? (
        <>
          {isSelected && (
            <rect
              className="halo-box"
              x={-box.w / 2 - 4}
              y={-box.h / 2 - 4}
              width={box.w + 8}
              height={box.h + 8}
              rx={9}
            />
          )}
          <rect
            className="node-box"
            x={-box.w / 2}
            y={-box.h / 2}
            width={box.w}
            height={box.h}
            rx={6}
            fill={fill}
          />
          <text className="node-box-text" y={4}>
            {label}
          </text>
        </>
      ) : (
        <>
          {isSelected && <circle r={r + 5} className="halo" />}
          <circle r={r} fill={fill} className="dot" />
        </>
      )}
      {tag && tagAt ? (
        // The tag takes the place a ★ / ✕ mark would float in, so the mark
        // rides inside it (its width budgets for one).
        <g className="fork-tag">
          <rect x={tagAt.x} y={tagAt.y} width={tagAt.w} height={tagAt.h} rx={4} />
          <text y={tagAt.y + tagAt.h - 3}>
            {mark && <tspan className={`mark ${n.status === "dead-end" ? "dead" : ""}`}>{mark} </tspan>}
            {tag}
          </text>
        </g>
      ) : (
        mark && (
          <text className={`mark ${n.status === "dead-end" ? "dead" : ""}`} y={-(label ? box.h / 2 + 5 : 12)}>
            {mark}
          </text>
        )
      )}
    </g>
  );
}

function Chain({
  v,
  dead,
  onPath,
  onOpen,
  onHover,
}: {
  v: Extract<VNode, { kind: "chain" }>;
  dead: boolean;
  onPath: boolean;
  onOpen: () => void;
  onHover: (v: VNode | null) => void;
}) {
  const span = CHAIN_ROWS * ROW_H;
  return (
    <g
      className={`vchain ${onPath ? "on-path" : ""} ${dead ? "dead" : ""}`}
      transform={`translate(${v.x},${v.y})`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      onMouseEnter={() => onHover(v)}
      onMouseLeave={() => onHover(null)}
    >
      <line x1={0} y1={0} x2={0} y2={span} className="chain-line" />
      <rect x={-13} y={span / 2 - 9} width={26} height={18} rx={9} className="chain-pill" />
      <text y={span / 2 + 4} className="chain-count">
        {v.nodes.length}
      </text>
    </g>
  );
}

function Tooltip({ v, members }: { v: VNode; members: Map<string, MemberInfo> }) {
  let text =
    v.kind === "chain"
      ? `${v.nodes.length} linear turns — click to expand`
      : `${v.node.injected || v.node.midTurn ? "mid-turn " : ""}${v.node.role}: ${shortLabel(v.node, 90)}`;
  // A fork's first turn names its chat — here in full, and also when a user
  // label took the tag's place.
  const m = v.kind === "node" && v.node.branchKind === "fork" ? members.get(v.node.sourceSessionId ?? "") : undefined;
  if (m) {
    const parent = m.parentId ? members.get(m.parentId)?.title : undefined;
    const from = parent ? ` · ${m.parentEvidence === "inferred" ? "probably forked from" : "forked from"} “${parent}”` : "";
    text = `fork “${m.title}”${from} — ${text}`;
  }
  return <div className="tree-tooltip">{text}</div>;
}
