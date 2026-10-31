import { describe, expect, it } from "vitest";
import { assignTips, childIndex, copyHolders, heldTip, newestLeaf, pathToRoot, toNodeMap } from "../shared/render.ts";
import type { MemberInfo } from "../shared/types.ts";
import { mergeSameRoleRuns, parseRecords, type RawRecord } from "../electron/transcripts.ts";

/**
 * A node starts when its first part was written and ends with its last. Which
 * branch was active last — a session's tip, the leaf a focused member opens
 * on — is read from the end. One prompt, two answers: A, started first but
 * continued last, and B, written in between.
 */
const SID = "60000000-0000-4000-8000-000000000002";
const at = (min: number) => new Date(Date.UTC(2026, 9, 1, 10, min)).toISOString();
const user = (uuid: string, parentUuid: string | null, min: number, text: string): RawRecord => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: at(min),
  promptId: "ep-1",
  message: { role: "user", content: text },
});
const asst = (uuid: string, parentUuid: string, min: number, id: string, text: string): RawRecord => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: at(min),
  message: { id, role: "assistant", content: [{ type: "text", text }] },
});

function tree(records: RawRecord[]) {
  const nodes = mergeSameRoleRuns(parseRecords(SID, { records, bad: 0 }).nodes);
  for (const n of nodes) n.heldBy = copyHolders(n);
  return nodes;
}
const pathOf = (nodes: ReturnType<typeof tree>, id: string | null) => pathToRoot(id, toNodeMap(nodes)).map((n) => n.text);

describe("a branch's last activity is its end, not its start", () => {
  it("across a same-role run", () => {
    const nodes = tree([
      user("u1", null, 0, "Pick one"),
      asst("a1", "u1", 1, "msg_a", "A begins."),
      asst("b1", "u1", 2, "msg_b", "B."),
      asst("a2", "a1", 3, "msg_a2", "A goes on."),
    ]);
    const a = nodes.find((n) => n.text.startsWith("A begins."))!;
    expect(a.text).toBe("A begins.\n\nA goes on.");
    expect(a.timestamp).toBe(Date.parse(at(1)));
    expect(newestLeaf(nodes, childIndex(nodes))).toBe(a.id);
    expect(pathOf(nodes, heldTip(nodes, (n) => !!n.heldBy?.includes(SID)))).toEqual(["Pick one", a.text]);
    const member: MemberInfo = { id: SID, title: "", parentId: null, cwd: "", resumeCommand: "", activeAt: 0, touchedAt: 0 };
    assignTips(nodes, [member]);
    expect(member.tipId).toBe(a.id);
  });

  it("across one reply streamed as several records", () => {
    const nodes = tree([
      user("u1", null, 0, "Pick one"),
      asst("a1", "u1", 1, "msg_a", "A begins. "),
      asst("b1", "u1", 2, "msg_b", "B."),
      asst("a1b", "a1", 3, "msg_a", "A ends."),
    ]);
    const a = nodes.find((n) => n.text.startsWith("A begins."))!;
    expect(a.endedAt).toBe(Date.parse(at(3)));
    expect(newestLeaf(nodes, childIndex(nodes))).toBe(a.id);
  });
});
