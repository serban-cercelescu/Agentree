// What the Release workflow should do for this run (.github/workflows/release.yml):
//
//   release  a push to main changed package.json's version, and no tag or
//            release for it exists yet: draft one
//   dry-run  started by hand: rehearse, release nothing
//   none     anything else, e.g. a dependency update that touched
//            package.json but not the version
//
// Reads EVENT (the event name), BEFORE (the commit main was at before the
// push) and GITHUB_REPOSITORY; writes mode, version and tag to
// GITHUB_OUTPUT, or prints them.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { newer } from "./version.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const run = (cmd, a) => execFileSync(cmd, a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const exists = (cmd, a) => {
  try {
    run(cmd, a);
    return true;
  } catch {
    return false;
  }
};

const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const tag = `v${version}`;
const { EVENT, BEFORE, GITHUB_REPOSITORY: repo } = process.env;

function plan() {
  if (EVENT === "workflow_dispatch") return ["dry-run", "started by hand"];
  if (EVENT !== "push") return ["none", `not a push (${EVENT})`];
  let before = null;
  try {
    before = JSON.parse(run("git", ["show", `${BEFORE}:package.json`])).version;
  } catch {
    // A first push, or a before-commit this clone doesn't have: judge by the tag alone.
  }
  if (before === version) return ["none", `the version is still ${version}`];
  if (before && !newer(version, before)) throw new Error(`the version went from ${before} to ${version}; a release must be newer`);
  const tagged = repo
    ? exists("gh", ["api", `repos/${repo}/git/ref/tags/${tag}`])
    : exists("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
  if (tagged) return ["none", `tag ${tag} already exists`];
  if (repo && exists("gh", ["release", "view", tag, "--repo", repo])) return ["none", `a release ${tag} already exists`];
  return ["release", `the version went from ${before ?? "(unknown)"} to ${version}`];
}

const [mode, why] = plan();
console.log(`${mode}: ${why}`);
const out = `mode=${mode}\nversion=${version}\ntag=${tag}\n`;
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, out);
else process.stdout.write(out);
