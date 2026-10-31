# CI, releases and the upstream watch: second review — 2026-10-30

> **Historical review of the `ci` branch at `67932d1`; resolved.** The original report follows the resolution below unchanged, except that its links to an account path now point into the repository. Its line numbers are to that revision. [Upstream compatibility](../../upstream.md) describes the current process.

<a id="resolution"></a>

> **Resolution (2026-10-30, same branch, after `67932d1`).** All four findings and the documentation correction had merit. They are the first round's fixes stopping short: a third outcome that one code path still avoided, and a closed schema that only closed what it recognised. Finding 4 was worse than reported, and live: the query returned only a prerelease for `openai.chatgpt` that week, so `baseline.json` held the prerelease `26.51021.22027` as `reviewed`, with a note explaining it as a numbering quirk. The stable build is `26.1021.22027`. Prereleases are numbered above stable there, so correcting the code alone would have left every stable release below `reviewed`, and silent.
>
> | # | Fix | Check |
> |---|---|---|
> | [1](#ci2-1) | The `"latest"` fallback is gone. `contractResult` runs a contract only at a version the registry resolved, so evidence always names one, and a failed lookup takes the path a check that can't run already took. `npmReleases` also refuses an answer naming no latest version | Two cases in `test/upstream.test.ts`, the first failing without `contractResult`. The reviewer's case end to end, with only the SDK's metadata failing: exit 1, `incomplete=true`, `broken=false`, no `@latest` in the report |
> | [2](#ci2-2) | A sample of what Agentree reads (`codex.forkResponse` in `baseline.json`) goes through the same closed validator as the requests, so references are followed and types checked. Its `required` errors are ignored, since Codex's other required fields are none of Agentree's business, and `thread` and `thread.id` are separately confirmed as still promised. `cwd` is covered too: Agentree reads it, with a fallback | Regression cases in `test/upstream.test.ts`. On the real 0.162 schema: `thread` as a string with `Thread` unused, `Thread.id` as an integer, `id` dropped, `id` no longer required and `cwd` as an object are each reported; the unmodified schema is clean. Live on 0.166.0: passes |
> | [3](#ci2-3) | `closed()` applies to any object with named properties, whatever `additionalProperties` says. That also covers the schema-valued form, which the report didn't list. Free-form objects, which name nothing, stay open | Both forms in the tests and on the real schema |
> | [4](#ci2-4) | The query asks for every version (about 5 MB and a second, weekly, so simpler than a conditional second query). `latestStable` never returns a prerelease; an extension with no stable release is "could not determine". `reviewed` corrected, and the wrong note removed | Unit cases. End to end with a prerelease-only answer: the row is undetermined and the run red. Live: `openai.chatgpt` 26.1021.22027 |
> | Docs | `upstream.md` says the `main` ruleset is applied, and that what's live governs, not the files. `roadmap.md` and the first review's resolution now record CI passing on all three platforms | The live ruleset and PR #3's checks, read with `gh` |
>
> **Left out as disproportionate.** A schema-walking helper for the response: the validator already follows references. A second query for the Marketplace. A test tying `forkResponse` to the client: only a sample of what it reads, its fields are few, and such a test couldn't notice a new one. Counting Marketplace releases in the table.
>
> **Superseded.** The sample validation in the fix for finding 2 was replaced in the [third review](review-findings-ci-round-3.md): it asked the wrong question of a response.
>
> **Open.** The Marketplace's "versions come newest first" is relied on, not checked; VS Code relies on the same order.

Findings ranked by severity.

<a id="ci2-1"></a>

1. Failed SDK-version lookups still bypass the incomplete outcome.
   [watch.mjs (line 208)](../../../scripts/upstream/watch.mjs)
   The SDK metadata lookups still convert failures into "latest". Unlike the CLI and Marketplace rows, these failures never reach verdict.
   I reproduced a failed Agent SDK metadata lookup followed by successful package inspection yielding:
   exitCode=0
   attention=false
   broken=false
   incomplete=false
   Its evidence identified the package as @anthropic-ai/claude-agent-sdk@latest, without an actual version. Propagate this failure into the incomplete outcome and record the concrete package version inspected.

<a id="ci2-2"></a>

2. The fork-response check still accepts incompatible responses.
   [check.mjs (line 43)](../../../scripts/upstream/check.mjs)
   It checks that thread and definitions.Thread.properties.id exist, but does not establish that the response's thread uses that definition or that the consumed fields have compatible types.
   I reproduced both of these returning no problems:
   - Changing the response's thread to a string while retaining the unused Thread definition.
   - Changing Thread.id to an integer.
   Follow the response's actual references and verify the required thread.id path and its type. The request validation is stronger now; this response check remains a separate blind spot.

<a id="ci2-3"></a>

3. Explicitly open schemas bypass the dropped-parameter protection.
   [check.mjs (line 18)](../../../scripts/upstream/check.mjs)
   closed() overrides omitted additionalProperties, but preserves an explicit additionalProperties: true. Those forms are equivalent in JSON Schema, yet the stricter compatibility check treats them differently.
   Removing lastTurnId and explicitly allowing additional properties returned zero problems in my reproduction. That recreates the dropped-parameter failure the fix intends to catch. Apply the same policy to explicitly open objects, or check that sent keys remain declared separately from schema validation.

<a id="ci2-4"></a>

4. Marketplace prereleases can be reported as stable releases.
   [watch.mjs (line 58)](../../../scripts/upstream/watch.mjs)
   The query requests IncludeLatestVersionOnly. When the returned latest version is a prerelease, the stable-version search can find nothing, and ?? e.versions[0] then selects that prerelease anyway.
   I reproduced this with a prerelease-only response. This can produce misleading release alerts and leave the stable release unexamined. Request sufficient version history or fetch again when the latest is a prerelease—the VS Code gallery implementation handles that case explicitly.

The release process looks sound by inspection: packaging now has read-only permissions, the privileged job executes no repository-installed code, artifacts stay within the same workflow run, and preparation failures preserve the commit while restoring the checkout. The accepted omissions—manual evidence, no separate packager lockfile, and no lookup retries—remain reasonable for this workflow.

One documentation correction remains: [upstream.md (line 110)](../../upstream.md) says CI does not block merges. I checked the live ruleset; it actively requires CI passed.
