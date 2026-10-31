import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnNode } from "../shared/types.ts";

// A disposable Agentree home before meta.ts is imported.
vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  process.env.AGENTREE_HOME = fs.mkdtempSync(p.join(os.tmpdir(), "agentree-annotations-"));
});

const { applyAnnotations, readMeta, writeAnnotation, writeMeta } = await import("../electron/meta.ts");
const { parseRecords } = await import("../electron/transcripts.ts");
const { foldedDigest } = await import("../electron/identity.ts");

/**
 * Two prompts that share a prompt id (the CLI stamps one on every record of a
 * prompt, attachments included) and differ only in whitespace. Scheme 2's key
 * for the second is, character for character, scheme 3's key for the first.
 */
const SID = "60000000-0000-4000-8000-000000000001";
const rec = (uuid: string, parentUuid: string | null, type: "user" | "assistant", content: string, extra = {}) => ({
  type,
  uuid,
  parentUuid,
  sessionId: SID,
  timestamp: new Date(Date.UTC(2026, 9, 1, 10, Number(uuid.slice(-1)))).toISOString(),
  ...extra,
  message: { role: type, content: type === "user" ? content : [{ type: "text", text: content }], ...(type === "assistant" ? { id: `msg_${uuid}` } : {}) },
});
const records = [
  rec("u1", null, "user", "run tests", { promptId: "rt-1" }),
  rec("a2", "u1", "assistant", "Ran them."),
  rec("u3", "a2", "user", "run  tests", { promptId: "rt-1" }),
  rec("a4", "u3", "assistant", "Ran them again."),
];
let nodes: TurnNode[];
const fresh = () => parseRecords(SID, { records, bad: 0 }).nodes;
const shown = () => {
  const ns = fresh();
  applyAnnotations(ns, [SID]);
  return ns.filter((n) => n.role === "user").map((n) => n.label);
};
const prompt = (text: string) => nodes.find((n) => n.text === text)!;

beforeEach(() => {
  for (const k of Object.keys(readMeta(SID))) writeMeta(SID, k, { label: undefined, status: undefined, note: undefined });
  nodes = fresh();
});

describe("annotations on prompts that differ only in whitespace", () => {
  it("keep their own current keys: each can be set, changed and cleared alone", () => {
    expect(prompt("run tests").stableIds).not.toEqual(prompt("run  tests").stableIds);
    writeAnnotation(prompt("run tests"), nodes, [SID], { label: "A" });
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: "B" });
    expect(shown()).toEqual(["A", "B"]);
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: undefined });
    expect(shown()).toEqual(["A", undefined]);
  });

  it("leave an entry an earlier scheme gave both of them where it is, shown on neither", () => {
    // Scheme 2's key for both prompts; scheme 3's for the first alone.
    const shared = `u:rt-1|${foldedDigest("run tests")}`;
    writeMeta(SID, shared, { label: "old, whose?" });
    expect(shown()).toEqual([undefined, undefined]);
    // Writing to either prompt neither rewrites nor clears it.
    writeAnnotation(prompt("run tests"), nodes, [SID], { label: "new" });
    writeAnnotation(prompt("run  tests"), nodes, [SID], { label: undefined });
    expect(readMeta(SID)[shared]).toEqual({ label: "old, whose?" });
    expect(shown()).toEqual(["new", undefined]);
  });
});
