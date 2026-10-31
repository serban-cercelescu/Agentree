// Upstream watch: what the agents Agentree reads released since their last
// review, and whether the contracts Agentree depends on still hold in the
// latest release. Run weekly by .github/workflows/upstream.yml, or by hand:
//
//   node scripts/upstream/watch.mjs [--only=claude,codex,copilot] [--report=<file>]
//
// It reads only vendor packages and registries; no account, no model call,
// no user transcript. Exit 1 when a contract check fails (a likely break) or
// when something couldn't be determined (a failed lookup is not "nothing
// new"); new releases alone only set `attention` in the report.
//
// The contracts are evidence of different strength (design notes, "Facts
// marked verified/source/tested"): each check says where it looked.
//   - Codex: the app-server protocol schema the CLI generates for itself
//     (`codex app-server generate-json-schema`) must take the messages
//     Agentree sends. Rollout files are not covered: they have no published
//     schema.
//   - Copilot: the session event types the Copilot SDK generates from the
//     CLI's event schema — the events and fields the provider reads. Source
//     level: that the on-disk events.jsonl matches is not checked here.
//   - Claude: string literals in the Agent SDK's own transcript reader and
//     fork writer (minified source), and the record types it writes that
//     Agentree's parser doesn't know. Source level, and weakest: the
//     extension's own fork may differ.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexProblems, contractResult, latestStable, releaseRow, verdict } from "./check.mjs";

const here = import.meta.dirname;
const root = path.resolve(here, "../..");
const baseline = JSON.parse(fs.readFileSync(path.join(here, "baseline.json"), "utf8"));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const only = arg("only")?.split(",");
const want = (p) => !only || only.includes(p);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-upstream-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32", ...opts });

// ------------------------------------------------------------------ releases

