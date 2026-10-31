# CI, releases and the upstream watch: handover — 2026-10-29

> **Handover for the next agent on this track.** It records the state at the end of the work on branch `ci` (PR #3) and the stacked branch `day-view-round-6`: what exists, why it is shaped this way, the rules it must keep, what has and hasn't been verified, and what is left. It is a snapshot. Where it disagrees with the code, the code wins. [Upstream compatibility](../../upstream.md) is the current explanation of the process and owns it; [AGENTS.md](../../../AGENTS.md) governs how to work in this repository. Read both first.

## 1. Status in one screen

**What exists** (all on `ci`):

- **CI** (`.github/workflows/ci.yml`): typecheck, tests and both builds on Ubuntu and Windows × Node 22.15.0 and 24, and macOS × Node 24; Markdown links, one version everywhere, fixtures against their generator, whitespace; then the packaged `.vsix` as an artifact. One job, **`CI passed`**, succeeds only when every other job did. It is the check to require on `main`.
- **Releases through a release pull request.** `npm run release:prepare -- X.Y.Z` opens the pull request. Merging it makes `.github/workflows/release.yml` draft a GitHub release with the `.vsix`, `SHA256SUMS` and a provenance attestation. Publishing the draft creates the tag. Run by hand, the workflow is a dry run.
- **The upstream watch** (`.github/workflows/upstream.yml`, `scripts/upstream/`): weekly, releases of Claude Code, Codex and Copilot CLI since their last review, and contract checks against the latest release.
- **Dependabot**, grouped and with a seven-day cooldown, for npm and actions.
- **Rulesets** kept as files in `.github/rulesets/`.
- **[docs/upstream.md](../../upstream.md):** the research, the layers of defence, triage, the release procedure, supply chain, open decisions.

**Branches and GitHub**, as of 2026-10-29:

| | State |
|---|---|
| `ci` | `main` (`d3f1720`) + `36471d6` (CI, release, watch, docs) + `6d9247a` (release pull request flow) + `1267192` (macOS and issues fixes) + the commit adding this archive. **Only `6d9247a` is pushed**: `origin/ci` is at `6d9247a`; the last two commits are local |
| PR #3 | `ci` → `main`, open. Both its CI runs failed on macOS (§7.1, fixed in `1267192`, not yet run on GitHub) |
| `day-view-round-6` | One commit on top of `ci`: the day view's sixth review fix. Local only, no PR. **Merge after `ci`** (the owner's order); it's rebased on `ci` so it merges cleanly |
| Ruleset "Release tags" (id 26061281) | **Applied** 2026-10-28: only repository admins create, move or delete `v*` tags |
| Ruleset "Enforce CI Pass" (id 26045530) | On `main`: pull requests only, no force push or deletion, **no required status check**. `.github/rulesets/main.json` adds `CI passed`; **not applied** (§8) |
| Issues | **Turned off** in the repository; the watch reports in its run summary only (§7.3) |
| `gh` on the owner's machine | Two accounts. `Sadeeptha-B` (admin) has failed to log in at times; `sade_sitecore` (read-only here) is then active. Check `gh auth status` and `gh auth switch -u Sadeeptha-B` before any write |

Push, open pull requests, merge or apply rulesets only when the owner asks.

## 2. Owner decisions

Confirmed in this work; don't reopen them without the owner:

