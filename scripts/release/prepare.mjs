// Prepare a release as a pull request:
//
//   npm run release:prepare -- 0.3.0 [--no-push]
//
// From a clean working tree: fetch main, branch `release/v0.3.0` off
// origin/main, set the version in every place (version.mjs), check it,
// commit, push and open the pull request with a preview of the release
// notes. Merging the pull request is the decision to release: the Release
// workflow then drafts the release from that commit, and publishing the
// draft creates the tag. `--no-push` stops after the commit.
//
// It never touches the branch you're on: the release branch starts from
// origin/main, and you're switched back when it's done. If the push or the
// pull request fails you're switched back too, the commit stays on the
// release branch, and it says how to finish.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { disagreements, newer, SEMVER, setVersion } from "./version.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const next = args.find((a) => !a.startsWith("--"));
const push = !args.includes("--no-push");

const run = (cmd, a, opts = {}) =>
  execFileSync(cmd, a, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const git = (...a) => run("git", a);
const ok = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
function fail(msg) {
  console.error(`release:prepare: ${msg}`);
  process.exit(1);
}

if (!next || !SEMVER.test(next)) fail("give the new version as X.Y.Z, e.g. `npm run release:prepare -- 0.3.0`");
if (git("status", "--porcelain")) fail("the working tree has changes; commit or stash them first");

git("fetch", "origin", "main", "--tags");
const tag = `v${next}`;
const branch = `release/${tag}`;
const onMain = JSON.parse(git("show", "origin/main:package.json")).version;
if (!newer(next, onMain)) fail(`${next} is not newer than main's ${onMain}`);
if (ok(() => git("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`))) fail(`tag ${tag} already exists`);
if (ok(() => git("rev-parse", "--verify", "--quiet", `refs/heads/${branch}`))) fail(`branch ${branch} already exists locally`);
if (git("ls-remote", "--heads", "origin", branch)) fail(`branch ${branch} already exists on origin`);
if (push && !ok(() => run("gh", ["auth", "status"]))) fail("gh isn't signed in (or use --no-push)");
// The repository `origin` is, by name. Never gh's own guess: in a fork it
// picks the parent, and the pull request would go to the wrong repository.
const repo = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
if (push && !repo) fail("origin is not a GitHub repository (or use --no-push)");

const start = git("rev-parse", "--abbrev-ref", "HEAD");
/** Back to where you were: your branch, or the commit you had detached. */
const back = start === "HEAD" ? ["switch", "--detach", git("rev-parse", "HEAD")] : ["switch", start];
git("switch", "-c", branch, "origin/main");
try {
  const files = setVersion(root, next);
  const { wrong } = disagreements(root);
  if (wrong.length) throw new Error(`the version still disagrees: ${wrong.map(([l, v]) => `${l}: ${v}`).join(", ")}`);
  git("add", ...files);
  git("commit", "-m", `Release ${tag}`, "-m", `Sets the version to ${next} in ${files.join(", ")}.`);
  console.log(`Committed ${tag} on ${branch}: ${files.join(", ")}`);
} catch (e) {
  // Leave nothing behind: back to where you were, without the branch.
  git("reset", "--hard", "origin/main");
  git(...back);
  git("branch", "-D", branch);
  fail(e instanceof Error ? e.message : String(e));
}

let pushed = false;
let failure = null;
try {
  if (push) {
    git("push", "-u", "origin", branch);
    pushed = true;
    let notes = "";
    try {
      notes = run("gh", ["api", "-X", "POST", `repos/${repo}/releases/generate-notes`, "-f", `tag_name=${tag}`, "-f", `target_commitish=${branch}`, "--jq", ".body"]);
    } catch {
      notes = "_The notes preview could not be generated; the draft release will have them._";
    }
    const body = [
      `Sets the version to **${next}**.`,
      "",
      "Merging this is the decision to release. The Release workflow then runs CI again on the merge commit, packages the extension, and makes a **draft** release targeting it. Publishing the draft creates the tag; nothing goes to a marketplace.",
      "",
      "## Evidence",
      "",
      `What was actually checked for this release, or why it wasn't ([the layers](https://github.com/${repo}/blob/main/docs/upstream.md#the-layers)). CI's fixtures don't cover these:`,
      "",
      "- [ ] Real-store audit: versions seen, health rows, digests if a parser changed",
      "- [ ] Native canaries: fork and resume per agent, or which are outstanding",
      "- [ ] Upstream: the last watch run, and `reviewed` in `scripts/upstream/baseline.json`",
      "",
      "<details><summary>Release notes preview</summary>",
      "",
      notes,
      "",
      "</details>",
    ].join("\n");
    const url = run("gh", ["pr", "create", "--repo", repo, "--base", "main", "--head", branch, "--title", `Release ${tag}`, "--body", body]);
    console.log(`Opened ${url}`);
  }
} catch (e) {
  failure = e;
} finally {
  git(...back);
}

if (failure) {
  fail(
    [
      failure instanceof Error ? failure.message.trim() : String(failure),
      `You're back on ${start}. The release commit is kept on ${branch}. To finish:`,
      ...(pushed ? [] : [`  git push -u origin ${branch}`]),
      `  gh pr create --repo ${repo} --base main --head ${branch} --title "Release ${tag}" --fill`,
      `Or start over: git branch -D ${branch}${pushed ? ` && git push origin --delete ${branch}` : ""}`,
    ].join("\n"),
  );
}
console.log(push ? `Back on ${start}. Merge the pull request to release.` : `Back on ${start}. Push ${branch} and open a pull request to release.`);
