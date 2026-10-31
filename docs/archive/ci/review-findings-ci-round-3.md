# CI, releases and the upstream watch: third review — 2026-10-31

> **Historical record of three short passes after the [second review](review-findings-ci-round-2.md); resolved.** Their original findings follow the resolution below unchanged, except that links to an account path now point into the repository. Their line numbers are to revisions since squashed into the branch. [Upstream compatibility](../../upstream.md) describes the current process.

<a id="resolution"></a>

> **Resolution (2026-10-31, same branch).** Every finding had merit. The first two were weaknesses of the second review's check on a fork's response, shown with controlled schemas: no vendor release is known to show this drift.
>
> | | Fix | Check |
> |---|---|---|
> | [Sample](#ci3-1) | A request is Agentree's to choose, so a schema accepting a sample is enough. A response is Codex's, so a sample shows only what the schema can carry. `baseline.json` now states what the client needs: the usable types of each field it reads (`reads`) and the smallest answer it can work with (`least`). Each field must refuse every other type, what's in `least` must be required, and a `cwd` going is no break, since the client falls back. `forkThread` checks the same types at run time, where a numeric id would really have passed | On the real 0.162 schema, 12 breaks reported and 7 harmless changes clean. `test/appserver.test.ts` holds `least` to the real client; its bad-id and bad-`cwd` cases fail on the old client |
> | [Probes](#ci3-2) | One rejected value says nothing about its type while constraints remain: 12 of 14 incompatible changes passed. The type probes now run on `typesOnly(schema)`, with every constraint taken out, so one value stands for its type. Constraints only narrow, so this allows at least what the original does. `oneOf` counts matches, so it becomes "any of" | On the real schema, all 14 reported and 4 harmless changes clean. It errs only towards a false break, and a `$ref` it can't follow is "could not determine" (tested by moving the schema to `$defs`) |
> | [Fixtures](#ci3-3) | The workflow step's exception for `.zst` was the gap, and each round had adjusted it. It is now `test/fixtures.test.ts`: the generator writes to a temp directory and the trees are compared whole, compressed pages by content. It runs in `npm test` on every platform, and the docs job no longer needs `npm ci` | A generator change to a compressed transcript, a new compressed output and a stale file each fail it, on Ubuntu at Node 22.15.0. One page at two compression levels counts as equal |
> | [Strict checks](#ci3-4) | Recommended against: CI runs on each merge commit and a release reruns it there, so strict checks would prevent a failure that can't ship, while each merge puts every other pull request behind. **The owner adopted them anyway** the same day, in `main.json` and the live ruleset | Read back with `gh` as `true` for `main`. [Repository rules](../../upstream.md#repository-rules) has the rule and its cost |
>
> **Left out as disproportionate.** A static analysis of schema types, which would repeat what the validator knows. Reporting constraints as incomplete, which would turn a harmless `minLength` into a red run. Checks on anything but JSON type. More passes on this check: a schema is source-level evidence, and only a native fork (layer 6) shows what Codex really returns.

## Findings

<a id="ci3-1"></a>

[P2] Validating a response sample does not establish the guarantees the client needs.
[check.mjs (line 41)](../../../scripts/upstream/check.mjs)

responseProblems() establishes that the schema accepts the sample's string values. A schema can retain those values while also allowing incompatible responses.

Using the checked-in test schema, I reproduced:

| Schema change | Checker result | Consequence |
|---|---|---|
| Thread.id allows strings or integers | No problems | A numeric ID can pass through the client's truthiness check |
| Thread allows objects or null | No problems | The client cannot identify the created fork |
| Remove top-level cwd, retaining thread.cwd | Reports a break | The client's existing fallback still works |

The first two are false negatives; the third is unnecessarily strict. They come from treating response compatibility like request compatibility. A valid request sample establishes that the client can send it; a valid response sample does not establish what the server promises to return.

Check the response schema's guarantees for the fields the client consumes, including permitted types and requiredness, while respecting the cwd fallback. Add these cases alongside the existing response mutations. These reproductions establish a checker weakness; I have no evidence that a current vendor release exhibits this drift.

<a id="ci3-2"></a>

[P2] The Codex response check can still miss incompatible types.
[scripts/upstream/check.mjs (line 66)](../../../scripts/upstream/check.mjs)

responseProblems() tests one representative value per JSON type. Rejecting that value does not establish that the schema rejects the entire type.

I reproduced both cases below returning zero problems:

| Change to thread.id | Valid response the checker misses |
|---|---|
| Allow strings or integers with minimum: 2 | { "thread": { "id": 2 } } |
| Allow strings or arrays with minItems: 1 | { "thread": { "id": ["bad"] } } |

The probes are 1 and [], so neither exercises the newly permitted values. Consequently, the upstream watch can remain green despite a response-contract break.

Determine permitted types through schema references and composition, or report constructs the checker cannot establish as incomplete. Adding more sample values would leave the underlying gap. Add regression cases for constrained incompatible types.

This is a monitoring weakness demonstrated with controlled schemas; I found no evidence of a current vendor release exhibiting it. The new runtime validation correctly refuses these invalid ID

<a id="ci3-3"></a>

[P2] The fixture check accepts stale compressed transcript content.
[ci.yml (line 88)](../../../.github/workflows/ci.yml) filters out every modified .zst, including changes to its decompressed JSONL. I reproduced a generator change that altered the transcript while the workflow's filter returned no changes. Since tests run against committed fixtures in separate jobs, CI can remain green while exercising the old data. Compare decompressed contents, allowing compression-byte differences only. The current 63 fixtures do match their generator; this is a gap in future regression detection.

<a id="ci3-4"></a>

[main.json (line 24)](../../../.github/rulesets/main.json) permits checks against an older base. Concurrent PR merges can therefore introduce an integration failure onto main. Requiring branches to be current would strengthen that guarantee; the release workflow already rechecks its actual merge commit.
