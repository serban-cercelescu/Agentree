import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { childIndex, forkPointOf, pathToRoot, toNodeMap } from "../shared/render.ts";
import type { SessionDetail, TurnNode } from "../shared/types.ts";

const forkThread = vi.fn();
vi.mock("../electron/providers/codex-appserver.ts", () => ({ forkThread: (...a: unknown[]) => forkThread(...a) }));

const { listCodexSessions, loadCodexSession, codexHealth, forkCodexAt } = await import(
  "../electron/providers/codex.ts"
);

const T1 = "01900000-0000-7000-8000-000000000001";
const T2 = "01900000-0000-7000-8000-000000000002";
const T3 = "01900000-0000-7000-8000-000000000003";
const T4 = "01900000-0000-7000-8000-000000000004";
const T5 = "01900000-0000-7000-8000-000000000005";
const T6 = "01900000-0000-7000-8000-000000000006";
const T7 = "01900000-0000-7000-8000-000000000007";
const T8 = "01900000-0000-7000-8000-000000000008";
const T9 = "01900000-0000-7000-8000-00000000000a";
const T11 = "01900000-0000-7000-8000-00000000000b";
const T12 = "01900000-0000-7000-8000-00000000000c";
const G = "01900000-0000-7000-8000-000000000009";
const L = "01800000-0000-7000-8000-000000000001";
const LX = "01800000-0000-7000-8000-000000000003";
const turn = (n: number) => `01900000-0000-7000-8000-0000000a${String(n).padStart(4, "0")}`;
let home: string;

const find = (d: SessionDetail, end: string): TurnNode => {
  const hits = d.nodes.filter((n) => n.text === end || n.text.endsWith(end));
  expect(hits, `"${end}" drawn once`).toHaveLength(1);
  return hits[0];
};
const kidsOf = (d: SessionDetail, n: TurnNode) =>
  (childIndex(d.nodes).get(n.id) ?? []).map((k) => k.text).sort();

beforeAll(() => {
  // A copy: the rename test appends to session_index.jsonl.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-codex-"));
  home = path.join(tmp, "codex");
  fs.cpSync(path.join(__dirname, "fixtures", "codex", "0.162", "home"), home, { recursive: true });
  process.env.CODEX_HOME = home;
  process.env.AGENTREE_HOME = path.join(tmp, "agentree");
});
beforeEach(() => forkThread.mockReset());

