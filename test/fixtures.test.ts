import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

// The committed fixtures are exactly what their generator writes, compared as
// whole trees: an output nobody committed, a file it no longer writes and a
// changed transcript all show, compressed or not. The tests read the committed
// files, so a difference would mean they exercise old data.
const FIXTURES = path.join(__dirname, "fixtures");
const NOT_GENERATED = new Set(["make-fixtures.mjs", ".gitattributes"]);

const { zstdCompressSync, zstdDecompressSync } = zlib as unknown as {
  zstdCompressSync: (b: Buffer, o?: { params: Record<number, number> }) => Buffer;
  zstdDecompressSync: (b: Buffer) => Buffer;
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentree-fixtures-"));

/** Every file under `root` by its relative path. A compressed page is its transcript: zstd's bytes vary between Node versions. */
function tree(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const f of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
    const file = path.join(root, f);
    if (!fs.statSync(file).isFile() || NOT_GENERATED.has(f)) continue;
    const bytes = fs.readFileSync(file);
    out.set(f.split(path.sep).join("/"), f.endsWith(".zst") ? zstdDecompressSync(bytes) : bytes);
  }
  return out;
}

function differences(committed: Map<string, Buffer>, generated: Map<string, Buffer>): string[] {
  const out = [...generated.keys()].filter((f) => !committed.has(f)).map((f) => `not committed: ${f}`);
  for (const [f, bytes] of committed) {
    if (!generated.has(f)) out.push(`no longer generated: ${f}`);
    else if (!bytes.equals(generated.get(f)!)) out.push(`differs: ${f}`);
  }
  return out;
}

describe("the committed fixtures", () => {
  it("are exactly what the generator writes; `npm run fixtures` and commit if not", () => {
    const generated = tmp();
    execFileSync(process.execPath, [path.join(FIXTURES, "make-fixtures.mjs"), generated], { stdio: "pipe" });
    expect(differences(tree(FIXTURES), tree(generated))).toEqual([]);
    expect(tree(generated).size).toBeGreaterThan(0);
  });
});

describe("comparing fixture trees", () => {
  const page = (level: number, text: string) => zstdCompressSync(Buffer.from(text), { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
  const lines = (word: string) => Array.from({ length: 4000 }, (_, i) => `{"n":${(i * 7919) % 4001},"text":"${word}"}`).join("\n");
  const write = (files: Record<string, Buffer | string>) => {
    const dir = tmp();
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    return tree(dir);
  };

  it("doesn't mind zstd's bytes, only what they hold", () => {
    const fast = page(1, lines("same"));
    const small = page(19, lines("same"));
    expect(fast.equals(small)).toBe(false);
    expect(differences(write({ "a.jsonl.zst": fast }), write({ "a.jsonl.zst": small }))).toEqual([]);
  });

  it("reports a compressed transcript that changed", () => {
    expect(differences(write({ "a.jsonl.zst": page(3, lines("old")) }), write({ "a.jsonl.zst": page(3, lines("new")) }))).toEqual(["differs: a.jsonl.zst"]);
  });

  it("reports a plain file that changed, an output not committed and a stale file", () => {
    const committed = write({ "a.jsonl": "old\n", "gone.jsonl.zst": page(3, "x") });
    const generated = write({ "a.jsonl": "new\n", "d/added.jsonl.zst": page(3, "y") });
    expect(differences(committed, generated).sort()).toEqual(["differs: a.jsonl", "no longer generated: gone.jsonl.zst", "not committed: d/added.jsonl.zst"]);
  });
});
