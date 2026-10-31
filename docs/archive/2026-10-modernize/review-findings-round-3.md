# Full modernization review, round 3 — 2026-10-27

> **Historical review, `58cf671..b400dbd`; resolved.** The original report follows the resolution below unchanged; its line references are to `b400dbd`. Current contracts are in the [design notes](../../design.md), remaining work in the [roadmap](../../roadmap.md).

<a id="resolution"></a>

> **Resolution (2026-10-27, same branch, after `f1ed0b9`).** All eight
> findings had merit; each was reproduced by a regression test that fails
> on the pre-fix code and passes after it. Findings 2 and 3 were fixed
> together at the model boundary, as the architecture assessment advised:
> a node now records **membership** (`heldBy`: every member whose history
> holds all of it) apart from canonical ownership, the display merge never
> folds across a member's endpoint, and member focus is renderer view state.
> Findings 1 and 7 were one persistence change: identity scheme 3, with a
> written compatibility path for scheme 2's keys. Owner-confirmed decisions
> (raw Codex reads, app-server-only Codex forks, the reimplemented Claude
> fork, no SDK) stand.
>
> | # | Fix | Test |
> |---|---|---|
> | 1 | Text identities digest the exact parsed text (`electron/identity.ts`); stitching keys too. Annotations saved under the folded digest are found through `legacyIds` and carried forward; a folded key two nodes now claim is given to neither. Matching a queued message within one transcript keeps whitespace folding, documented as a dedup, not an identity | claude: indentation-only prompt pair; scheme-2 keys incl. ambiguous; identity: text-keyed stitching |
> | 2 | `mergeSameRoleRuns` continues a run only into a part held by the same sessions (`copyHolders`), so a merged node's holders hold all of it; tips come from `heldBy` for every provider (`assignTips`) | claude: quiet forks ending between two assistant and two user records; tip, `heldBy`, and the fork at that endpoint |
> | 3 | Store keeps `focus`; Open/Resume use `actionTarget` (focused member where it holds the node, else the owner); a selector on shared nodes changes focus; focus survives selection and reload while a member | store: action payload across selection/reload, focus dropped when the member leaves; claude: target on real provider output |
> | 4 | `applyAnnotations` fills every member sidecar lacking an entry for a shown annotation (new members, older-scheme hits); never overwrites, never copies absence, writes nothing once sidecars agree | claude: label made before its fork, original deleted; no write on a settled load |
> | 5 | `logicalRecords` deduplicates conversation by uuid but reduces `custom-title`/`ai-title`/`summary` across every copy (shadows included) in file-write order | claude: rename in a contained copy; diverged copy renamed before its first new uuid |
> | 6 | `Provider.watchTargets`; the registry asks only enabled providers (the owner for a session, each guarded for the list) | registry: disabled provider's discovery never invoked |
> | 7 | Weak keys are `w:` + 24 hex of SHA-1 over `[key, parentIdentity]`; scheme-2 literals are matched by folding them to the same form (`scheme2Fingerprint`), never rebuilt | identity: linear size, copies agree, same text under another parent distinct |
> | 8 | Disabling cancels a pending save, a firing save rechecks, `validate` keeps no `view` while `rememberView` is off, and settings responses older than the latest request are dropped | store: off inside the debounce; out-of-order response. settings: late view write |
>
> Verification: 101 tests in 12 files (81 before), typecheck and both
> production builds pass; host bundles still contain no provider code. A
> read-only audit of the owner's real stores (scratch Agentree home) found the
> same 154 families (61 Claude, 87 Codex, 5 Copilot; 20 multi-member) and
> 1,510 nodes as before the change, with identical members, roots, branch
> points, titles and member tips, no duplicate ids, dangling parents or
> cycles, and unchanged scan times (~5.5 s cold, ~30 ms warm). The longest
> semantic id fell from 945 to 91 characters. No saved annotations existed
> there, so the scheme-2 migration is covered by fixtures only. Not done: a
> rendered UI check of the new member selector, or any native resume.

