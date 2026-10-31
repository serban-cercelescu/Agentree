import { describe, expect, it } from "vitest";
import type { TurnNode } from "../shared/types.ts";
import { assignStableIds, foldedTextKey, scheme2Fingerprint, textKey } from "../electron/identity.ts";
import { stitchFamily } from "../electron/providers/stitch.ts";

/** A linear user/assistant chain, as Copilot or a legacy Codex rollout yields it. */
const chain = (sid: string, texts: string[]): TurnNode[] =>
  texts.map((text, i) => ({
    id: `${sid}#${i}`,
    parentId: i ? `${sid}#${i - 1}` : null,
    role: i % 2 ? "assistant" : "user",
    text,
    timestamp: i,
    sourceSessionId: sid,
  }));
const textIds = (nodes: TurnNode[]) => {
  assignStableIds(nodes, (n) => ({ key: textKey(n), strong: false, earlier: [foldedTextKey(n)] }));
  return nodes;
};
/** What scheme 2 wrote for a text-keyed chain: `key@parentIdentity`, literally. */
const scheme2Literals = (nodes: TurnNode[]) => {
  const out: string[] = [];
  nodes.forEach((n, i) => out.push(`${foldedTextKey(n)}@${i ? out[i - 1] : "root"}`));
  return out;
};

describe("text-keyed identities", () => {
  it("stay a fixed size however long the chain is", () => {
    const total = (n: number) =>
      textIds(chain("s", Array.from({ length: n }, (_, i) => `turn ${i}`))).reduce((a, x) => a + x.stableIds![0].length, 0);
    expect(total(200) / total(100)).toBe(2);
    expect(new Set(textIds(chain("s", ["a", "b", "c"])).map((n) => n.stableIds![0].length)).size).toBe(1);
  });

  it("are the same in an exact copy, and differ for the same text under another parent", () => {
    const a = textIds(chain("a", ["hi", "hello", "go on", "ok"]));
    const b = textIds(chain("b", ["hi", "hello", "go on", "ok"]));
    expect(b.map((n) => n.stableIds)).toEqual(a.map((n) => n.stableIds));
    const c = textIds(chain("c", ["hey", "hello", "go on", "ok"]));
    expect(c[3].stableIds).not.toEqual(a[3].stableIds);
  });

  it("tell apart texts that differ only in whitespace", () => {
    const a = textIds(chain("a", ["fix it", "if x:\n    y()\nz()"]));
    const b = textIds(chain("b", ["fix it", "if x:\n    y()\n    z()"]));
    expect(b[1].stableIds).not.toEqual(a[1].stableIds);
  });

  it("recognise a key scheme 2 saved, without rebuilding its literal", () => {
    const nodes = textIds(chain("s", ["fix it", "if x:\n    y()\nz()", "done", "thanks"]));
    scheme2Literals(nodes).forEach((saved, i) => {
      expect([...nodes[i].stableIds!, ...(nodes[i].legacyIds ?? [])]).toContain(scheme2Fingerprint(saved));
    });
    // Whitespace-plain text keyed the same either way, so only later nodes needed a legacy id.
    expect(nodes[0].legacyIds).toBeUndefined();
    expect(nodes[1].legacyIds).toHaveLength(1);
    // A strong key was saved as itself.
    expect(scheme2Fingerprint("m:msg_1")).toBe("m:msg_1");
  });
});

describe("text-keyed stitching", () => {
  it("never merges copies whose text differs only in indentation", () => {
    const parent = textIds(chain("p", ["fix it", "if x:\n    y()\nz()", "Unconditional."]));
    const fork = textIds(chain("f", ["fix it", "if x:\n    y()\n    z()", "Conditional."]));
    const nodes = stitchFamily([
      { sessionId: "p", parentSessionId: null, nodes: parent },
      { sessionId: "f", parentSessionId: "p", nodes: fork },
    ]);
    const kids = nodes.filter((n) => n.parentId === "p#0");
    expect(kids.map((n) => n.sourceSessionId).sort()).toEqual(["f", "p"]);
    expect(nodes.find((n) => n.text === "Conditional.")!.parentId).toBe(kids.find((n) => n.sourceSessionId === "f")!.id);
  });
});
