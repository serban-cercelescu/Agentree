import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { actionTarget, childIndex, cwdKey, FORK_POINT_GONE, forkPointOf, pathToRoot, toNodeMap } from "../shared/render.ts";
import type { SessionDetail, TurnNode } from "../shared/types.ts";
import { claudeHealth, claudeWatchDirs, listSessions, loadSession, mergeSameRoleRuns, parseFile } from "../electron/transcripts.ts";
import { forkClaudeAt } from "../electron/providers/claude-fork.ts";
import { readLineage } from "../electron/lineage.ts";
import { annotate } from "../electron/registry.ts";
import { readMeta, writeMeta } from "../electron/meta.ts";
import { digest, foldedDigest, qualify } from "../electron/identity.ts";

const P = "11111111-1111-4111-8111-111111111111";
const F = "22222222-2222-4222-8222-222222222222";
const S = "33333333-3333-4333-8333-333333333333";
const P1 = "41111111-1111-4111-8111-111111111111";
const F1 = "42222222-2222-4222-8222-222222222222";
const G1 = "43333333-3333-4333-8333-333333333333";
const P2 = "44444444-4444-4444-8444-444444444444";
const F2 = "45555555-5555-4555-8555-555555555555";
const QP = "46666666-6666-4666-8666-666666666666";
const QF = "47777777-7777-4777-8777-777777777777";
const KP = "48888888-8888-4888-8888-888888888888";
const KN = "49999999-9999-4999-8999-999999999999";
const NP = "4aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "4ccccccc-cccc-4ccc-8ccc-cccccccccccc";
const PA = "4ddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PB = "4eeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const P3 = "4fffffff-ffff-4fff-8fff-ffffffffffff";
const F3 = "50000000-0000-4000-8000-000000000001";
const G3 = "50000000-0000-4000-8000-000000000002";
const TL = "50000000-0000-4000-8000-000000000003";
const MV = "50000000-0000-4000-8000-000000000004";
const MO = "50000000-0000-4000-8000-000000000005";
const MF = "50000000-0000-4000-8000-000000000006";
const SP = "50000000-0000-4000-8000-000000000007";
const CD = "50000000-0000-4000-8000-000000000008";
const WP = "50000000-0000-4000-8000-000000000009";
const WF = "50000000-0000-4000-8000-00000000000a";
const EP = "50000000-0000-4000-8000-00000000000b";
const EF = "50000000-0000-4000-8000-00000000000c";
const UP = "50000000-0000-4000-8000-00000000000d";
const UF = "50000000-0000-4000-8000-00000000000e";
const GP = "50000000-0000-4000-8000-00000000000f";
const GF = "50000000-0000-4000-8000-000000000010";
const RNS = "50000000-0000-4000-8000-000000000011";
const DV = "50000000-0000-4000-8000-000000000012";
const SP4 = "50000000-0000-4000-8000-000000000013";
const SB4 = "50000000-0000-4000-8000-000000000014";
const SF4 = "50000000-0000-4000-8000-000000000015";
const GUARD_OUT = "Change it:\n\n```python\nif ready:\n    send()\ncancel()\n```";
const GUARD_IN = "Change it:\n\n```python\nif ready:\n    send()\n    cancel()\n```";
const EP_PROMPT = "Summarise the log\n\n  - errors only";
let claudeRoot: string;
let projects: string;
const projectDir = (name = "c--work-demo") => path.join(projects, name);
const readJsonl = (file: string) =>
  fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** Every tree Agentree hands the renderer must be one: unique ids, no dangling parents, no cycles. */
function expectTree(d: SessionDetail) {
  const ids = new Set(d.nodes.map((n) => n.id));
  expect(ids.size).toBe(d.nodes.length);
  for (const n of d.nodes) if (n.parentId) expect(ids.has(n.parentId)).toBe(true);
  const map = toNodeMap(d.nodes);
  for (const n of d.nodes) expect(pathToRoot(n.id, map)[0].parentId).toBeNull();
}
const byText = (d: SessionDetail, t: string) => d.nodes.filter((n) => n.text === t);
const one = (d: SessionDetail, t: string): TurnNode => {
  const hits = byText(d, t);
  expect(hits, `"${t}" drawn once`).toHaveLength(1);
  return hits[0];
};
const kidsOf = (d: SessionDetail, n: TurnNode) =>
  (childIndex(d.nodes).get(n.id) ?? []).map((k) => k.text).sort();

