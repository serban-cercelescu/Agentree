// Check every relative link in the repository's Markdown: the file exists,
// and a `#fragment` into Markdown names a heading or an explicit
// `<a id="…">` there. Line fragments into source files (`#L57`) are only
// checked for the file. External links are not fetched.
//
//   node scripts/check-links.mjs        exit 1 and list each broken link
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tracked = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.startsWith("node_modules/") && fs.existsSync(path.join(root, f)));

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces to hyphens. */
const slug = (text) =>
  text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");

const anchorCache = new Map();
function anchorsOf(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  const out = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) out.add(m[1]);
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = slug(h[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  anchorCache.set(file, out);
  return out;
}

const broken = [];
for (const rel of tracked) {
  const file = path.join(root, rel);
  let fenced = false;
  fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return;
      const code = line.replace(/`[^`]*`/g, "");
      for (const m of code.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = m[1].replace(/^<|>$/g, "");
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, vscode: …
        const [p, frag] = target.split("#");
        const dest = p ? path.resolve(path.dirname(file), decodeURIComponent(p)) : file;
        const where = `${rel}:${i + 1}`;
        if (!fs.existsSync(dest)) {
          broken.push(`${where}  ${target}  (no such file)`);
          continue;
        }
        const line = /^L\d+(-L\d+)?$/.test(frag ?? "");
        if (frag && !line && dest.endsWith(".md") && !anchorsOf(dest).has(decodeURIComponent(frag))) {
          broken.push(`${where}  ${target}  (no such heading or anchor)`);
        }
      }
    });
}

if (broken.length) {
  console.error(`${broken.length} broken link(s):\n${broken.join("\n")}`);
  process.exit(1);
}
console.log(`Links OK in ${tracked.length} Markdown files.`);