Reviewed **`58cf671..b400dbd`**, including the roadmap implementation and follow-up commits: 119 changed files, not just the commits since the previous review. Read alongside `AGENTS.md`, `CLAUDE.md`, README, the user guide, both handoffs, roadmap, previous findings and their resolution notes.

The architecture fits the product: a local viewer, a shared renderer, provider-specific reconstruction in a backend worker, and native hand-offs. The new identity fields and roadmap work are substantial improvements. **I would still hold the merge for findings 1 and 2:** both can display a different history from the one a fork actually contains. The remaining findings concern member selection, annotation durability, moved-session metadata, settings isolation and scalability.

No application implementation was changed. Review reproductions used isolated temporary stores and mocked renderer APIs; the real-store audit used a temporary Agentree home. No original harness transcript or database was written, no real fork was requested, and no model generation was invoked.

## Verification and its limits

| Check | Result at reviewed HEAD |
|---|---|
| Existing tests | 81/81 pass, across 11 files |
| Typecheck | Pass, including the extension |
| Production builds | Electron and VS Code both pass, including workers |
| Focused review reproductions | Eight pass while asserting the undesired behavior described below; these are evidence of defects, not passing regression coverage |
| Built VS Code worker, real stores | 153 families: 61 Claude, 87 Codex, 5 Copilot; 20 multi-member families |
| Structural audit of those families | 1,496 displayed nodes; no duplicate node IDs, dangling parents or cycles; no provider reports a failed parse |
| Worker timing | About 2,865 ms cold / 17 ms warm; a host 50 ms interval fired 51 times during the cold scan |
| Full diff whitespace check | Reports CRLF-related trailing whitespace throughout `test/fixtures/make-fixtures.mjs`; the old conflict-marker issue has been removed |

A structurally valid tree can still hide a prompt, overstate a member's history, or target the wrong session. The eight reproductions test those semantics beyond the structural audit. The temporary reproduction files were removed after the review; each case below states its setup, observation and acceptance condition.

This pass did not visually drive VS Code or Electron, resume a real compacted/tool-ending Claude fork, or repeat native deep-link canaries. The existing evidence labels for those paths should remain. A successful build or fixture fork is not evidence of successful vendor resume behavior. I did not perform a dependency vulnerability audit or verify Linux/macOS terminal behavior on those operating systems.

## Findings

<a id="r3-1"></a>

### 1. [P1] Whitespace normalization still merges semantically different prompts