beforeAll(() => {
  // Work on a copy: the fork tests write new transcripts.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-claude-"));
  fs.cpSync(path.join(__dirname, "fixtures", "claude", "2.1"), path.join(tmp, "claude"), { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude");
  process.env.AGENTREE_HOME = path.join(tmp, "agentree");
  // The registry is used for annotations; keep the other harnesses off the real home dir.
  process.env.CODEX_HOME = path.join(tmp, "no-codex");
  process.env.COPILOT_HOME = path.join(tmp, "no-copilot");
  projects = path.join(tmp, "claude", "projects");
  claudeRoot = path.join(tmp, "claude");
});

describe("Claude transcripts", () => {
  it("lists one entry per fork family and never merges on an opening prompt alone", () => {
    const list = listSessions().filter((s) => [P, F, S].includes(s.id));
    expect(list.map((s) => s.id).sort()).toEqual([P, S]);
    expect(list.find((s) => s.id === P)!.members).toBe(2);
    expect(list.find((s) => s.id === S)!.members).toBe(1);
  });

  it("names a family's forks on its list entry, and gives each member its own tip", () => {
    expect(listSessions().find((s) => s.id === P)!.forks).toEqual([
      expect.objectContaining({ id: F, title: "Build walkthrough (fork)", cwd: "C:\\work\\demo" }),
    ]);
    const d = loadSession(P)!;
    const tip = (id: string) => d.nodes.find((n) => n.id === d.members.find((m) => m.id === id)!.tipId)?.text;
    expect(tip(F)).toBe("Switched to rollup.");
    // P's own newest leaf, not the family's (F's turns aren't P's).
    expect(tip(P)).toBe("Waiting.");
  });

  it("titles from ai-title, never the IDE wrapper", () => {
    const fam = listSessions().find((s) => s.id === P)!;
    expect(fam.title).toBe("Build walkthrough");
    expect(fam.entrypoint).toBe("claude-vscode");
    expect(listSessions().find((s) => s.id === S)!.title).toBe("Explain the build");
  });

  it("drops ide_* context from turn text and ignores api-request-blob records", () => {
    const d = loadSession(P)!;
    expect(d.nodes.find((n) => n.parentId === null)!.text).toBe("Explain the build");
    expect(d.nodes.some((n) => n.text.includes("NOT A TURN"))).toBe(false);
  });

  it("stitches the extension fork in at the turn it was taken after", () => {
    for (const id of [P, F]) {
      const d = loadSession(id)!;
      expectTree(d);
      expect(d.meta.id).toBe(P); // any member opens the family
      // Two rewind branches inside P, plus the fork's own first prompt.
      expect(kidsOf(d, one(d, "Added vitest."))).toEqual(["Actually, wait", "Ship it", "Try rollup instead"]);
      const forkTurn = one(d, "Try rollup instead");
      expect(forkTurn.branchKind).toBe("fork");
      expect(forkTurn.sourceSessionId).toBe(F);
      one(d, "Explain the build"); // the shared prefix exists once
      expect(d.meta.branchPoints).toBe(1);
      expect(d.members.find((m) => m.id === F)!.parentId).toBe(P);
    }
  });

  it("keeps the fork's parent when that parent rewinds after being forked from", () => {
    const d = loadSession(G1)!;
    expectTree(d);
    expect(d.meta.id).toBe(P1);
    const parents = Object.fromEntries(d.members.map((m) => [m.id, m.parentId]));
    expect(parents).toEqual({ [P1]: null, [F1]: P1, [G1]: F1 });
    // F1's own reply exists once, and G1 continues from it.
    expect(kidsOf(d, one(d, "Rollback is a revert."))).toEqual(["Script the revert"]);
    expect(one(d, "Script the revert").branchKind).toBe("fork");
    // F1's later rewind is its own branch off the first reply.
    expect(kidsOf(d, one(d, "Three steps."))).toEqual(["Detail step one", "Start over with a hotfix"]);
  });

  it("never lets title order contradict explicit lineage (no cycle, no duplicated prefix)", () => {
    const d = loadSession(F2)!;
    expectTree(d);
    expect(d.meta.id).toBe(P2);
    expect(Object.fromEntries(d.members.map((m) => [m.id, m.parentId]))).toEqual({ [P2]: null, [F2]: P2 });
    expect(kidsOf(d, one(d, "Dear team,"))).toEqual(["Make it formal", "Make it shorter"]);
  });

  it("joins a fork taken on a regenerated first answer", () => {
    const list = listSessions().filter((s) => [QP, QF].includes(s.id));
    expect(list).toHaveLength(1);
    expect(list[0].members).toBe(2);
    const d = loadSession(QF)!;
    expectTree(d);
    expect(kidsOf(d, one(d, "Name the project"))).toEqual(["Call it Atlas.", "Call it Beacon."]);
    expect(kidsOf(d, one(d, "It guides."))).toEqual(["Pick a logo"]);
  });

  it("aligns a native fork of a compacted session across the stale logical parent", () => {
    const d = loadSession(KN)!;
    expectTree(d);
    expect(d.members).toHaveLength(2);
    expect(d.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(kidsOf(d, one(d, "Continuing with issue one."))).toEqual(["Fix issue three instead", "Fix issue two"]);
    // Pre-compact turns are drawn, and say why they can't be forked.
    expect(one(d, "Found four issues.").forkBlocked).toMatch(/compact/);
  });

  it("dates a session by its newest conversation record, not its newest bookkeeping", () => {
    const s = listSessions().find((x) => x.id === TL)!;
    // The tool loop ran until 10:09; the mode change at 15:00 is a file change only.
    expect(new Date(s.activeAt).toISOString()).toBe("2026-10-01T10:09:00.000Z");
    expect(new Date(s.touchedAt).toISOString()).toBe("2026-10-01T15:00:00.000Z");
  });

  it("files a session under the directory it continued in, not the first one", () => {
    const s = listSessions().find((x) => x.id === MV)!;
    expect(s.cwd).toBe("/c/work/new");
    expect(cwdKey(s.cwd)).toBe(cwdKey("C:/work/new"));
    expect(loadSession(MV)!.meta.cwd).toBe("/c/work/new");
    // No project folder to go by: a cd into a subfolder, or up past the
    // start, doesn't move the session.
    expect(listSessions().find((x) => x.id === CD)!.cwd).toBe("C:\\repo");
  });

  it("counts an unparseable transcript as failed, not hidden", () => {
    listSessions();
    const h = claudeHealth();
    expect(h.filesSeen).toBe(31);
    expect(h.failed).toBe(1);
    expect(h.sessionsParsed).toBe(29);
    // The moved session's old copy: every record is in the new one.
    expect(h.skipped).toBe(1);
    expect(h.warnings.join(" ")).toMatch(/couldn't be read/);
    expect(h.warnings.join(" ")).toMatch(/2 sessions have copies in more than one project folder.*1 of them diverged/);
    expect(h.unknownRecordTypes).toEqual({});
  });
});

describe("Claude sessions stored in several project folders", () => {
  it("lists a moved session once, as its newest copy, with a fork from a third folder", () => {
    const list = listSessions().filter((s) => [MO, MF].includes(s.id));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: MO, members: 2, cwd: "C:\\work\\articulation", title: "Package rename" });
    for (const id of [MO, MF]) {
      const d = loadSession(id)!;
      expectTree(d);
      expect(d.meta.id).toBe(MO);
      // The continuation that exists only in the new folder's copy is drawn.
      expect(kidsOf(d, one(d, "Imports updated."))).toEqual(["Publish it"]);
      expect(one(d, "Publish it")).toMatchObject({ branchKind: "fork", sourceSessionId: MF });
      expect(d.members.find((m) => m.id === MO)!.files).toHaveLength(2);
      expect(d.members.find((m) => m.id === MF)!.parentId).toBe(MO);
      expect(d.nodes.find((n) => n.id === d.members.find((m) => m.id === MF)!.tipId)?.text).toBe("Published.");
    }
    // The family is filed under the fork's folder too.
    expect(list[0].forks).toEqual([expect.objectContaining({ id: MF, cwd: "C:\\work\\third" })]);
    // The live view watches every folder the family lives in.
    expect(claudeWatchDirs(MF).map((d) => path.basename(d)).sort()).toEqual([
      "c--work-moved-a-old",
      "c--work-moved-b-new",
      "c--work-moved-c-third",
    ]);
  });

  it("draws both continuations of copies that diverged after a shared prefix", () => {
    expect(listSessions().filter((s) => s.id === SP)).toHaveLength(1);
    const d = loadSession(SP)!;
    expectTree(d);
    expect(d.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(kidsOf(d, one(d, "Two phases."))).toEqual(["Phase one first", "Phase two first"]);
    one(d, "Phase one done.");
    one(d, "Phase two done.");
  });

  it("forks a moved session from the copy that holds the turn, next to it", () => {
    const d = loadSession(MO)!;
    const res = forkClaudeAt(MO, forkPointOf(one(d, "Imports updated.")));
    expect(res).toMatchObject({ ok: true, cwd: "C:\\work\\articulation" });
    if (!res.ok) return;
    expect(fs.existsSync(path.join(projectDir("c--work-moved-b-new"), `${res.id}.jsonl`))).toBe(true);
    const after = loadSession(MO)!;
    expectTree(after);
    expect(after.nodes.length).toBe(d.nodes.length);
    fs.rmSync(path.join(projectDir("c--work-moved-b-new"), `${res.id}.jsonl`));
  });
});

describe("Claude display merge and fork endpoints", () => {
  it("keeps a merged node unforkable when its last part can't anchor (no silent drop)", () => {
    // Prompt + (tools-only reply, not drawn) + mid-turn message fold into one
    // node. Its only anchor would be the prompt, which excludes the message.
    const d = loadSession(AT)!;
    expectTree(d);
    const merged = d.nodes.find((n) => n.role === "user")!;
    expect(merged.text).toBe("Run the migration\n\nalso back up first");
    expect(merged.forkBlocked).toMatch(/mid-turn/);
    expect(forkClaudeAt(AT, forkPointOf(merged))).toMatchObject({ ok: false });
    // The turn after it is the fork point, and it keeps the message.
    const reply = one(d, "Backed up, then migrated.");
    expect(reply.forkBlocked).toBeUndefined();
  });

  it("keeps prompts distinct that share a long opening and lack a promptId", () => {
    const d = loadSession(PA)!;
    expectTree(d);
    const shared = one(d, "Two options.");
    const kids = (childIndex(d.nodes).get(shared.id) ?? []).map((n) => n.text);
    expect(kids.map((t) => t.slice(-10).trim()).sort()).toEqual(["use Redis", "use SQLite"]);
    const redis = d.nodes.find((n) => n.text.endsWith("use Redis"))!;
    expect(one(d, "Redis answer.").parentId).toBe(redis.id);
    expect(redis.branchKind).toBe("fork");
  });
});

describe("Claude prompt identity", () => {
  it("keeps prompts apart that differ only in indentation, each with its own reply", () => {
    const d = loadSession(WF)!;
    expectTree(d);
    expect(d.meta.id).toBe(WP);
    const out = one(d, GUARD_OUT);
    const inside = one(d, GUARD_IN);
    expect(kidsOf(d, one(d, "Here is the guard."))).toEqual([GUARD_OUT, GUARD_IN].sort());
    expect(one(d, "Unconditional cancel.").parentId).toBe(out.id);
    expect(one(d, "Conditional cancel.").parentId).toBe(inside.id);
    expect(inside).toMatchObject({ branchKind: "fork", sourceSessionId: WF });
    expect(out.stableIds).not.toEqual(inside.stableIds);
  });
});

describe("Claude quiet fork endpoints", () => {
  it("ends a quiet fork at its own last reply, not inside the parent's merged run", () => {
    // Alone, the parent draws its agent loop as one reply...
    const alone = mergeSameRoleRuns(parseFile(path.join(projectDir("c--work-endpoint"), `${EP}.jsonl`)).nodes);
    expect(alone.map((n) => n.text)).toContain("First prose.\n\nLater prose.");
    // ...but the fork holds only the first part, so the family keeps them apart.
    const d = loadSession(EF)!;
    expectTree(d);
    const first = one(d, "First prose.");
    const later = one(d, "Later prose.");
    expect(later.parentId).toBe(first.id);
    expect(new Set(first.heldBy)).toEqual(new Set([EP, EF]));
    expect(later.heldBy).toEqual([EP]);
    expect(d.members.find((m) => m.id === EF)!.tipId).toBe(first.id);
    expect(d.members.find((m) => m.id === EP)!.tipId).toBe(later.id);
    // A fork at the quiet fork's endpoint cannot take in what it never had.
    expect(first.forkBlocked).toBeUndefined();
    const res = forkClaudeAt(EP, forkPointOf(first));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = path.join(projectDir("c--work-endpoint"), `${res.id}.jsonl`);
    expect(mergeSameRoleRuns(parseFile(file).nodes).map((n) => n.text)).toEqual([EP_PROMPT, "First prose."]);
    fs.rmSync(file);
  });

  /** Run `fn` while EF, the quiet fork, is not on disk. */
  const withoutEF = <T,>(fn: () => T): T => {
    const file = path.join(projectDir("c--work-endpoint"), `${EF}.jsonl`);
    const away = path.join(claudeRoot, `${EF}.away`);
    fs.renameSync(file, away);
    try {
      return fn();
    } finally {
      fs.renameSync(away, file);
    }
  };

  it("forks the range drawn when selected, though a quiet fork appearing before the click split it", () => {
    // Before EF exists, EP's agent loop is one node ending on "Later prose."...
    const point = withoutEF(() => forkPointOf(one(loadSession(EP)!, "First prose.\n\nLater prose.")));
    // ...then EF appears, and the same head id now draws only "First prose.".
    const now = loadSession(EP)!;
    expect(one(now, "First prose.").id).toBe(point.nodeId);
    const res = forkClaudeAt(EP, point);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const file = path.join(projectDir("c--work-endpoint"), `${res.id}.jsonl`);
    expect(mergeSameRoleRuns(parseFile(file).nodes).map((n) => n.text)).toEqual([EP_PROMPT, "First prose.\n\nLater prose."]);
    fs.rmSync(file);
  });

  it("refuses, rather than fork a longer range, when the selected node was folded into a longer one", () => {
    const point = forkPointOf(one(loadSession(EP)!, "First prose."));
    const before = fs.readdirSync(projectDir("c--work-endpoint")).length;
    // EF is deleted before the click: "First prose." merges with "Later prose." under the same head.
    const res = withoutEF(() => forkClaudeAt(EP, point));
    expect(res).toEqual({ ok: false, error: FORK_POINT_GONE });
    expect(fs.readdirSync(projectDir("c--work-endpoint")).length).toBe(before);
  });

  it("ends a quiet fork at the first of two user records", () => {
    const d = loadSession(UF)!;
    expectTree(d);
    expect(d.meta.id).toBe(UP);
    const first = one(d, "First ask");
    expect(one(d, "Second ask").parentId).toBe(first.id);
    expect(d.members.find((m) => m.id === UF)).toMatchObject({ parentId: UP, parentEvidence: "explicit", tipId: first.id });
  });

  it("opens and resumes the focused quiet fork on the history it shares, and the parent elsewhere", () => {
    const d = loadSession(EP)!;
    const first = one(d, "First prose.");
    const later = one(d, "Later prose.");
    // The shared reply is drawn as the parent's, but the fork holds it too.
    expect(first.sourceSessionId).toBe(EP);
    expect(actionTarget(d, first, EF).ref).toEqual({ provider: "claude", sessionId: EF, cwd: "C:\\work\\demo" });
    expect(actionTarget(d, first, EF).member.resumeCommand).toContain(EF);
    // Opened on the parent, or on a turn the fork doesn't hold: the parent.
    expect(actionTarget(d, first, null).ref.sessionId).toBe(EP);
    expect(actionTarget(d, later, EF).ref.sessionId).toBe(EP);
  });
});

describe("Claude annotations", () => {
  it("resolves a label saved against a copy that stitching folded away", () => {
    // Saved while F stood alone, under F's own uuid for the shared reply.
    writeMeta(F, "f-a2", { label: "tests landed" });
    const d = loadSession(P)!;
    const n = one(d, "Added vitest.");
    expect(n.id).toBe("p-a2");
    expect(n.label).toBe("tests landed");
  });
});

describe("Claude fork", () => {
  it("writes a new transcript in the extension's fork format and stitches it back", () => {
    const before = loadSession(P)!;
    const shipped = one(before, "Added vitest.");
    const res = forkClaudeAt(P, forkPointOf(shipped));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.open).toEqual({ provider: "claude", sessionId: res.id, cwd: "C:\\work\\demo" });
    expect(readLineage()[res.id]).toBe(P);

    const lines = readJsonl(path.join(projectDir(), `${res.id}.jsonl`));
    expect(lines.at(-1)).toMatchObject({ type: "custom-title", customTitle: "Build walkthrough (fork)" });
    const recs = lines.slice(0, -1);
    // Chain up to and including the anchor, re-linked, re-owned, marked.
    expect(recs.map((r) => r.message?.id ?? r.promptId)).toEqual(["prompt-1", "msg_1", "msg_1", "prompt-2", "msg_2"]);
    expect(recs[0].parentUuid).toBeNull();
    for (let i = 1; i < recs.length; i++) expect(recs[i].parentUuid).toBe(recs[i - 1].uuid);
    expect(recs.every((r) => r.sessionId === res.id)).toBe(true);
    expect(recs.every((r) => r.forkedFrom?.sessionId === P)).toBe(true);
    expect(new Set(recs.map((r) => r.uuid)).size).toBe(recs.length);
    expect(recs.some((r) => r.uuid.startsWith("p-"))).toBe(false);

    // Until it has a turn of its own, the fork adds nothing to the tree...
    const after = loadSession(P)!;
    expectTree(after);
    expect(after.members.map((m) => m.id)).toContain(res.id);
    expect(after.nodes.length).toBe(before.nodes.length);
    // ...and opening the tree on it lands on the turn it was forked at.
    expect(after.members.find((m) => m.id === res.id)!.tipId).toBe(shipped.id);
    // ...and the original transcript is untouched.
    expect(fs.readFileSync(path.join(projectDir(), `${P}.jsonl`), "utf8")).not.toContain(res.id);
  });

  it("forks at a node inside a fork's own suffix from that fork's transcript", () => {
    const d = loadSession(P)!;
    const res = forkClaudeAt(P, forkPointOf(one(d, "Switched to rollup.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir(), `${res.id}.jsonl`));
    expect(recs[0].forkedFrom.sessionId).toBe(F);
    expect(recs.at(-1).customTitle).toBe("Build walkthrough (fork) (fork)");
  });

  it("path to a stitched node runs through the shared prefix", () => {
    const d = loadSession(P)!;
    const texts = pathToRoot(one(d, "Switched to rollup.").id, toNodeMap(d.nodes)).map((n) => n.text);
    expect(texts).toEqual(["Explain the build", "The build uses esbuild.", "Now add tests", "Added vitest.", "Try rollup instead", "Switched to rollup."]);
  });

  it("copies the logical chain across /compact, keeping the boundary a physical root", () => {
    const before = loadSession(KP)!;
    const res = forkClaudeAt(KP, forkPointOf(one(before, "Issue two fixed.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir("c--work-compact"), `${res.id}.jsonl`)).slice(0, -1);
    expect(recs.map((r) => r.subtype ?? r.message?.id ?? r.promptId ?? "summary")).toEqual([
      "kp-1", "msg_k1", "compact_boundary", "summary", "msg_k2", "kp-3", "msg_k3",
    ]);
    const cb = recs.find((r) => r.subtype === "compact_boundary");
    expect(cb.parentUuid).toBeNull();
    // The fork is one family with its source, and adds no node of its own yet.
    const after = loadSession(KP)!;
    expectTree(after);
    expect(after.members).toHaveLength(3);
    expect(after.nodes.length).toBe(before.nodes.length);
  });

  it("refuses a pre-compact turn with the reason the panel showed", () => {
    const d = loadSession(KP)!;
    const res = forkClaudeAt(KP, forkPointOf(one(d, "Found four issues.")));
    expect(res).toEqual({ ok: false, error: one(d, "Found four issues.").forkBlocked });
  });

  it("a fork ending on a prompt without promptId re-joins its source", () => {
    const before = loadSession(NP)!;
    const res = forkClaudeAt(NP, forkPointOf(one(before, "Second question")));
    expect(res.ok).toBe(true);
    const after = loadSession(NP)!;
    expectTree(after);
    expect(after.members).toHaveLength(2);
    one(after, "Second question");
    expect(after.nodes.length).toBe(before.nodes.length);
  });

  it("carries an annotation saved before stable ids forward, so it outlives the root", () => {
    // The pre-upgrade sidecar: one entry, under the root's own uuid.
    writeMeta(PA, "pa-a1", { label: "existing annotation" });
    expect(one(loadSession(PA)!, "Two options.").label).toBe("existing annotation");
    // Loading copied it under the turn's stable id into every member's file...
    expect(JSON.parse(fs.readFileSync(path.join(process.env.AGENTREE_HOME!, "meta", `${PB}.json`), "utf8"))).toMatchObject({
      "m:msg_pa1": { label: "existing annotation" },
    });
    // ...so the root can go and the fork still shows it.
    fs.rmSync(path.join(projectDir("c--work-preamble"), `${PA}.jsonl`));
    expect(one(loadSession(PB)!, "Two options.").label).toBe("existing annotation");
  });

  it("annotations survive the session they were made in being deleted", () => {
    // Annotated on the family (written to every member, under every id)...
    annotate(P1, one(loadSession(P1)!, "Step one is tagging.").id, { label: "keep" });
    // ...then the root transcript goes away. Its forks still carry the turn.
    fs.rmSync(path.join(projectDir("c--work-lineage"), `${P1}.jsonl`));
    const d = loadSession(F1)!;
    expect(d.meta.id).toBe(F1);
    expect(one(d, "Step one is tagging.").label).toBe("keep");
  });
});

describe("Claude annotations across identity schemes and membership", () => {
  const sidecar = (id: string) => readMeta(id);

  it("finds labels saved under earlier identity schemes, and carries them forward", () => {
    // Scheme 2 folded whitespace in a prompt's digest...
    const folded = `u:ep-1|${foldedDigest(EP_PROMPT)}`;
    writeMeta(EP, folded, { label: "folded key" });
    // ...and wrote a prompt without a promptId as a literal chain.
    const literal = `u:|${foldedDigest("Second question")}@m:msg_n1`;
    writeMeta(NP, literal, { label: "literal chain" });
    // Scheme 3 keyed a prompt id with its exact text, as `u:`.
    const scheme3 = `u:up-1|${digest("First ask")}`;
    writeMeta(UP, scheme3, { status: "favorite" });

    expect(one(loadSession(EP)!, EP_PROMPT).label).toBe("folded key");
    expect(one(loadSession(NP)!, "Second question").label).toBe("literal chain");
    expect(one(loadSession(UP)!, "First ask").status).toBe("favorite");
    // Carried forward under the current keys, into every member's sidecar.
    for (const id of [EP, EF]) expect(sidecar(id)[`p:ep-1|${digest(EP_PROMPT)}`]).toEqual({ label: "folded key" });
    expect(sidecar(NP)[qualify(`u:|${digest("Second question")}`, "m:msg_n1")]).toEqual({ label: "literal chain" });
    for (const id of [UP, UF]) expect(sidecar(id)[`p:up-1|${digest("First ask")}`]).toEqual({ status: "favorite" });

    // Clearing it clears the old entries too: nothing resurfaces.
    annotate(EP, one(loadSession(EP)!, EP_PROMPT).id, { label: null as unknown as undefined });
    expect(sidecar(EP)[folded]).toBeUndefined();
    expect(one(loadSession(EP)!, EP_PROMPT).label).toBeUndefined();
  });

  it("gives an old key two prompts shared to neither of them", () => {
    // Scheme 2 keyed the two indentations alike; that entry is ambiguous.
    writeMeta(WP, `u:|${foldedDigest(GUARD_OUT)}@m:msg_wi1`, { label: "which one?" });
    const d = loadSession(WP)!;
    expect(one(d, GUARD_OUT).label).toBeUndefined();
    expect(one(d, GUARD_IN).label).toBeUndefined();
  });

  it("keeps a label made before a fork existed once the original is deleted", () => {
    const dir = projectDir("c--work-growth");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(claudeRoot, "growth-src", "c--work-growth");
    fs.copyFileSync(path.join(src, `${GP}.jsonl`), path.join(dir, `${GP}.jsonl`));
    annotate(GP, one(loadSession(GP)!, "Postgres.").id, { label: "chosen" });
    expect(sidecar(GF)).toEqual({});

    // The fork appears; loading the family gives its sidecar the label too.
    fs.copyFileSync(path.join(src, `${GF}.jsonl`), path.join(dir, `${GF}.jsonl`));
    expect(loadSession(GP)!.members.map((m) => m.id).sort()).toEqual([GP, GF].sort());
    expect(sidecar(GF)).toEqual({ "m:msg_gr1": { label: "chosen" } });
    // Once the sidecars agree, a load writes nothing.
    const stamp = () => [GP, GF].map((id) => fs.statSync(path.join(process.env.AGENTREE_HOME!, "meta", `${id}.json`)).mtimeMs);
    const before = stamp();
    loadSession(GF);
    expect(stamp()).toEqual(before);

    fs.rmSync(path.join(dir, `${GP}.jsonl`));
    const d = loadSession(GF)!;
    expect(d.meta.id).toBe(GF);
    expect(one(d, "Postgres.").label).toBe("chosen");
  });
});

describe("Claude metadata across copies of one session", () => {
  /** Copy a session's copies into projects/, oldest write first. */
  const place = (id: string, dirs: string[]) => {
    const t = Date.now() / 1000 - 3600;
    dirs.forEach((name, i) => {
      fs.mkdirSync(projectDir(name), { recursive: true });
      const to = path.join(projectDir(name), `${id}.jsonl`);
      fs.copyFileSync(path.join(claudeRoot, "copies-src", name, `${id}.jsonl`), to);
      fs.utimesSync(to, t + i * 60, t + i * 60);
    });
  };

  it("takes a rename from the copy written last, though every record it has is in the other", () => {
    place(RNS, ["c--work-rn-old", "c--work-rn-new"]);
    expect(listSessions().filter((s) => s.id === RNS)).toEqual([expect.objectContaining({ title: "Renamed in copy" })]);
    const d = loadSession(RNS)!;
    expectTree(d);
    // The conversation is still the larger copy's.
    one(d, "Done too.");
  });

  it("keeps a diverged copy's rename made before its first new record", () => {
    place(DV, ["c--work-dv-a", "c--work-dv-b"]);
    expect(listSessions().find((s) => s.id === DV)!.title).toBe("Named before diverging");
    const d = loadSession(DV)!;
    expectTree(d);
    expect(kidsOf(d, one(d, "Drafted."))).toEqual(["Longer", "Shorter"]);
  });
});

describe("Claude family split", () => {
  it("splits when the member bridging two others is deleted, each side keeping its own turns' identities", () => {
    const dir = projectDir("c--work-split-family");
    fs.mkdirSync(dir, { recursive: true });
    for (const id of [SP4, SB4, SF4]) {
      fs.copyFileSync(path.join(claudeRoot, "split-src", "c--work-split-family", `${id}.jsonl`), path.join(dir, `${id}.jsonl`));
    }
    const before = loadSession(SF4)!;
    expect(before.members.map((m) => m.id).sort()).toEqual([SP4, SB4, SF4].sort());
    const own = one(before, "Cron at 2am.");

    fs.rmSync(path.join(dir, `${SB4}.jsonl`));
    // The root still loads — but SF4 is no longer in its family.
    expect(loadSession(SP4)!.members.map((m) => m.id)).toEqual([SP4]);
    const after = loadSession(SF4)!;
    expectTree(after);
    expect(after.members.map((m) => m.id)).toEqual([SF4]);
    // So a reload can carry the selection over by semantic identity.
    expect(one(after, "Cron at 2am.").stableIds).toEqual(own.stableIds);
  });
});

describe("Claude parentage evidence", () => {
  it("keeps creation order over a renamed title, and says the direction is inferred", async () => {
    // Created P3 → F3 → G3, a second apart; G3 was renamed, so its title
    // carries no "(fork)". Title order alone would make it F3's parent.
    const dir = projectDir("c--work-rename");
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(claudeRoot, "rename-src", "c--work-rename");
    let born = 0;
    for (const id of [P3, F3, G3]) {
      // Past the last file's time on the clock file times come from, not a
      // fixed sleep: a VM's wall clock can step back while a timer runs.
      while (Date.now() < born + 1100) await new Promise((r) => setTimeout(r, 25));
      // Written, not copied: a harness writes a new file, and macOS's copy
      // keeps the source's creation time, which would make all three one batch.
      const file = path.join(dir, `${id}.jsonl`);
      fs.writeFileSync(file, fs.readFileSync(path.join(src, `${id}.jsonl`)));
      born = fs.statSync(file).birthtimeMs;
    }
    const d = loadSession(G3)!;
    expectTree(d);
    expect(d.meta.id).toBe(P3);
    const member = (id: string) => d.members.find((m) => m.id === id)!;
    expect(member(F3)).toMatchObject({ parentId: P3, parentEvidence: "inferred" });
    expect(member(G3)).toMatchObject({ parentId: F3, parentEvidence: "inferred" });
    // F3's own turn is F3's, and the dashed edge is where G3 begins.
    expect(one(d, "End with a question.").sourceSessionId).toBe(F3);
    expect(one(d, "Which question?")).toMatchObject({ branchKind: "fork", sourceSessionId: G3 });
  }, 15_000);
});

describe("Fork invariants over every fixture family", () => {
  /**
   * The displayed text of a path, exactly — whitespace is meaning. Joined,
   * because the family and the fork alone can group the same parts into
   * different nodes (a quiet fork's endpoint splits a run the fork alone merges).
   */
  const flat = (texts: string[]) => texts.join("\n\n");

  it("every enabled fork holds exactly what the selected node shows, and adds nothing to the tree", () => {
    let checked = 0;
    for (const s of listSessions()) {
      const before = loadSession(s.id)!;
      const map = toNodeMap(before.nodes);
      for (const n of before.nodes) {
        if (n.forkBlocked) continue;
        const res = forkClaudeAt(s.id, forkPointOf(n));
        expect(res.ok, `${s.id}: ${n.text}`).toBe(true);
        if (!res.ok) continue;
        checked++;
        // The fork's own transcript, alone, draws the selected path — all of
        // it (nothing shown is left out) and nothing after it.
        const file = path.join(path.dirname(locateFile(res.id)), `${res.id}.jsonl`);
        const own = mergeSameRoleRuns(parseFile(file).nodes);
        expect(flat(own.map((x) => x.text)), n.text).toBe(flat(pathToRoot(n.id, map).map((x) => x.text)));
        // And an unchanged fork stitches in completely: no node, no root added.
        const after = loadSession(s.id)!;
        expectTree(after);
        expect(after.nodes.length, `fork of "${n.text}" added history`).toBe(before.nodes.length);
        fs.rmSync(file);
      }
    }
    expect(checked).toBeGreaterThan(30);
  }, 60_000);

  it("a fork of a compacted fork keeps the pre-compact history (second generation)", () => {
    // KN is the extension's fork of compacted KP: its boundary's logical
    // parent points into KP. Forking KN's own reply must still copy it all.
    const d = loadSession(KN)!;
    const res = forkClaudeAt(KN, forkPointOf(one(d, "Issue three fixed.")));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const recs = readJsonl(path.join(projectDir("c--work-compact"), `${res.id}.jsonl`));
    expect(recs[0].message.content).toBe("Audit the module");
    const boundary = recs.find((r) => r.subtype === "compact_boundary");
    expect(boundary.parentUuid).toBeNull();
    // Its logical link points INSIDE the copy now.
    expect(recs.some((r) => r.uuid === boundary.logicalParentUuid)).toBe(true);
    const after = loadSession(KN)!;
    expectTree(after);
    expect(after.nodes.filter((n) => n.parentId === null)).toHaveLength(1);
    expect(after.nodes.length).toBe(d.nodes.length);
  });
});

function locateFile(id: string): string {
  for (const dir of fs.readdirSync(projects)) {
    const f = path.join(projects, dir, `${id}.jsonl`);
    if (fs.existsSync(f)) return f;
  }
  throw new Error(`no transcript for ${id}`);
}
