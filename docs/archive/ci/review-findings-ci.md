# CI, releases and the upstream watch: first review — 2026-10-30

> **Historical review of the `ci` branch at `0700bd3`; resolved.** The original report follows the resolution below unchanged, except that its links to an account path now point into the repository. Its line numbers are to that revision. [Upstream compatibility](../../upstream.md) describes the current process.

<a id="resolution"></a>

> **Resolution (2026-10-30, same branch, after `0700bd3`).** Every finding had merit. Finding 1 was already fixed by `1267192`: the failing run predates that commit, and it had not been pushed. Three had a structural cause and were fixed there: findings 3 and 4 came from a watch whose judgements were tangled with its network calls and could only say pass or fail, and the `GH_TOKEN` suggestion is one case of installed code sharing a job with write access.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#ci-1) | None further. `1267192` writes the test's files, so each has its own creation time | Passes on Windows and Ubuntu locally. On GitHub, macOS and the rest of the matrix passed on `67932d1` |
> | [2](#ci-2) | `queue: max` on the Release workflow's concurrency, so every run waits instead of replacing the pending one ([documented](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax), up to 100 pending, first in first out) | Documentation read. Not run on GitHub |
> | [3](#ci-3) | A lookup now has three outcomes. Judgements moved to `scripts/upstream/check.mjs`: `releaseRow` and `verdict` keep "could not determine" apart from both "nothing new" and a break. It fails the run, so a report that can't be trusted doesn't look like a quiet week. A check that couldn't run is reported the same way, no longer as a break | `test/upstream.test.ts`. The reviewer's case end to end, with `fetch` rejecting: five `⚠️` rows, exit 1, `attention=true`, `broken=false`, `incomplete=true`. Exit 0 against the live registries |
> | [4](#ci-4) | The real messages, whole, are validated against the generated `ClientRequest` and `ClientNotification` schemas with Ajv, one branch per method. Generated objects leave `additionalProperties` open, so validation alone would pass a parameter Codex dropped; the check closes them. The messages moved to `baseline.json`, and `test/appserver.test.ts` holds them equal to what the client sends, so the sample can't drift from the code | Nine regression cases in `test/upstream.test.ts`. Six mutations of the real 0.162 schema are each reported, and the unmodified schema is clean. Live on 0.166.0: passes |
> | [5](#ci-5) | `@vscode/vsce` is a locked root development dependency, run from its installed binary. Locked at the 4.0.0 already verified, not 4.1.0: that was two days old, and `--before` kept the whole new subtree at least a week old, the rule Dependabot follows | `vsce package` on Windows and on Ubuntu, Node 22.15.0: 12 files, no engine warnings |
> | [6](#ci-6) | `npm exec --ignore-scripts --package=…` | A canary package's `postinstall` ran without the flag and not with it. Live run on 0.166.0 passes: that package declares no install scripts |
> | [7](#ci-7) | The check deletes the generated files and regenerates them, then fails on anything but a `.zst` whose bytes differ. Beyond the finding, this catches a stale file the generator no longer writes and a new `.zst`, which the old pathspec excluded even as an untracked file | The old check exits 0 on an uncommitted output (reproduced). All 63 generated fixtures regenerate with no differences. The status pipeline was rehearsed on a clone: clean, differing `.zst` passes, new `.zst` and stale file fail. The step, `rm` line included, passed on GitHub on `67932d1` |
> | [8](#ci-8) | The checkout is restored in `finally`, the commit stays on the release branch, and the failure says what's left: it leaves out the push when that already happened | `test/release.test.ts` runs the real script against a bare `origin` and a fake `gh`: success, push refused, pull request refused. All three fail on the old script. POSIX only, run on Ubuntu |
> | Process | Release pull requests carry a short **Evidence** section for the audit, canaries and watch | Same test |
> | Process | Packaging moved to a read-only job; the job with write access downloads the artifact and runs nothing installed. Narrowing `GH_TOKEN` alone wouldn't do: `id-token: write` puts its request token in every step's environment, `npm ci` included | Read and reasoned, not run on GitHub |
>
> **Superseded.** The workflow step in the fix for finding 7 became a test in the [third review](review-findings-ci-round-3.md#ci3-3): it still let a changed compressed transcript through.
>
> **Also changed.** Copilot's `reviewed: null` set `attention` on every run, permanently. Since the provider isn't modernized, a package with no reviewed version is now listed without asking for attention.
>
> **Left out as disproportionate.**
>
> - A separate lockfile for the packager. The root dependency adds 135 lockfile entries for one command, but `ajv` comes with it, and a second lockfile means more version places, Dependabot entries and README steps. Revisit if installs get slow.
> - Enforcing the Evidence section. It's a record for one maintainer, and nothing is published yet.
> - A separate job for the watch's `issues: write`. The same reasoning applies in principle, but that token can only touch issues, and vendor code there is one CLI printing its schema with scripts off.
> - Retries on lookups. Re-running a red run is enough at weekly cadence.
> - Copilot-specific hardening, beyond what the shared code gives it.
>
> **Open.** The owner turned issues on the same day, so the rolling issue carries the report; it has not run yet. A `reviewed` bump for Claude Code and Codex is still due; the live run lists 15 and 2 releases to read.

Findings ranked by severity.

<a id="ci-1"></a>

1. [P1] The new required matrix currently fails on macOS.
   [ci.yml (line 51)](../../../.github/workflows/ci.yml)
   The branch's GitHub run failed the Claude creation-order test on macOS/Node 24: it selected G3 as the root instead of P3. Packaging was consequently skipped and CI passed failed. This exposes an existing test/platform problem rather than a parser change introduced here. The test assumes spaced copyFileSync calls establish creation order; make that setup deterministic on macOS and rerun the matrix.

<a id="ci-2"></a>

2. [P2] Release concurrency can discard an approved release.
   [release.yml (line 27)](../../../.github/workflows/release.yml)
   cancel-in-progress: false preserves the running workflow, but the default concurrency behavior still replaces an older pending run. Suppose release A is running, version-bump B is pending, and dependency update C touches package.json: C cancels B, then its plan returns none because C did not change the version. B never produces its draft. Use queue: max or another arrangement that preserves each version-changing event. This follows GitHub's documented concurrency behavior.

<a id="ci-3"></a>

3. [P2] Failed upstream release lookups can produce a green, non-alerting watch.
   [watch.mjs (line 193)](../../../scripts/upstream/watch.mjs)
   Registry and Marketplace failures are written into the report without setting attention or failing the run. Contract checks can still succeed through npm's separate fetch/cache path. I reproduced five failed metadata lookups yielding exit code 0, attention=false and broken=false. The rolling issue would receive no update. Track lookup failures explicitly and distinguish "checked successfully" from "could not determine."

<a id="ci-4"></a>

4. [P2] The Codex contract check accepts incompatible request schemas.
   [watch.mjs (line 114)](../../../scripts/upstream/watch.mjs)
   The check mostly verifies property names. It does not validate the actual requests Agentree sends, and it ignores new required fields on InitializeParams itself. With controlled schemas, both a new mandatory initialization parameter and changing excludeTurns from boolean to string returned zero problems. Either would break Agentree's client. Validate representative initialization and fork requests against the generated schemas, with regression cases for incompatible changes.

<a id="ci-5"></a>

5. [P2] The release packager's dependency tree is outside the lockfile.
   [vscode-ext/package.json (line 52)](../../../vscode-ext/package.json)
   Pinning @vscode/vsce@4.0.0 fixes the top-level package, but npx installs it separately with dependencies resolved outside this repository's lockfile. Thus the release does not build "from the lockfile alone," and root Dependabot updates do not maintain this toolchain. Declare and lock the packager as a development dependency, then invoke its installed binary. npm documents this separate installation behavior.

<a id="ci-6"></a>

6. [P2] The Codex watch path does not enforce the promised installation-script restriction.
   [watch.mjs (line 101)](../../../scripts/upstream/watch.mjs)
   The SDK unpacking path passes --ignore-scripts; the Codex npx path does not. Consequently, installation scripts may execute before schema generation, despite the workflow and documentation promising that vendor installation scripts are disabled. Pass the restriction explicitly to this installation path as well. ignore-scripts is an explicit npm setting.

<a id="ci-7"></a>

7. [P2] The fixture consistency check misses newly generated, uncommitted files.
   [ci.yml (line 78)](../../../.github/workflows/ci.yml)
   git diff --exit-code checks tracked changes only. A contributor can add a new generator output, forget to commit the generated fixture, and this job still passes. The tests run in separate checkouts, so generation here does not repair their inputs. Check untracked outputs too, or generate into a temporary directory and compare complete file inventories and contents.

<a id="ci-8"></a>

8. [P3] Release preparation does not restore the original branch after push/PR failures.
   [prepare.mjs (line 75)](../../../scripts/release/prepare.mjs)
   Restoration is below the push and PR creation calls, outside a finally. A push rejection or gh pr create failure leaves the user on the release branch; retrying then refuses because that branch already exists. I reproduced the push-failure path with mocked commands. Restore the starting checkout in finally, preserve the prepared release commit, and print explicit recovery instructions.

The overall structure is appropriate: reusable CI, a stable aggregate check, release preparation through a PR, draft publication, and separate compatibility monitoring. The documentation also correctly distinguishes synthetic tests, SDK/source inspection and native execution.

For the process itself, I would add explicit real-store audit/native-canary evidence—or an explanation of outstanding gaps—to the generated release PR. I would also scope GH_TOKEN to the steps that require it; currently the write-capable release token is inherited by installation, build and packaging commands.