describe("Codex paginated rollouts", () => {
  it("lists families, hides guardian threads, names from session_index", () => {
    const list = listCodexSessions();
    const ids = list.map((s) => s.id).sort();
    expect(ids).toEqual([L, LX, T1, T4, T5, T8, T11, T12].sort());
    expect(ids).not.toContain(G);
    expect(ids).not.toContain(T7); // unparseable, so nothing to list
    const fam = list.find((s) => s.id === T1)!;
    expect(fam.title).toBe("X investigation");
    expect(fam.members).toBe(3); // T1, archived T3, T2
  });

  it("dates a thread by its last item, not by records written when it was merely loaded", () => {
    const s = listCodexSessions().find((x) => x.id === T12)!;
    expect(new Date(s.activeAt).toISOString()).toBe("2026-10-01T10:50:00.000Z");
    expect(new Date(s.touchedAt).toISOString()).toBe("2026-10-01T18:20:00.000Z");
    // Its quiet fork (no item of its own, reloaded at 18:20) doesn't float
    // the family up; the fork itself dates from its creation.
    expect(s.members).toBe(2);
    const fork = loadCodexSession(T12)!.members.find((m) => m.id !== T12)!;
    expect(new Date(fork.activeAt).toISOString()).toBe("2026-10-01T11:10:00.000Z");
  });

  it("gives each thread its own tip: what its current history ends in", () => {
    const d = loadCodexSession(T1)!;
    const tip = (id: string) => d.nodes.find((n) => n.id === d.members.find((m) => m.id === id)!.tipId)?.text;
    // After the steering message: the turn's last reply.
    expect(tip(T2)).toBe("Grandchild answer.");
    expect(tip(T3)).toBe("Forking.\n\nFork answer.");
    // T1's head is its prompt-edit page: the edited branch, not the cut one.
    expect(tip(T1)).toBe("Rethinking.\n\nDifferent detail.");
    expect(listCodexSessions().find((s) => s.id === T1)!.forks!.map((f) => f.id).sort()).toEqual([T2, T3].sort());
  });

  it("builds forks AND prompt edits into one exact tree", () => {
    const d = loadCodexSession(T2)!;
    expect(d.meta.id).toBe(T1);
    const answerA = find(d, "X is Y.");
    // After turn A: the original B, the edited B', and the fork into T3.
    expect(kidsOf(d, answerA)).toEqual(["Explain differently", "Explain more", "Fork question"]);
    // A prompt edit is a branch of the SAME thread; a fork is a new thread.
    expect(find(d, "Explain differently").branchKind).toBe("edit");
    expect(find(d, "Fork question").branchKind).toBe("fork");
    expect(find(d, "Explain more").branchKind).toBeUndefined();
    expect(find(d, "Fork question").sourceSessionId).toBe(T3);

    const leaf = find(d, "Grandchild answer.");
    expect(pathToRoot(leaf.id, toNodeMap(d.nodes)).map((n) => n.role)).toEqual([
      "user", "assistant", "user", "assistant", "user", "assistant", "user", "assistant",
    ]);
    expect(d.members.find((m) => m.id === T3)).toMatchObject({ archived: true, parentId: T1 });
    expect(d.members.find((m) => m.id === T2)!.parentId).toBe(T3);
  });

  it("aligns a copied-prefix fork on its turn ids, with the fork edge into its first own turn", () => {
    const list = listCodexSessions();
    expect(list.find((s) => s.id === T5)!.members).toBe(2);
    expect(list.some((s) => s.id === T6)).toBe(false);
    const d = loadCodexSession(T6)!;
    expect(d.meta.id).toBe(T5);
    const copied = find(d, "Copied answer.");
    expect(copied.sourceSessionId).toBe(T5);
    expect(kidsOf(d, copied)).toEqual(["Copy goes elsewhere", "Parent goes on"]);
    expect(find(d, "Copy goes elsewhere")).toMatchObject({ branchKind: "fork", sourceSessionId: T6 });
    expect(find(d, "Parent goes on").branchKind).toBeUndefined();
    expect(d.members.find((m) => m.id === T6)!.parentId).toBe(T5);
  });

  it("strips the VS Code context wrapper and folds commentary + final into one reply", () => {
    const d = loadCodexSession(T1)!;
    const root = d.nodes.find((n) => n.parentId === null)!;
    expect(root.text).toBe("What is X?");
    const reply = d.nodes.find((n) => n.parentId === root.id)!;
    expect(reply.text).toBe("Looking.\n\nX is Y.");
    expect(reply.toolUses).toEqual(["shell"]);
    expect(reply.thinking).toBe("Thinking it over.");
    expect(reply.usage).toMatchObject({ input_tokens: 200, cache_read_input_tokens: 800, output_tokens: 50 });
  });

  it("keeps usage reported before a turn's first prose", () => {
    const reply = find(loadCodexSession(T5)!, "Parent answer.");
    expect(reply.usage).toMatchObject({ input_tokens: 700, cache_read_input_tokens: 800, output_tokens: 55 });
  });

  it("marks a steering message typed mid-turn", () => {
    expect(find(loadCodexSession(T1)!, "also this").midTurn).toBe(true);
  });

  it("reads zstd pages, warns about a missing base, fails an unknown vocabulary, stitches legacy forks", () => {
    listCodexSessions();
    const h = codexHealth();
    expect(h.error).toBeUndefined();
    expect(h.skipped).toBe(1); // guardian
    expect(h.failed).toBe(1); // T7
    expect(h.warnings.join(" ")).toMatch(/no longer on disk/);
    expect(h.warnings.join(" ")).toMatch(/couldn't be read/);
    expect(h.unknownRecordTypes).toEqual({ "item/UserMessageV2": 1 });

    const legacy = loadCodexSession(L)!;
    expect(kidsOf(legacy, find(legacy, "Legacy hi."))).toEqual(["Legacy fork continues", "Legacy parent continues"]);
  });

  it("reads a legacy rollout's prose though it also holds a completed item (observed, 0.164)", () => {
    const d = loadCodexSession(LX)!;
    expect(d.nodes.map((n) => [n.text, n.parentId && d.nodes.find((p) => p.id === n.parentId)!.text])).toEqual([
      ["Mixed question", null],
      ["Mixed answer.", "Mixed question"],
      ["Mixed follow-up", "Mixed answer."],
      ["Mixed second answer.", "Mixed follow-up"],
    ]);
    // Still a legacy page: no turn ids to fork at, and the member holds it all.
    for (const n of d.nodes) expect(n.heldBy).toEqual([LX]);
    expect(find(d, "Mixed second answer.").forkBlocked).toMatch(/predates/);
    expect(listCodexSessions().find((s) => s.id === LX)).toMatchObject({ nodeCount: 4 });
    expect(codexHealth().failed).toBe(1); // only T7's untaught vocabulary
  });

  it("picks up a rename in session_index without any rollout changing", () => {
    expect(listCodexSessions().find((s) => s.id === T5)!.title).toBe("Copy me");
    fs.appendFileSync(path.join(home, "session_index.jsonl"), JSON.stringify({ id: T5, thread_name: "Renamed" }) + "\n");
    expect(listCodexSessions().find((s) => s.id === T5)!.title).toBe("Renamed");
  });
});

describe("Codex fork anchors", () => {
  it("offers only whole turns: every node but a turn's last says why", () => {
    const d = loadCodexSession(T1)!;
    expect(find(d, "What is X?").forkBlocked).toMatch(/whole turns/);
    expect(find(d, "X is Y.").forkBlocked).toBeUndefined();
    // Steering splits a turn; only the reply after it ends the turn.
    expect(find(d, "On it.").forkBlocked).toMatch(/whole turns/);
    expect(find(d, "also this").forkBlocked).toMatch(/whole turns/);
    expect(find(d, "Grandchild answer.").forkBlocked).toBeUndefined();
  });

  it("refuses a node inside a turn without calling app-server", async () => {
    const d = loadCodexSession(T1)!;
    const res = await forkCodexAt(T1, forkPointOf(find(d, "What is X?")));
    expect(res.ok).toBe(false);
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("forks by thread when the turn is on the thread's current history", async () => {
    forkThread.mockResolvedValueOnce({ ok: true, threadId: "new-thread-1", cwd: "C:\\work\\codex-demo" });
    const d = loadCodexSession(T1)!;
    const res = await forkCodexAt(T1, forkPointOf(find(d, "Different detail.")));
    expect(forkThread).toHaveBeenLastCalledWith({ threadId: T1, lastTurnId: turn(3) });
    expect(res).toMatchObject({ ok: true, id: "new-thread-1", open: { provider: "codex", sessionId: "new-thread-1" } });
  });

  it("refuses a turn a prompt edit cut away, when no thread holds it any more", async () => {
    const d = loadCodexSession(T1)!;
    const old = find(d, "More detail.");
    expect(old.forkBlocked).toMatch(/prompt edit replaced/);
    const res = await forkCodexAt(T1, forkPointOf(old));
    expect(res).toEqual({ ok: false, error: old.forkBlocked });
    expect(forkThread).not.toHaveBeenCalled();
  });

  it("forks a cut-away turn through a fork thread that still holds it", async () => {
    forkThread.mockResolvedValueOnce({ ok: true, threadId: "new-thread-2", cwd: "" });
    const d = loadCodexSession(T8)!;
    const x2 = find(d, "X2 answer.");
    expect(x2.sourceSessionId).toBe(T8);
    expect(x2.forkBlocked).toBeUndefined();
    const res = await forkCodexAt(T8, forkPointOf(x2));
    expect(forkThread).toHaveBeenLastCalledWith({ threadId: T9, lastTurnId: turn(12) });
    expect(res.ok && res.note).toMatch(/through a fork/);
  });

  it("never folds two turns into one node (an aborted prompt and its replacement)", async () => {
    const d = loadCodexSession(T11)!;
    const cancelled = find(d, "Cancelled prompt");
    const replacement = find(d, "Replacement prompt");
    expect(replacement.parentId).toBe(cancelled.id);
    expect(cancelled.turnId).not.toBe(replacement.turnId);
    // The aborted turn ends at its prompt, so that is a whole turn.
    expect(cancelled.forkBlocked).toBeUndefined();
    expect(replacement.forkBlocked).toMatch(/whole turns/);
    forkThread.mockResolvedValueOnce({ ok: true, threadId: "new-thread-4", cwd: "" });
    await forkCodexAt(T11, forkPointOf(find(d, "Replacement answer.")));
    expect(forkThread).toHaveBeenLastCalledWith({ threadId: T11, lastTurnId: turn(17) });
  });

  it("every enabled node in every family ends its turn: a fork never stops before shown text", () => {
    let checked = 0;
    for (const s of listCodexSessions()) {
      const d = loadCodexSession(s.id)!;
      const map = toNodeMap(d.nodes);
      for (const n of d.nodes) {
        if (n.forkBlocked) continue;
        checked++;
        // Nothing below it belongs to the same turn...
        const sameTurnBelow = d.nodes.filter(
          (m) => m !== n && m.turnId === n.turnId && pathToRoot(m.id, map).includes(n),
        );
        expect(sameTurnBelow, n.text).toEqual([]);
        // ...and the cut it forks at is its own turn's.
        expect(n.lastRawId).toBe(n.turnId);
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("refuses legacy rollouts, which have no turn ids", async () => {
    const d = loadCodexSession(L)!;
    const res = await forkCodexAt(L, forkPointOf(d.nodes[0]));
    expect(res.ok).toBe(false);
    expect(forkThread).not.toHaveBeenCalled();
  });
});
