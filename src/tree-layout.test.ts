// Lives in src/ (not test/): it type-checks with the renderer it tests.
import { describe, expect, it } from "vitest";
import { childIndex } from "../shared/render.ts";
import type { MemberInfo, TurnNode } from "../shared/types.ts";
import { buildLayout, elementBounds, forkTags, type Rect } from "./tree-layout.ts";

/** Deterministic, so a failure reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const member = (id: string, title: string): MemberInfo => ({
  id,
  title,
  parentId: null,
  cwd: "",
  resumeCommand: "",
  activeAt: 0,
  touchedAt: 0,
});

const words = "plan build test ship rollup refactor cache layer docs pass migrate audit".split(" ");

function randomTree(rand: () => number) {
  const members = Array.from({ length: 4 }, (_, i) =>
    member(`s${i}`, Array.from({ length: 1 + Math.floor(rand() * 6) }, () => words[Math.floor(rand() * words.length)]).join(" ")),
  );
  const n = 2 + Math.floor(rand() * 60);
  const nodes: TurnNode[] = [];
  for (let i = 0; i < n; i++) {
    // Mostly a caterpillar (continue the newest turn), with branches.
    const parent = i === 0 ? null : rand() < 0.75 ? nodes[i - 1] : nodes[Math.floor(rand() * i)];
    const fork = !!parent && rand() < 0.15;
    nodes.push({
      id: `n${i}`,
      parentId: parent?.id ?? null,
      role: i % 2 ? "assistant" : "user",
      text: `turn ${i}`,
      timestamp: i,
      sourceSessionId: fork ? members[1 + Math.floor(rand() * 3)].id : members[0].id,
      branchKind: fork ? "fork" : undefined,
      label: rand() < 0.1 ? words.slice(0, 1 + Math.floor(rand() * 5)).join(" ") : undefined,
      status: rand() < 0.05 ? "favorite" : rand() < 0.03 ? "dead-end" : undefined,
    });
  }
  return { nodes, members };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;

describe("tree layout with fork tags", () => {
  it("never draws two elements on top of each other (300 random trees)", () => {
    const rand = rng(7);
    let tagged = 0;
    for (let t = 0; t < 300; t++) {
      const { nodes, members } = randomTree(rand);
      const children = childIndex(nodes);
      const tags = forkTags(nodes, members);
      tagged += tags.size;
      const compress = rand() < 0.8;
      // Open a random subset of the chains, as a user would.
      const chains = buildLayout({ children, tags, pathIds: new Set(), expanded: new Set(), compress })
        .vnodes.filter((v) => v.kind === "chain")
        .map((v) => v.id);
      const expanded = new Set(chains.filter(() => rand() < 0.4));
      const layout = buildLayout({ children, tags, pathIds: new Set(), expanded, compress });

      const rects = layout.vnodes.flatMap((v) => elementBounds(v, tags).map((r) => ({ r, id: v.id })));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          if (overlaps(rects[i].r, rects[j].r)) {
            throw new Error(`tree ${t}: ${rects[i].id} overlaps ${rects[j].id}`);
          }
        }
      }
    }
    expect(tagged).toBeGreaterThan(300);
  });

  it("tags each fork's first turn with its session's title; a label or an edit gets none", () => {
    const members = [member("root", "Root"), member("a", "Try rollup"), member("b", "Benchmarks"), member("c", "Docs pass")];
    const n = (id: string, parentId: string | null, extra: Partial<TurnNode> = {}): TurnNode => ({
      id,
      parentId,
      role: "user",
      text: id,
      timestamp: 0,
      sourceSessionId: "root",
      ...extra,
    });
    const nodes = [
      n("r", null),
      n("a1", "r", { branchKind: "fork", sourceSessionId: "a" }),
      n("b1", "r", { branchKind: "fork", sourceSessionId: "b" }),
      n("c1", "r", { branchKind: "fork", sourceSessionId: "c" }),
      n("e1", "r", { branchKind: "edit" }),
      n("l1", "r", { branchKind: "fork", sourceSessionId: "a", label: "mine" }),
    ];
    expect(Object.fromEntries(forkTags(nodes, members))).toEqual({ a1: "Try rollup", b1: "Benchmarks", c1: "Docs pass" });
    // A default "<parent> (fork)" title names nothing; the id tells forks apart.
    const native = [member("root", "Root"), { ...member("d0000000-1", "Root (fork)"), parentId: "root" }];
    expect(forkTags([n("r", null), n("d1", "r", { branchKind: "fork", sourceSessionId: "d0000000-1" })], native).get("d1")).toBe(
      "fork d0000000",
    );
  });
});
