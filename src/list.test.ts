import { describe, expect, it } from "vitest";
import { cwdKey } from "../shared/render.ts";
import type { SessionMeta } from "../shared/types.ts";
import { filterSessions, focusFor, ofProvider, railDirs, shownForks } from "./list.ts";

const meta = (id: string, cwd: string, activeAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  provider: "claude",
  cwd,
  project: "",
  title: id,
  activeAt,
  touchedAt: activeAt,
  nodeCount: 1,
  branchPoints: 0,
  resumeCommand: "",
  ...extra,
});

describe("directory keys", () => {
  it("treats the spellings one session records for a folder as one directory", () => {
    const k = cwdKey("C:\\work\\new");
    expect(cwdKey("c:\\work\\new\\")).toBe(k);
    expect(cwdKey("/c/work/new")).toBe(k);
    expect(cwdKey("c:/work/new/")).toBe(k);
    // Only the drive letter folds; the rest of a path may be case-sensitive.
    expect(cwdKey("C:\\Work\\new")).not.toBe(k);
    expect(cwdKey("/home/me/repo/")).toBe("/home/me/repo");
    expect(cwdKey("C:\\")).toBe("c:/");
  });

  it("ranks rail directories by recency and shows the newest spelling", () => {
    const rail = railDirs([meta("a", "C:\\work\\new", 1), meta("b", "/c/work/new", 3), meta("c", "C:\\other", 2)]);
    expect(rail).toEqual([
      { key: cwdKey("C:\\work\\new"), path: "/c/work/new", n: 2 },
      { key: cwdKey("C:\\other"), path: "C:\\other", n: 1 },
    ]);
    const list = filterSessions([meta("a", "C:\\work\\new", 1), meta("b", "/c/work/new", 3), meta("c", "C:\\other", 2)], {
      query: "",
      cwd: rail[0].key,
      provider: "",
    });
    expect(list.map((s) => s.id)).toEqual(["b", "a"]);
  });
});

describe("agent filter", () => {
  const all = [
    meta("a", "/work/demo", 4),
    meta("b", "/work/demo", 3, { provider: "codex" }),
    meta("c", "/work/other", 2, { provider: "codex" }),
    meta("d", "/work/other", 1),
  ];

  it("narrows by directory and agent together, and the rail counts agree", () => {
    const demo = cwdKey("/work/demo");
    expect(filterSessions(all, { query: "", cwd: demo, provider: "codex" }).map((s) => s.id)).toEqual(["b"]);
    const rail = railDirs(ofProvider(all, "codex"));
    expect(rail.map((d) => [d.key, d.n])).toEqual([
      [demo, 1],
      [cwdKey("/work/other"), 1],
    ]);
    for (const d of rail) {
      expect(filterSessions(all, { query: "", cwd: d.key, provider: "codex" })).toHaveLength(d.n);
    }
    expect(filterSessions(all, { query: "", cwd: "", provider: "" })).toHaveLength(4);
  });
});

describe("forks on the list", () => {
  const fam = meta("root", "/work/a", 9, {
    title: "Build walkthrough",
    forks: [
      { id: "f1", title: "Try rollup instead", activeAt: 8, cwd: "/work/b" },
      { id: "f2", title: "Build walkthrough (fork)", activeAt: 7, cwd: "/work/a" },
      { id: "f3", title: "Benchmarks", activeAt: 6, cwd: "/work/a" },
      { id: "f4", title: "Docs pass", activeAt: 5, cwd: "/work/a" },
    ],
  });

  it("finds a family by a fork's title, and opens it on that fork", () => {
    expect(filterSessions([fam], { query: "docs", cwd: "", provider: "" })).toHaveLength(1);
    expect(focusFor(fam, "docs")).toBe("f4");
    // A match on the root opens the family as usual.
    expect(focusFor(fam, "walkthrough")).toBeUndefined();
    expect(focusFor(fam, "")).toBeUndefined();
  });

  it("puts a matched fork first, so it never hides behind +N", () => {
    const { shown, more, matched } = shownForks(fam, "docs");
    expect(shown.map((f) => f.id)).toEqual(["f4", "f1", "f2"]);
    expect(more).toBe(1);
    expect([...matched]).toEqual(["f4"]);
    expect(shownForks(fam, "").shown.map((f) => f.id)).toEqual(["f1", "f2", "f3"]);
  });

  it("files a family under every member's directory", () => {
    expect(railDirs([fam]).map((d) => d.path).sort()).toEqual(["/work/a", "/work/b"]);
    expect(filterSessions([fam], { query: "", cwd: cwdKey("/work/b"), provider: "" })).toHaveLength(1);
  });
});