Location: [stitch.ts:45](../../../electron/providers/stitch.ts#L45), used by Claude prompt matching and text-based identities.

`digest()` replaces every whitespace run with one space. Whole-text hashing fixed the shared-preamble bug, but it still equates code whose indentation or line boundaries change its meaning. This is a deterministic normalization collision, unrelated to the cryptographic hash's collision probability.

**Reproduction:** two Claude family members share an initial assistant message. After that prefix, each has an older-format prompt without `promptId`, followed by its own distinct assistant reply. One prompt contains:

```python
if ready:
    send()
cancel()
```

The other indents `cancel()` inside the `if`. Their digests are identical. The loaded family drops the second prompt and attaches “Conditional cancel” to the first prompt. Both prompts are valid supported input, and their text was preserved by the parser before matching.

**Fix direction:** preserve meaningful whitespace in match keys. Any normalization should be explicitly justified by the vendor's copy behavior; generic whitespace folding is too broad. Since this digest also participates in persisted annotation identities, change the identity scheme with a compatibility/migration path. Accept when both prompts survive under the shared prefix with their own replies, while exact copied prompts still stitch.

<a id="r3-2"></a>

### 2. [P1] A quiet fork's endpoint can be merged together with later parent-only history

Locations: [transcripts.ts:324](../../../electron/transcripts.ts#L324), [transcripts.ts:374](../../../electron/transcripts.ts#L374), [transcripts.ts:1471](../../../electron/transcripts.ts#L1471), [render.ts:87](../../../shared/render.ts#L87).

The same-role merge unions occurrences from all its parts. `holdsCopy(member)` then treats an occurrence of **any part** as evidence that the member holds the **whole display group**. Member endpoints are computed after that information loss.

**Reproduction:** parent P contains `user → assistant A (“First prose”) → assistant B (“Later prose”)`, with distinct assistant message IDs. Quiet fork F copies only through A and has no own continuation. Stitching correctly records F on A, not B. The display merge combines A+B, keeps F's occurrence, and assigns that combined node as F's `tipId`. Opening F therefore shows “Later prose” as part of its selected endpoint even though F never contained it. The combined fork anchor also points after B in P.

This is separate from the earlier last-anchor fix: the anchor is correct for the combined display text, but the display group itself crosses a member's real endpoint. It undermines the core promise of viewing a fork's actual path.

**Fix direction:** preserve member endpoints as merge boundaries, or represent member-specific subranges/endpoints explicitly. A member holding one absorbed record must not imply it holds all absorbed records. Accept when focusing F shows exactly its copied prefix, and a fork made at that endpoint cannot incorporate B. Include quiet forks ending between adjacent assistant messages and between adjacent user records.

<a id="r3-3"></a>

### 3. [P2] Focusing a quiet member loses the session needed by Open / Resume

Locations: [store.ts:210](../../../src/store.ts#L210), [NodePanel.tsx:127](../../../src/components/NodePanel.tsx#L127).

`openSession(id, {focus})` uses the member only to choose a node, then discards the member identity. The panel always derives its session from the selected node's canonical `sourceSessionId`. A shared prefix has one canonical owner, even when several distinct sessions hold it.

**Reproduction:** a family has a parent and a named quiet fork whose tip is a shared node owned by the parent. Opening the fork's list entry selects that shared node. Rendering the resulting panel shows the parent's title and resume command; the quiet fork's title/command are absent. `SessionActions` receives the parent reference. This applies to copied Claude prefixes and Codex inherited history. It is independent of finding 2 and occurs even with a single unmerged shared node.

The documented distinction between opening a session's active path and forking an older branch does not resolve this: the user selected a different **session**, not merely an older path inside the same session.

**Fix direction:** retain an explicit member context for a member-focused open, or offer a member selector on shared nodes. Define how explicit node selection and reload change that context. Accept when choosing a named quiet fork can open/resume that fork, while opening the parent still targets the parent. Verify the action payload, not just the selected node ID.

<a id="r3-4"></a>

### 4. [P2] Existing stable-key annotations are not carried into newly discovered members

Location: [meta.ts:116](../../../electron/meta.ts#L116).

`applyAnnotations()` backfills every member only when it finds a legacy raw-ID annotation. A stable-key hit is displayed but never copied into a member discovered after the original annotation was written.

**Reproduction:** annotate a shared reply while P is the only session. Create F with a copied prefix. Load the family with both P and F present: the label appears. Delete only P's transcript, leaving its metadata on disk, then load F. The label disappears because only surviving members' sidecars are read and F never received it. The family was loaded before deletion, so this is not the documented limitation of deleting the source before a legacy migration has a chance to run.

**Fix direction:** reconcile annotations when membership grows, including stable-key entries, or use storage whose lookup does not depend on the current family membership. Avoid unconditional rewrites on every load. Define conflict and cleared-field behavior before adding replication; blindly copying stale entries can resurrect deleted annotations. Accept when a label written before a new fork is found survives removal of the original transcript after both members have been loaded.

<a id="r3-5"></a>

### 5. [P2] UUID containment drops newer metadata from a moved session's shadow copy

Locations: [transcripts.ts:1198](../../../electron/transcripts.ts#L1198), [transcripts.ts:1236](../../../electron/transcripts.ts#L1236).

UUID-set containment proves that conversation identities are present elsewhere; it does not prove that every record in a file is redundant. `custom-title` and other bookkeeping records can be UUID-less. A contained copy is removed from parsing wholesale, and the single-kept-copy path takes only that copy's summary. The diverged-copy union similarly starts at the first unseen UUID, dropping UUID-less metadata before it.

**Reproduction:** a larger old-folder copy contains the shared prefix, a continuation and title “Older name”. A subsequently written new-folder copy of the same session contains the prefix and `custom-title: “Renamed in copy”`. Its UUIDs are a subset. Listing the logical session still yields “Older name”; the new title is ignored completely, despite the new file remaining in signatures/watch targets.

**Fix direction:** separate conversation deduplication from metadata reduction across all physical copies. Establish a documented ordering for metadata events, including those without timestamps; do not infer full record equivalence from UUID containment alone. Accept when a metadata-only update in a contained copy is visible without adding a new conversation UUID, and when diverged copies retain metadata preceding their first new UUID.

<a id="r3-6"></a>

### 6. [P2] Opening a tree scans providers that settings explicitly disable

Location: [registry.ts:225](../../../electron/registry.ts#L225).

Welcome-list watch discovery honors `enabled()`, but non-null session watch discovery unconditionally calls `claudeWatchDirs()`, then Codex and Copilot lookups. `claudeWatchDirs()` invokes `familyOf()` and `scanSources()`, so opening a Codex tree still scans Claude even when Claude is disabled. An unreadable disabled provider can also prevent watch setup for an enabled provider.

**Reproduction:** create a Claude fixture, set `providers.claude=false`, and call `watchTargets(claudeId)`. It returns that fixture directory rather than no targets. The enabled-Codex path reaches the same unconditional Claude scan before locating Codex. This contradicts the setting's stated contract that a disabled provider is not read or watched at all.

**Fix direction:** route watch discovery through enabled providers, preferably through the same provider abstraction as load/list. Accept when disabled providers' discovery functions are never invoked while opening another provider, not merely when disabled results are hidden from the list.

<a id="r3-7"></a>

### 7. [P2] Weak semantic identities grow quadratically with conversation length

Location: [stitch.ts:80](../../../electron/providers/stitch.ts#L80).

For a weak key, `assignStableIds()` embeds the parent's **entire identity string** in the child: `key@parentIdentity`. A chain of n text-keyed messages therefore contains O(n²) identity characters. Copilot and legacy Codex use weak keys throughout, so this is a supported-input scalability issue rather than only a malformed-data concern. Iterative traversal avoids stack overflow but does not bound these strings.

**Reproduction:** construct alternating user/assistant chains, assign text-keyed weak identities, and sum `stableIds[0].length`. Increasing 100 nodes to 200 increases total identity characters by more than 3.9 times. These identities cross the worker/webview boundary and can be serialized into annotation sidecars. Long histories can consume far more memory and IPC bandwidth in identity strings than in their displayed text. The real-store audit did not encounter a large affected chain.

**Fix direction:** use a fixed-size digest of an unambiguous tuple containing the local key and the bounded parent identity. Specify algorithm/version and migrate or recognize the current persisted keys. Accept when total identity bytes scale linearly, exact copies have identical keys, repeated text under different parents remains distinct, and annotations remain readable.

<a id="r3-8"></a>

### 8. [P3] A pending debounce writes remembered view state after remembering is disabled

Location: [store.ts:330](../../../src/store.ts#L330).

Turning `rememberView` off returns early from the subscription without cancelling an existing timer. Its callback never rechecks the flag.

**Reproduction:** change the provider filter, then within 500 ms save `{rememberView:false, view:null}`. Advancing the timer produces another settings write that recreates `view`, including the provider filter. The flag remains false, so boot does not immediately restore it, but the requested removal and “off, nothing is written” contract are violated.

**Fix direction:** cancel pending timers when remembering is disabled and recheck the current flag before writing. Also prevent an older in-flight settings response from replacing a newer settings snapshot. Accept when disabling remembering clears view data and no deferred write recreates it.

## Architecture and data-model assessment

The worker/provider/host split is appropriate. Both hosts use the same store implementation and renderer; production builds and the timed worker audit substantiate the responsiveness claim. Reading the raw Codex page graph remains justified for displaying prompt-edit branches; moving all reads to app-server would lose the feature this fork exists to provide. Keeping Codex writes behind app-server, Claude writes in new fork files, and annotations in sidecars respects the repository's ownership boundary. These choices do not need to be reopened to fix the findings.

Separating semantic identities, occurrences, vendor turns and display groups was the right correction to the previous review. The next missing distinction is **membership at an exact endpoint versus presence somewhere inside a display group**. A merged node's occurrence union is useful for locating an annotation, but insufficient proof of a complete member path or an action target. Member focus is also view state in its own right; it cannot always be reconstructed from a selected shared node. Address findings 2 and 3 together at the model boundary rather than special-casing names in the UI.

The multi-folder source resolver correctly avoids selecting a single copy by size or recency when continuations diverge. Keep that. Refine the representation into immutable conversation records plus separately reduced metadata, with explicit policies for conflicts, UUID-less records and physical source ordering. Calling a UUID union “exact” overstates what the current algorithm preserves.

Annotation storage now has durable semantic keys but still depends on a changing list of session sidecars. Findings 1, 4 and 7 mean the identity and persistence contract needs an explicit version and migration policy. Document collision prevention, normalization, bounded parent qualification, clearing/tombstones and membership changes. A central store is one possible design, not a prerequisite for this release; a targeted reconciliation fix can also work. The already documented cross-process read/modify/write race remains a separate limitation. Atomic rename protects against partial writes, not lost updates or conflicting clears.

The registry's ownership-by-ID approach is adequate for the current vendors' UUIDs, and provider-qualified list keys are an improvement. If new providers with non-global IDs are added, carry a provider-qualified reference through load/watch/fork IPC too. This is future-proofing, not a demonstrated collision in current data. Moving provider-specific watch-target discovery onto `Provider` now would remove the inconsistent routing that caused finding 6.

The UI work addresses the stated purpose: fork names/search, branch tags, activity-based ordering and path normalization make a large family easier to find and read. Existing store and layout tests are valuable. Add semantic assertions at the boundaries: member path equals represented prefix, selected member determines intended action reference, and reload preserves both selection and member context. Keep layout fuzzing, but do not substitute structural/layout success for those properties.

## Remaining context and release confidence

- Previous findings' fixes are reflected in code and current tests: last-part fork authority, compacted-fork ancestry, worker-generation failure isolation, close/reload generation checks, re-rooted selection and null-clearing across the JSON bridge. Finding 1 is a remaining normalization case, not the old truncated-gist implementation returning.
- The known cross-folder live-watch gap, inferred parent direction after copied/restored directories, Codex abandoned-turn restrictions and unsupported pre-compact Claude cuts remain documented limitations. I did not count them again as new defects. Optional roadmap B5 and desktop installer packaging are not blockers for the requested scope.
- Preserve small disposable-home native canaries for Claude compacted/tool-ending forks and Codex deep links. Vendor formats and private extension entry points are the main ongoing compatibility risk. Record tested vendor/runtime versions and distinguish source inspection, fixture coverage and executed vendor behavior.
- Add repeatable CI for tests, typecheck and both production builds when release work is undertaken. Do not put private real transcripts or live model requests into normal CI. Test-provider isolation, member growth/removal and identity-size bounds are suitable deterministic checks.
- This review found no reason for a wholesale framework rewrite, database adoption or an HTTP service. Fix the identity/membership semantics first; larger infrastructure would not resolve them by itself.

## Documentation

The detailed proposal is [documentation-plan.md](documentation-plan.md). The immediate need is a single current home for each fact, a short agent entry point, a written identity/persistence contract, and an archive boundary around historical handoffs/reviews/completed roadmap text. Existing historical reports should retain their original verdicts with dated resolution links, rather than becoming competing current architecture references.