- **No Marketplace or Open VSX publishing** yet. Releases are draft GitHub releases. Revisit Copilot and confirm the publisher first ([upstream.md](../../upstream.md#releases-and-distribution)).
- **Copilot is best effort.** The owner hasn't revisited the provider since the fork; upstream has moved on (§7.4). Don't advertise it beyond that.
- **The release pull request flow**, chosen over manual tagging, release-please (needs Conventional Commits; this repository's messages are descriptive sentences), semantic-release (no human gate) and Changesets (too much ceremony for one maintainer).
- **Merge `ci` before `day-view-round-6`**, each self-contained: `ci` doesn't mention round 6; round 6 adds its own examples to `upstream.md` and its roadmap entry.
- **The Electron app is not packaged in CI** for now: no installer, its update check compares commits with `main`, and signing needs a decision ([upstream.md](../../upstream.md#releases-and-distribution)). A Linux desktop smoke test (xvfb plus the run-desktop driver) was suggested as the cheaper first step; not built.
- Existing, still binding: the Agent SDK is not bundled (AGENTS.md). Running its `forkSession` in the watch is an **open** decision, not done (§8).

## 3. The pieces

[How the pieces fit](../../upstream.md#how-the-pieces-fit) has the feature-level table. Files:

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | The checks. Also `workflow_call`ed by the release. Concurrency group includes the workflow name, so a release's CI never waits on or cancels the branch's |
| `.github/workflows/release.yml` | `plan` (`scripts/release/plan.mjs`) → `checks` (ci.yml) → `release` (package; dry run: artifact and notes preview; release: attest and draft). Triggers: push to `main` touching `package.json`, and `workflow_dispatch` |
| `.github/workflows/upstream.yml` | Mondays 06:17 UTC and on demand: `watch.mjs`, summary, rolling issue when issues exist |
| `.github/dependabot.yml` | npm and actions, weekly, grouped, `cooldown: default-days: 7` |
| `.github/rulesets/{release-tags,main}.json` | Ruleset bodies, applied by hand with `gh api` ([Repository rules](../../upstream.md#repository-rules)) |
| `scripts/check-links.mjs` | Relative Markdown links and `#anchors` (GitHub slugs, `<a id>`; `#L12` line anchors accepted) |
| `scripts/check-version.mjs` | Every place agrees with `package.json` (via `version.mjs`) |
| `scripts/release/version.mjs` | The version's places (`PLACES`): both manifests, the lockfile twice, the README install command. `readVersions`, `disagreements`, `setVersion` (edits only that field, keeps line endings, refuses a non-newer version or a tree that already disagrees, writes nothing on refusal) |
| `scripts/release/prepare.mjs` | `npm run release:prepare -- X.Y.Z [--no-push]` (§4) |
| `scripts/release/plan.mjs` | `release` / `dry-run` / `none` for a workflow run (§4) |
| `scripts/upstream/watch.mjs`, `baseline.json` | Releases since `reviewed`, and the three contract checks |
| `electron/version.ts` | `AGENTREE_VERSION`: package.json's version, defined at build time by both esbuild builds; `"dev"` from source. The Codex app-server `clientInfo` uses it |
| `build-vscode.mjs` | Also copies `LICENSE` into `vscode-ext/` (gitignored) so the `.vsix` ships it |
| `vscode-ext/package.json` | `package` script pins `@vscode/vsce@4.0.0` |
| `test/release.test.ts` | `version.mjs` on copies of the real files |

## 4. Rules to keep

**CI**

- CI never reads a real transcript and never runs a vendor tool. The only vendor code anywhere in Actions is in the watch: packages unpacked with `--ignore-scripts`, and the Codex CLI run only to print its own schema in a scratch `CODEX_HOME`.
- `CI passed` must `need` every job. A new job not added there doesn't gate merges.
- The Node floor, 22.15.0, is VS Code 1.101's bundled Node, which runs the extension's worker. Raise it only with `engines.vscode`.
- The fixture check excludes `*.zst`: zstd's output differs between Node versions (seen: 22.15.0 vs 26), and the tests read those pages anyway.
- Actions are pinned to commit SHAs with a version comment: checkout v7.0.1, setup-node v7.1.0, upload-artifact v7.0.2, attest-build-provenance v4.2.2. Dependabot proposes updates.
- Tokens are read-only except where needed: the release job (contents, id-token, attestations) and the watch's issue step (issues). Checkouts keep no credentials.

**Releases**

- `package.json` is the version's source; the code takes it at build time. Adding a place means adding it to `PLACES` and to the test's expected count.
- **No workflow creates a tag.** The draft holds none; publishing creates it as the person publishing, which the tag ruleset allows only for admins. Also, a tag created with a workflow's token wouldn't start other workflows, so tag-triggered designs silently do nothing.
- `plan.mjs` releases only when a push to `main` changed the version and no tag or release exists. A dependency update touching `package.json` gives `none`; a version that goes down fails the run. Drafts are invisible to the plan's read-only token, so the release step refuses to make a second draft for the same tag.
- With a pull-request-only `main` and squash or rebase merges, a tag made before merging would point at a commit that never lands. Tags come after the merge, from `main`.
- **Pin `gh` to this repository.** In this fork, `gh`'s default repository is the parent, `serban-cercelescu/Agentree`. `prepare.mjs` takes the repository from `origin`'s URL and passes `--repo`; the workflows set `GH_REPO`. Never let a `gh` write rely on its default.

**The watch**

- `reviewed` in `baseline.json` means "release notes read for format impact", not "verified". Verified facts and their versions belong in the design notes.
- A contract failure fails the run; new releases or new types only raise attention. Checks are source-level evidence (labels in [upstream.md](../../upstream.md#the-layers)); a green watch doesn't prove what's on disk.

## 5. The stacked branch: day-view-round-6

It resolves the day view's sixth review (its report, `docs/archive/day-view/review-findings-day-view-round-6.md`, exists on that branch only). In short:

- **The fix.** Activity maps carry records (`ActivityRecord {at, key}`), not bare times, so a fork's own work isn't mistaken for copied history when it ends at the same instant as different work of its parent. Claude keys: kind, time, message id, and per content block the tool call made or answered with its length and outcome; never a uuid. Copilot keys: kind, time and a payload digest without the session id the fork writer rewrites; never the event id. Since a key holds its time, keys can only find more own work than times did.
- **The real-store audit** that verified it found two things:
  - The first key crashed the Claude provider on a queued prompt made of content blocks (the type said text). Fixed, with a test.
  - Those block-shaped human mid-turn messages are **drawn nowhere** on Claude Code 2.1.289–2.1.311: 121 in 32 transcripts on the owner's machine, no health warning. Measured on copies: drawing them takes the affected transcripts from 474 to 618 turns and the store from 815 to 959, with no new branch points. They'd lengthen collapsed chains rather than clutter the tree; the day view gains a dot each. Not fixed: drawing them re-parents later turns, which weak identities follow, so it needs a fixture and an identity-compatibility check first. On the roadmap, on that branch.

## 6. Verification record

What was actually checked, kept apart by kind:

| Check | Where | Result |
|---|---|---|
| Full suite, typecheck, both builds, links, version, `git diff --check` | Windows, Node 26.3.0 | `ci` 197 tests; `day-view-round-6` 200 |
| The CI checks mirrored from a tree snapshot (`git archive` into WSL, `npm ci`, typecheck, tests, both builds, links, version, fixtures) | Ubuntu (WSL), Node 22.15.0 | Pass (196, 1 skipped as on `main`); only the `.zst` fixture differs, as excluded |
| CI on GitHub, PR #3 at `36471d6` and `6d9247a` | Actions | Ubuntu and Windows (both Nodes) and the docs job pass. macOS Node 24 failed one test (§7.1); macOS Node 22.15.0 never got a runner (§7.2). `1267192` addresses both; **not yet run** |
| `release:prepare` | Scratch clone with a local bare `origin` | Refuses a non-newer version, a malformed version, a dirty tree, an existing branch, a non-GitHub `origin` (before branching); `--no-push` makes a 5-line commit and returns you to your branch; a failure leaves no branch. **The push and `gh pr create` path was not run** |
| `plan.mjs` | The same clone | `release` on a version bump; `none` for the same version and an existing tag; `release` for an unknown before-commit (judged by the tag); `dry-run` by hand; failure when the version goes down |
| Upstream watch | Locally, against the live registries | All three contracts pass on Codex 0.165.0, Copilot SDK 1.0.28 and Agent SDK 0.3.312. Each check fails when its expectation is broken (injected) and the run exits 1 |
| Version in bundles | Built `dist-electron/worker.cjs`, `vscode-ext/dist/worker.cjs` | `"0.2.0"` in both |
| `.vsix` | `vsce@4.0.0 package` | Packages, LICENSE included, no warnings |
| Real-store audit (round 6) | Owner's stores, scratch Agentree home with copied `lineage.json` and `settings.json`, `AGENTREE_READ_ONLY_STORES=1` | Identical digests of every family's nodes and 90 days of day projections before and after the fix; listing time unchanged |

**Not verified:** the release and upstream workflows on GitHub, a dry run, a draft release, publishing under the tag ruleset, `CI passed` as a required check, the `cooldown` key accepted by Dependabot, macOS beyond the one failing test, and anything on a VS Code webview or native vendor resume.

## 7. Known issues and findings

1. **macOS creation times.** On macOS, Node's `copyFileSync` keeps the source's creation time. The test copying three fixtures a second apart saw them as one batch and fell back to title order. The test now writes the files, as a harness does (`1267192`). The product code is unchanged; a user restoring copied transcripts on macOS gets the "created together, direction ambiguous" behavior the design notes already describe.
2. **macOS runner capacity.** "The job was not acquired by Runner … Due to capacity constraints, jobs targeting macOS arm64 runners may experience longer queue times." Twice, for the second macOS job. Now one macOS job. If it recurs, `CI passed` fails with it once required; consider `continue-on-error` for macOS or dropping it from the required set, as an owner decision.
3. **Issues are off** in the repository. The watch's report lands in the run summary; nobody is notified. Turning issues on restores the rolling issue with no change.
4. **Copilot drift** (source: changelog and SDK types): native `/fork` since 1.0.45 (`/branch` since 1.0.64), conversation-only `/rewind` since 1.0.63/1.0.78, persisted `session.context_cleared` and `session.compaction_*`. The provider assumes forks only come from Agentree and draws one linear chain. `session.start.data.version` is a vendor format version the health row could report.
5. **Claude record types** the parser doesn't know, written by the Agent SDK 0.3.312 fork: `content-replacement`, `history-suppression`, `relocated`, `tools-used`; `tools-used` is already on disk (42 records). They show as unknown in the health row. `history-suppression` may affect what a transcript shows.
6. **Unverified claims recorded with that label** in `upstream.md`: Azure DevOps global PATs ending in December 2026, and federated Entra credentials failing for personal publishers (both third-party).
7. **The desktop update check** compares the build's commit with `main`, so it ignores releases. Packaging the desktop app would need a release-based check.

## 8. Next steps

In order, each when the owner asks:

1. Push `ci` (`1267192` and this archive). Check PR #3's CI: macOS should pass, and `CI passed` should be green.
2. Apply the `main` ruleset as the admin account, once `CI passed` exists: `gh api -X PUT repos/Sadeeptha-B/Agentree/rulesets/26045530 --input .github/rulesets/main.json`.
3. Merge PR #3. Merging changes `package.json` (the new script), so Release runs; its plan should say `none`. Worth confirming as the first live run of `plan.mjs`.
4. Rebase `day-view-round-6` on the merged `main` if needed, push, open its PR, merge.
5. Optionally a first release: `npm run release:prepare -- 0.3.0`, a dry run on `release/v0.3.0`, merge, publish the draft. This exercises the untested push, PR, draft and tag-ruleset paths.
6. Read the release notes the first watch run lists, and bump `reviewed` in `baseline.json` (Claude Code 2.1.296 → 2.1.312 and Codex 0.164.0 → 0.165.0 were unread at handover; Copilot never).

Open decisions are in [upstream.md](../../upstream.md#open-decisions): a scripted `npm run audit:stores` with a shape survey, a health counter for known types with new shapes, running the Agent SDK's fork writer in the watch, gating forks by verified version, revisiting Copilot, and publishing.

## 9. Working notes

- **Line endings.** The Windows working tree is CRLF (`core.autocrlf=true`); the repository stores LF. `sed -i` and Python's default text mode rewrite files as LF. Use the Edit tool, or read and write with `newline=""` and keep `\r\n`. Bash heredocs passed to Python eat backslashes (Windows paths).
- **Linux check without CI.** `git write-tree` with a temporary `GIT_INDEX_FILE` snapshots the working tree without touching the real index. From WSL, `git --git-dir=/mnt/c/…/.git archive <tree>` extracts it with LF endings, and a Node 22.15.0 tarball in the WSL home runs the checks.
- **Rehearsing release scripts.** A scratch clone of a bare repository (`symbolic-ref HEAD refs/heads/main` first) gives a safe `origin`; `--no-push` stops before GitHub.
- **Real-store audits.** Copy `~/.agentree/lineage.json` and `settings.json` into the scratch Agentree home, or Copilot families and custom roots disappear. Print counts, types and digests only.
- **Vendor code.** Downloading and reading vendor packages is fine; executing them locally (beyond the installed Codex CLI) was refused by the session's safety checks. CI is where the watch runs them.
- `npm run release:prepare` needs `--` before the version.