async function npmReleases(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`);
  if (!res.ok) throw new Error(`npm registry ${res.status} for ${pkg}`);
  const doc = await res.json();
  const latest = doc["dist-tags"]?.latest;
  if (!doc.time?.[latest]) throw new Error(`npm registry names no latest version of ${pkg}`);
  // Stable releases only: platform builds and prereleases carry a "-".
  const stable = Object.entries(doc.time).filter(([v]) => /^\d+\.\d+\.\d+$/.test(v));
  return { latest, published: doc.time[latest], versions: stable.map(([v, t]) => ({ v, t })) };
}

async function marketplaceLatest(ids) {
  const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json;api-version=7.2-preview.1" },
    // Every version with its properties, not the latest only: that can be a
    // prerelease, and then the stable release isn't in the answer.
    body: JSON.stringify({ filters: [{ criteria: ids.map((value) => ({ filterType: 7, value })) }], flags: 0x1 | 0x10 }),
  });
  if (!res.ok) throw new Error(`Marketplace ${res.status}`);
  const out = {};
  for (const e of (await res.json()).results[0].extensions) out[`${e.publisher.publisherName}.${e.extensionName}`.toLowerCase()] = latestStable(e);
  return out;
}

const cmp = (a, b) => {
  const x = a.split(/[.-]/).map(Number);
  const y = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

// ------------------------------------------------------------------ helpers

/** `npm pack` a package version into a fresh directory and return its unpacked root. Never runs its scripts. */
function unpack(pkg, version) {
  const dir = fs.mkdtempSync(path.join(tmp, "pkg-"));
  const file = run(npm, ["pack", `${pkg}@${version}`, "--silent", "--ignore-scripts", "--pack-destination", dir]).trim().split("\n").pop();
  run("tar", ["-xzf", file], { cwd: dir });
  return path.join(dir, "package");
}

/** Top-level `export interface Name { … }` blocks of a generated .d.ts. */
function interfaces(dts) {
  const out = new Map();
  for (const m of dts.matchAll(/^export interface (\w+)[^{]*\{\n([\s\S]*?)^\}/gm)) out.set(m[1], m[2]);
  return out;
}
const fieldsOf = (body) => new Set([...(body ?? "").matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]));

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

// ------------------------------------------------------------------ contracts

/** Codex: the messages `codex-appserver.ts` sends, against the schema the CLI generates. */
function codexContract(version) {
  const out = path.join(tmp, "codex-schema");
  const home = path.join(tmp, "codex-home");
  fs.mkdirSync(home, { recursive: true });
  run(npm, ["exec", "--yes", "--ignore-scripts", `--package=@openai/codex@${version}`, "--", "codex", "app-server", "generate-json-schema", "--out", out], {
    env: { ...process.env, CODEX_HOME: home },
    timeout: 300_000,
  });
  const files = walk(out);
  const schema = (name) => {
    const f = files.find((x) => path.basename(x) === `${name}.json`);
    return f ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  };
  const problems = codexProblems(
    { request: schema("ClientRequest"), notification: schema("ClientNotification"), forkResponse: schema("ThreadForkResponse") },
    baseline.codex,
  );
  return { evidence: `schema generated by @openai/codex@${version} (stable surface)`, problems, notes: [] };
}

/** Copilot: the events and fields `copilot.ts` reads, in the SDK's generated session event types. */
function copilotContract(version) {
  const pkg = unpack("@github/copilot-sdk", version);
  const file = walk(pkg).find((f) => f.endsWith(path.join("generated", "session-events.d.ts")));
  if (!file) return { evidence: `@github/copilot-sdk@${version}`, problems: ["no generated/session-events.d.ts in the package"], notes: [] };
  const all = interfaces(fs.readFileSync(file, "utf8"));
  /** Persisted event types → their data interface. Ephemeral events never reach events.jsonl. */
  const events = new Map();
  for (const body of all.values()) {
    // An event: a dotted type, a time and a payload. Content blocks and
    // attachments also have a `type`.
    const type = /^ {4}type: "([a-z_]+\.[a-z_.]+)";/m.exec(body)?.[1];
    if (!type || !/^ {4}timestamp: string;/m.test(body) || !/^ {4}data: \w+;/m.test(body)) continue;
    if (/^ {4}ephemeral: true;/m.test(body)) continue;
    events.set(type, /^ {4}data: (\w+);/m.exec(body)?.[1]);
  }
  const problems = [];
  for (const [type, fields] of Object.entries(baseline.copilot.readEvents)) {
    if (!events.has(type)) {
      problems.push(`no persisted \`${type}\` event`);
      continue;
    }
    const have = fieldsOf(all.get(events.get(type)));
    for (const f of fields) if (!have.has(f)) problems.push(`\`${type}\` data has no \`${f}\``);
  }
  const req = fieldsOf(all.get("AssistantMessageToolRequest"));
  if (!req.has("name")) problems.push("an assistant tool request has no `name`");
  const known = new Set(baseline.copilot.persistedEvents);
  const added = [...events.keys()].filter((t) => !known.has(t)).sort();
  const gone = [...known].filter((t) => !events.has(t)).sort();
  const notes = [];
  if (added.length) notes.push(`New persisted event types since the baseline: ${added.map((t) => `\`${t}\``).join(", ")}`);
  if (gone.length) notes.push(`Event types no longer listed: ${gone.map((t) => `\`${t}\``).join(", ")}`);
  return { evidence: `generated types in @github/copilot-sdk@${version} (source level)`, problems, notes, attention: added.length + gone.length > 0 };
}

/** Claude: what the Agent SDK's transcript code still names, and the record types it writes. */
function claudeContract(version) {
  const pkg = unpack("@anthropic-ai/claude-agent-sdk", version);
  const src = fs.readFileSync(path.join(pkg, "sdk.mjs"), "utf8");
  const problems = baseline.claude.literals.filter((l) => !src.includes(l)).map((l) => `the SDK no longer names \`${l}\``);
  const parser = fs.readFileSync(path.join(root, "electron", "transcripts.ts"), "utf8");
  const knownBlock = /const KNOWN_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(parser)?.[1] ?? "";
  const known = new Set([...knownBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const written = new Set([...src.matchAll(/\{type:"([a-z][a-z-]+)",sessionId:/g)].map((m) => m[1]));
  const unknown = [...written].filter((t) => !known.has(t)).sort();
  const notes = unknown.length
    ? [`Record types the SDK writes that the parser's \`KNOWN_TYPES\` lacks (shown as unknown in the health row): ${unknown.map((t) => `\`${t}\``).join(", ")}`]
    : [];
  const fresh = unknown.filter((t) => !baseline.claude.unknownTypesSeen.includes(t));
  return { evidence: `string literals in @anthropic-ai/claude-agent-sdk@${version} sdk.mjs (source level)`, problems, notes, attention: fresh.length > 0 };
}

// ------------------------------------------------------------------ report

const lines = [`# Upstream watch — ${new Date().toISOString().slice(0, 10)}`, ""];

lines.push("## Releases since last review", "", "| Package | Reviewed | Latest | Stable releases since | Notes |", "|---|---|---|---|---|");
const latest = {};
const rows = [];
const market = await marketplaceLatest(Object.keys(baseline.extensions)).catch((e) => e);
for (const [pkg, info] of Object.entries(baseline.packages)) {
  if (!want(info.provider)) continue;
  rows.push(
    await releaseRow(`\`${pkg}\``, info, async () => {
      const r = await npmReleases(pkg);
      latest[pkg] = r.latest;
      const since = info.reviewed ? r.versions.filter((x) => cmp(x.v, info.reviewed) > 0).length : null;
      return { latest: r.latest, published: r.published, since, isNew: since > 0 };
    }),
  );
}
for (const [id, info] of Object.entries(baseline.extensions)) {
  if (!want(info.provider)) continue;
  rows.push(
    await releaseRow(`\`${id}\` (VS Code)`, info, async () => {
      if (market instanceof Error) throw market;
      if (!market[id]) throw new Error("no stable release on the Marketplace");
      return { ...market[id], since: null, isNew: !!info.reviewed && cmp(market[id].latest, info.reviewed) > 0 };
    }),
  );
}
for (const r of rows) {
  const found = r.state === "unknown" ? `⚠️ could not determine: ${r.error}` : `${r.latest} (${r.published.slice(0, 10)})`;
  lines.push(`| ${r.label} | ${r.info.reviewed ?? "never"} | ${found} | ${r.since ?? "—"} | [notes](${r.info.notes}) |`);
}

lines.push("", "## Contracts", "");
// Each contract, against the package it comes from at its latest release.
const checks = [
  ["codex", "Codex app-server fork", "@openai/codex", codexContract],
  ["copilot", "Copilot session events", "@github/copilot-sdk", copilotContract],
  ["claude", "Claude transcript and fork", "@anthropic-ai/claude-agent-sdk", claudeContract],
];
const contracts = [];
for (const [provider, title, pkg, check] of checks) {
  if (!want(provider)) continue;
  const r = await contractResult(async () => latest[pkg] ?? (await npmReleases(pkg)).latest, check);
  contracts.push(r);
  const unknown = r.unknown ?? [];
  lines.push(`### ${r.problems.length ? "❌" : unknown.length ? "⚠️" : "✅"} ${title}`, "", `Evidence: ${r.evidence}.`, "");
  for (const p of r.problems) lines.push(`- **Break:** ${p}`);
  for (const u of unknown) lines.push(`- **Could not determine:** ${u}`);
  for (const n of r.notes) lines.push(`- ${n}`);
  if (r.problems.length || unknown.length || r.notes.length) lines.push("");
}

const { attention, broken, incomplete, exitCode } = verdict(rows, contracts);
if (incomplete) lines.splice(2, 0, "**Incomplete.** Something below could not be determined, so this run says nothing about it. Run it again; if it persists, the lookup itself needs fixing.", "");

lines.push(
  "## What to do",
  "",
  "Read each package's release notes since its reviewed version for anything touching transcripts, rollouts, event logs, forks, resume or deep links, then bump `reviewed` in `scripts/upstream/baseline.json`. A contract break or a format change follows the upstream policy in `docs/upstream.md`: a sanitized fixture of the new shape first, then the parser.",
);

const report = lines.join("\n") + "\n";
const out = arg("report");
if (out) fs.writeFileSync(out, report);
else process.stdout.write(report);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `attention=${attention}\nbroken=${broken}\nincomplete=${incomplete}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(exitCode);
