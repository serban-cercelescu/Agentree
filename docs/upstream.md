# Upstream compatibility, CI and releases

How Agentree keeps up with the agents it reads, what runs in CI, and how a release is made. Written 2026-10-28. The [design notes](design.md) keep each provider's format evidence; [AGENTS.md](../AGENTS.md) keeps the working rules; this file owns the process around them. Evidence labels follow the design notes: **verified** (observed on real data or a running tool), **source** (read from vendor code or notes, not executed), **tested** (synthetic fixtures), and unverified.

## Why this needs a process

Agentree reads internal, undocumented stores of three tools that release almost daily. Between 2026-10-22 and 2026-10-28 the npm registry shows Claude Code 2.1.308 → 2.1.312, Codex 0.164.0 → 0.165.0 and Copilot CLI 1.0.104 → 1.0.105, each with prereleases in between. None of them promises a stable transcript format. Anthropic and GitHub don't document theirs at all, and Codex's rollout files have no published schema. A user's disk also holds every version at once: rollouts on the reference machine span Codex 0.145–0.164. So Agentree can't pin a version. It must read what's there, notice what it doesn't understand, and change before users find out.

Two things make the risk asymmetric:

- **Reads fail quietly.** A record of a known type with a new shape parses without error and simply draws less. The [health row](design.md#fail-loudly) catches unreadable files, unknown record types and conversation records that yield nothing. It can't see a record it skips on purpose, and a field whose shape changed under a known type is skipped exactly like one.
- **Writes are irreversible.** Claude and Copilot forks write files in the vendor's format, and the vendor's own tools resume them. A format drift there produces a session the agent misreads, not just a wrong picture.

## What Agentree depends on

| Agent | Surface | Contract source | Strength |
|---|---|---|---|
| Claude Code | JSONL transcripts, `uuid`/`parentUuid`/`logicalParentUuid`, `promptId`, `message.id`, `compact_boundary`, `queued_command` | none published; the [Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) ships a JS transcript reader and `forkSession` writer, released in step with the CLI (0.3.312 ↔ 2.1.312) | source |
| | Fork format (`claude-fork.ts`) | the extension's `forkSession` (2.1.310), and the SDK's | source, verified on 4 real pairs |
| | `claude --resume`, `claude-vscode.editor.open` | [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) | unverified per release |
| Codex | Rollout pages (`.jsonl`, `.jsonl.zst`), `history_base`, item vocabulary | open source (`openai/codex`), no schema | verified on 286 rollouts, 0.145–0.164 |
| | `codex app-server` `initialize`, `thread/fork` | `codex app-server generate-json-schema` (stable vs experimental surface) | source per release; executed by hand on 0.162/0.164 |
| | `codex resume`, `vscode://openai.chatgpt/local/<id>` | [releases](https://github.com/openai/codex/releases) | unverified per release |
| Copilot CLI | `events.jsonl`, `workspace.yaml` | the [Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk)'s generated session event types; `session.start` carries a format `version` | source |
| | `copilot --resume=<id>` | [changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) | unverified on current versions |

### Copilot is behind

The Copilot provider hasn't been revisited since the fork's modernization. The design notes call it untested on current versions. Since then Copilot CLI has gained what the provider assumes doesn't exist (**source**, changelog):

- **Native forks.** `/fork` since 1.0.45 (2026-05-11), with the origin shown in the sessions dialog since 1.0.47, and `/branch` as an alias since 1.0.64. Agentree links Copilot families only through its own lineage sidecar, so a native fork is likely drawn as an unrelated session.
- **Rewind.** `/rewind` can rewind the conversation only, without git, since 1.0.63/1.0.78. The SDK marks `session.snapshot_rewind` ephemeral, so how a rewind looks on disk is unknown. The provider draws one linear chain.
- **Session events.** `session.context_cleared`, `session.compaction_*`, `session.truncation` and `session.handoff` are persisted (SDK 1.0.28). None is modeled.

Until it is revisited, treat Copilot support as best effort, and don't advertise it beyond that.

## The layers

Each layer catches what the one before it can't. Layers 1 and 2 existed before this file; 3 and 4 are new; 5 and 6 are manual.

1. **Tolerant parsing, failing loudly.** Unknown record types are counted, not fatal; files that should have been sessions and aren't are counted as failed; a provider that throws is guarded and its row says so. Keep it that way. A field read for a secondary feature must never take a provider down. Read shapes as found, not as typed: a field a type declares as text can arrive as an array.
2. **Fixtures before parser changes** ([AGENTS.md](../AGENTS.md#commands-and-verification)): a sanitized synthetic fixture of the new shape, with exact ancestry, endpoints and action targets asserted.
3. **CI** (`.github/workflows/ci.yml`). On every push and pull request: `npm ci` (which builds the Electron app), typecheck, tests and the extension build on Ubuntu and Windows on Node 22.15.0 and 24, and on macOS on 24 (its runners are scarce). The tests hold the committed fixtures equal to their generator: whole trees, so an output nobody committed and a stale file both show, and compressed pages by what they hold, since zstd's bytes differ between Node versions. 22.15.0 is the floor: VS Code 1.101's bundled Node, which runs the extension's worker. Then: relative Markdown links and anchors (`scripts/check-links.mjs`), one version everywhere (`scripts/check-version.mjs`), whitespace errors in a pull request's change, and the packaged `.vsix` as an artifact. CI never sees a real transcript and runs no vendor tool.
4. **The upstream watch** (`.github/workflows/upstream.yml`, `scripts/upstream/watch.mjs`, weekly and on demand). It lists stable releases since each package's `reviewed` version in `scripts/upstream/baseline.json`, and checks the latest release against what Agentree relies on:
   - **Codex:** the CLI generates its own protocol schema. The stable surface must accept the `initialize`, `initialized` and `thread/fork` messages Agentree sends, validated whole and refusing any field the schema doesn't name, so a new required field, a changed type and a dropped parameter all show. The messages live in `baseline.json`, and a test holds them equal to what the client sends. A response is checked the other way round, by what it guarantees rather than what it can carry: `thread` and `thread.id` must stay required, and each field Agentree reads must refuse every type the client can't use. The fallbacks count, so losing a `cwd` is no break, and neither are Codex's other required fields. `baseline.json` states these needs, and a test holds the smallest answer to what the client accepts. The client checks the same types at run time, since a schema only says what Codex means to send.
   - **Copilot:** in the SDK's generated event types, the persisted events and payload fields the provider reads must exist. New or removed persisted event types are listed.
   - **Claude:** the Agent SDK's transcript code must still name the fields the parser follows. Record types it writes that `KNOWN_TYPES` lacks are listed (on 0.3.312: `content-replacement`, `history-suppression`, `relocated`, `tools-used`; `tools-used` is already in 42 records on this machine).

   Vendor packages are fetched with install scripts off; only the Codex CLI runs, to print its schema, in a scratch `CODEX_HOME`. A broken contract fails the run. So does anything the run could not determine, a failed lookup or a check that couldn't run: it is reported as that, apart from a break, and never reads as "nothing new". A contract runs only at a version the registry resolved, so its evidence names what was inspected. Marketplace extensions are compared by their latest stable release, never a prerelease, as on npm. Releases or new types alone update one rolling issue labelled `upstream`; a run with nothing to report leaves it alone. A package with no `reviewed` version (Copilot, until it's revisited) is listed without asking for attention. A green watch is weak evidence. It says the SDKs and schema still describe what Agentree reads, not that the CLI writes it to disk the same way. Rollouts and the extension's own fork format have no machine-readable contract at all.
5. **A read-only audit of real stores** (manual: before a release, after reviewing upstream releases, and around any parser change). Proposed as `npm run audit:stores`. By hand:
   - Point `AGENTREE_HOME` at a scratch directory holding a copy of `lineage.json` and `settings.json` (Copilot families and custom roots come from them), and set `AGENTREE_READ_ONLY_STORES=1`.
   - Record per provider: health rows, failed files, unknown types, CLI versions seen.
   - For a parser change, digest every family's nodes (ids, parents, times, holders, occurrences, identities) and N days of day projections, before and after. Identical digests mean no behavior change on real data. Any difference must be one the change intends.
   - Survey shapes, not just types: for each record type the parser reads, the JSON type of each field it reads. A field that is sometimes an array is exactly the drift above. Print counts and types only, never text.
6. **Native canaries** (manual, disposable homes; the [roadmap](roadmap.md) lists the open ones): a real Codex fork and resume, resuming Claude and Copilot forks, deep links. Only these show that a write still works with the vendor's runtime.

## How the pieces fit

| Piece | Runs when | Does | Result |
|---|---|---|---|
| `ci.yml` | every push to `main`, every pull request, on demand, and inside a release | `npm ci` (builds the app), typecheck, tests, extension build on 3 OSes (2 Nodes on Ubuntu and Windows); then `check-links.mjs`, `check-version.mjs`, whitespace; then `vsce package` | a red or green check; a `.vsix` artifact kept 14 days |
| `release:prepare` | by you, to start a release | sets the version everywhere on a `release/vX.Y.Z` branch and opens the pull request | a release pull request |
| `release.yml` | a push to `main` that changes the version; or by hand, as a dry run | `plan.mjs`, then `ci.yml` in full; a read-only job checks the version, packages and checksums; a separate job with write access, which runs nothing installed, adds provenance and the draft | a draft release, whose publishing creates the tag; a dry run keeps the package and previews the notes |
| `.github/rulesets/` | applied once by an admin (below) | `main` takes changes only through pull requests that pass `CI passed`; only admins create, move or delete `v*` tags | releases only come from checked merges, and only admins finish them |
| `upstream.yml` | Mondays, and on demand | `watch.mjs` against `baseline.json` | the run's summary; one rolling `upstream` issue when there's something to report; a red run when a contract breaks or something could not be determined |
| `dependabot.yml` | weekly | proposes grouped npm and action updates, each at least a week old | pull requests, which `ci.yml` checks |
| The real-store audit | by hand (layer 5) | health, versions, digests and shapes from your own stores | evidence for a parser change or a `reviewed` bump |

They meet at `baseline.json`. The watch says what changed upstream. A person reads those release notes, runs the audit when a format might have moved, fixes with a fixture first, which CI then holds, and bumps `reviewed`. The next watch counts from there.

## When an upstream change lands

| What the watch or audit shows | Severity | Response |
|---|---|---|
| A provider crashes or most files fail | outage | Fix within days. A fixture of the new shape, then the parser; a patch release |
| Records of a known type stop drawing (shape changed) | silent wrong tree | As above. Add a health counter for that shape so it can't be silent again |
| A fork-format or `thread/fork` contract break | unsafe writes | Refuse the write for affected sessions first (the fork refusal paths exist), then adapt |
| New record or event types | noise or a new feature | Decide: bookkeeping (add to the known set) or content (model it). Note it in the design notes with its version |
| New vendor branching (native forks, rewinds) | missing structure | A design decision, not a patch. Record evidence first |

Rules that follow from how stores age:

- **Branch on shape, never on version number.** Old files stay on disk for years. Support a new shape beside the old one; drop an old one only when no supported vendor version can have written it, and even then keep reading it.
- **Every claim carries its version and label.** Bump `reviewed` in the baseline only after reading the release notes for transcript, rollout, event-log, fork, resume or deep-link changes. Record what was verified, and at which version, in the design notes.
- **Gate writes, not reads** (proposed). A fork writes the vendor's format with the vendor's assumptions of the version it was verified against. When the source session was written by a newer major/minor than the newest verified for that write path, the panel could say so before the fork, or refuse it. Reads stay permissive.

Release notes since the last review hold examples of each kind (Claude Code, **source**): 2.1.309 fixed tool previews cut through an emoji "leaving session transcripts that `jq` could not parse" (a bad line); 2.1.311 fixed SDK sessions "saving transcript messages out of order or keeping messages that were taken back" (ordering and rewinds), and corrected the rewind confirmation: a rewind removes the later messages from the conversation rather than forking it. How each lands in the file is what a fixture would pin down.

## Releases and distribution

Releases go through a **release pull request**: the mechanics are scripted, and the one decision, whether to release, is merging it. Publishing the draft is a second, final look.

1. From a clean working tree on any branch: `npm run release:prepare -- 0.3.0`. It fetches `main`, branches `release/v0.3.0` off `origin/main`, sets the version in every place (`scripts/release/version.mjs`: both package manifests, the lockfile and the README's install command; the code takes it from `package.json` at build time), checks them, commits, pushes, and opens the pull request on `origin`'s repository (never the parent this fork came from) with a preview of the release notes. It refuses a version that isn't newer than `main`'s, a dirty tree, or a tag or branch that already exists, and returns you to the branch you were on, also when the push or the pull request fails: the commit stays on the release branch and it prints how to finish. `--no-push` stops after the commit.
2. Optionally rehearse: Actions → Release → Run workflow on the release branch. The dry run runs every check, keeps the `.vsix` and checksum as an artifact for a week, and previews the release notes. It attests nothing and creates no release.
3. Fill in the pull request's **Evidence** section: what was checked for this release beyond CI (layers 5 and 6, the last watch), or why it wasn't. It's a record, not a gate. Then merge once `CI passed` is green on a branch up to date with `main`. That is the decision to release.
4. The merge changes `package.json`'s version on `main`, so `.github/workflows/release.yml` runs (`scripts/release/plan.mjs` decides: a dependency update that leaves the version alone releases nothing, and a version that goes down fails). Runs wait in a queue, so a later push can't cancel a pending release. It runs CI again on the merge commit, packages the extension with the lockfile's `@vscode/vsce` in a read-only job, then a separate job attests its provenance and creates a **draft** release targeting that commit, with the `.vsix` and `SHA256SUMS`.
5. Read the draft and publish it. Publishing creates the tag `v0.3.0` at the merge commit, as you: a draft holds no tag, and no workflow ever creates one.

Nothing else releases: an ordinary merge leaves the version alone, and every push to `main` still leaves a `.vsix` artifact for testing. The `.vsix` includes the MIT `LICENSE`.

### Repository rules

Two rulesets live in `.github/rulesets/` so they can be reviewed and reapplied. GitHub doesn't read them from there: an admin applies them with the API, as the owner account (`gh auth switch` to it first).

- `release-tags.json` (applied 2026-10-28): only repository admins may create, move or delete `v*` tags. Publishing a draft creates its tag as the person publishing, so only an admin can complete a release, and a published tag keeps pointing at what it released.
  `gh api -X POST repos/Sadeeptha-B/Agentree/rulesets --input .github/rulesets/release-tags.json`
- `main.json` (applied 2026-10-28): the "Enforce CI Pass" ruleset: pull requests only, no force push or deletion, and `CI passed` as a required check. That check is one job that passes only when every CI job did, so the matrix can change without editing the rule.
  `gh api -X PUT repos/Sadeeptha-B/Agentree/rulesets/26045530 --input .github/rulesets/main.json`

What applies is what's live, not these files: check with `gh api repos/Sadeeptha-B/Agentree/rulesets`.

The required check also demands a branch up to date with `main` (`strict_required_status_checks_policy: true`, since 2026-10-31), so two pull requests that pass apart can't fail together on `main`. The cost is that each merge puts every other open pull request behind: update it and wait for CI again before merging, so Dependabot's are merged one at a time. If that wait gets in the way, a merge queue is the better answer.

There is no Marketplace or Open VSX publishing, by the owner's decision (2026-10-28). Before that changes:

- Revisit the Copilot provider (above), or scope the listing to Claude Code and Codex.
- Confirm the `sadeeptha-b` publisher. Publish with Microsoft Entra ID (`vsce publish --azure-credential`) rather than a long-lived PAT, and test it end to end first. Third-party reports say federated service principals can fail with personal accounts, and that Azure DevOps global PATs end in December 2026; neither is verified here.
- Consider Open VSX as well: `findCodex` already looks in Cursor's and Windsurf's extension folders, and those editors install from Open VSX.
- Use the Marketplace pre-release channel to ship compatibility fixes ahead of a stable release.
- The desktop app has no installer yet. Its launch update check compares the build's commit with `main`, not with releases, so desktop users see fixes on merge, not on release.

## Supply chain and privacy

- Actions are pinned to commit SHAs; Dependabot proposes grouped updates for npm and actions after a seven-day cooldown. Every job's token is read-only unless it needs more (the release: contents and attestations; the watch: issues). A job with release write access runs nothing installed: permissions reach every step of a job, and `id-token: write` puts its request token in each step's environment, so packaging is a read-only job of its own. Checkouts don't keep credentials.
- `npm ci` installs from the lockfile, the packager included; CI skips Electron's binary download. The watch fetches vendor packages at run time; none is vendored or redistributed. Running the Agent SDK's own fork writer as a canary in CI would be a stronger Claude contract check. It is not done: it executes vendor code beyond printing a schema, and the SDK is deliberately not part of Agentree. That is the owner's call.
- No real transcript enters CI, an issue or a report. Audits print counts, types, versions and digests. The link check found committed links pointing at an account path under `C:/Users/…` in two archived reviews; they now point into the repository. The modernization handoff named the same path, and a project folder derived from it, as text; both are now generic.

## Open decisions

- Whether to build `npm run audit:stores` (layer 5) and a shape counter in the health row (layer 1).
- Whether to run the Agent SDK's `forkSession` against fixtures in the watch.
- Whether to gate forks by verified version.
- When to revisit Copilot, and whether to publish before then.
