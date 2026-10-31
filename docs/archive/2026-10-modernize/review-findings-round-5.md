# Full modernization review, round 5 — 2026-10-28

> **Historical review, `58cf671..1b4e0e5`; resolved.** The original report follows the resolution below unchanged; its line references are to `1b4e0e5`. Current contracts are in the [design notes](../../design.md), remaining work in the [roadmap](../../roadmap.md).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `1b4e0e5`).** All six
> findings had merit and were reproduced by a regression test that fails on
> `1b4e0e5` and passes after its fix. Where a finding was one instance of a
> missing contract, the contract was added rather than the instance patched:
> a page's vocabulary is decided by what carries its prose (1); the host
> proxy's method names are checked for completeness by the compiler (2); a
> fork request and a reloaded selection carry the endpoint the user saw, not
> a group head (3); a lookup's result is reconciled with the latest member
> choice (4); the saved state of an annotation comes from disk, not from the
> optimistic edit (5); no data reaches cmd.exe as text (6).
>
> | # | Fix | Test |
> |---|---|---|
> | 1 | `readsAsLegacy` (codex.ts): a non-paginated page reads as items only when an item carries prose (`UserMessage`/`AgentMessage`), or it has items and no prose of either kind (an untaught vocabulary still fails). One vocabulary per page; with item prose present the legacy events beside it are not read | codex: sanitized fixture of the observed shape (0.164 alpha, VS Code, legacy prose + one completed `Extension` item) lists, draws exact ancestry, stays fork-refused as legacy; health failures unchanged |
> | 2 | `METHOD_NAMES` in `backend-client.ts`, `satisfies Record<MethodName, true>`, builds the proxy; omitting a method is a type error. The host still imports `backend.ts` for its type only | backend-client: the real worker bundled by esbuild answers every `methods` key through `startBackend`, and `resumeLaunch` returns argv and the disposable `CODEX_HOME` |
> | 3 | `ForkPoint` (node id, drawn session, `lastRawId`); `forkPointOf` / `resolveForkPoint` in `shared/render.ts`, used by all three providers' forks: same node while it ends there, else the one node that does, else `FORK_POINT_GONE`. The bridge's `forkAt` takes the point. The store's `carry` tries the endpoint first, then id, then `stableIds` | claude: point taken before EF existed still forks "First prose. / Later prose." after EF splits the node; a point whose node was folded into a longer one is refused and writes nothing. store: a split keeps the selection on the node ending where it did |
> | 4 | `reloadSession` re-runs its lookup from the current focus when the user changed it during the scan and the result doesn't hold the new member | store: deferred F lookup, G chosen meanwhile — G requested and adopted, focus kept |
> | 5 | `patch` resolves to whether it saved; on failure sets `annotationError` (shown under the annotation buttons, cleared by the next successful save) and reloads the family from disk instead of rolling back. `annotate` throws when the turn is gone instead of returning silently | store: rejected write leaves `Not saved: …`, the node as on disk, and a later save clears it |
> | 6 | Windows launch: `start "" powershell.exe -NoExit -EncodedCommand <base64>`, the script being the copied command's own `Set-Location -LiteralPath …; …` | desktop: decoded script; on Windows, executed through cmd → PowerShell (no `start`), a literal `%AGENTREE_PROBE%` in the directory and store path arrives unexpanded |
>
> Proportionality: each change sits at the boundary the finding crossed and
> adds no new mechanism beyond one type, two shared helpers and one store
> field. Findings 5 and 6 are less common (inherited / unusual paths) and were
> fixed because the fixes are small and remove a class of failure, not one
> input. The remaining crafted inputs (both prose vocabularies in one Codex
> page, a repeated Claude uuid) stay unobserved and unpatched.
>
> Verification: 122 tests in 16 files (114 before), typecheck and both
> production builds pass on Node 26.3.0, Windows; host bundles contain the
> `resumeLaunch` proxy entry and no provider code. A read-only audit of the
> owner's real stores through a built worker (scratch Agentree home; the two
> builds differing only in `codex.ts`) found 156 families, 1,520 nodes and
> 1 failed Codex page with the `1b4e0e5` parser, and 157 families, 1,526
> nodes and 0 failed pages with the fix — the affected conversation is
> listed again — with no duplicate ids or dangling parents in either. Not
> done: an interactive UI check, a visible terminal window via `start`, a
> real Codex fork or terminal resume against a relocated store, native
> resume canaries.

Reviewed **`58cf671..1b4e0e5`**: the full modernization, including the round 4 resolution, not just its last two commits. At that revision the diff contains 148 files, 13,933 insertions and 1,781 deletions. The current working instructions/design/user guide and earlier review evidence informed the assessment.

**Verdict:** the architecture still fits Agentree's purpose, and the round 4 changes improve the contracts they targeted. I would hold completion/merge for findings 1–3: a real Codex conversation disappears, terminal resume is broken in both hosts, and a live regroup can make a successful fork omit text from the selected display group. Findings 4–5 concern asynchronous view intent and persistence feedback; finding 6 is a less common Windows quoting case.

No application implementation was changed. Probes used temporary homes, copied synthetic fixtures, mocked renderer responses, and a disposable copy of the affected real rollout. The real-store audits read originals only and used scratch Agentree homes. No original transcript/database was written, no real vendor fork/resume or model generation was invoked, and no private transcript text or account paths are included here.

## Findings

<a id="r5-1"></a>

### 1. [P1] One non-prose completed item makes an otherwise readable legacy Codex conversation disappear

Location: [codex.ts:314](../../../electron/providers/codex.ts#L314).

`parsePage()` switches the whole file from `parseLegacy()` to `parsePaginated()` whenever **any** record has `payload.type === "item_completed"`. Such a record does not establish that the file's prose uses the item vocabulary. A completed `Extension` item can coexist with legacy `user_message` / `agent_message` prose.

**Observed on real data:** one interactive rollout identifies itself as `cli_version: 0.164.0-alpha.11.1`, `source: vscode`, `history_mode: legacy`. It has legacy prose events, no ordinal-bearing records, and one `item_completed` whose item type is `Extension`. The newer parser ignores all the legacy prose, yields zero displayed nodes and counts the page as failed. Its conversation drops out of the welcome list. The health warning works; it does not recover the history.

**Two executed reproductions:**

- A sanitized synthetic legacy rollout initially lists and draws its question/reply. Appending only a completed `Extension` item makes it list zero conversations and load zero nodes, with one failed page.
- A snapshot of the affected real rollout was copied to a temporary Codex home and read through the built VS Code worker. It lists **0 conversations / 1 failed page**. Removing **only that one Extension record from the disposable copy** restores **1 conversation / 0 failed pages**. The original was never changed.

Round 4 explicitly left mixed vocabulary as a follow-up *if observed*. It is now observed, rather than just a possible crafted format. This does not establish that both prose vocabularies coexist; the actual counterexample needs only an item-vocabulary extension event alongside legacy prose.

**Acceptance:** commit a sanitized fixture for this observed shape before changing the parser. Adding a non-prose item must not discard supported legacy messages or their ancestry. Decide prose-vocabulary handling from the message evidence, rather than from the mere presence of an item event. If both prose vocabularies are supported in one stream, define their ordering/deduplication explicitly. Preserve the existing modern-item, copied-prefix, archived-base and prompt-edit cases.

<a id="r5-2"></a>

### 2. [P1] The backend proxy omits `resumeLaunch`, breaking terminal resume in both hosts

Location: [backend-client.ts:72](../../../electron/backend-client.ts#L72); callers in [extension.ts](../../../vscode-ext/src/extension.ts) and [main.ts](../../../electron/main.ts).

The worker's `methods` now includes `resumeLaunch`, and both host handlers call `backend.resumeLaunch(...)`. However, `startBackend()` builds its proxy from a separate literal method list which still ends with the original methods. It never installs `resumeLaunch`.

**Reproduced against the production client:** `typeof startBackend(...).resumeLaunch` is `"undefined"`; calling it throws a `resumeLaunch is not a function` TypeError. The same omission is visible in both built host bundles. No terminal or vendor invocation is needed to prove the failure: the call fails before either host creates a terminal.

This is a direct regression in the round 4 launch integration, affecting every provider and every store location. The app-server environment tests do not traverse this host-to-worker path.

Typecheck misses it because `satisfies MethodName[]` checks that listed names are valid, not that every method is listed. The proxy's subsequent cast asserts completeness without proving it.

**Acceptance:** expose `resumeLaunch` through the production client and call it through `startBackend` with a real built worker under disposable settings. Assert its argv/environment, and make omission of any future method fail a completeness check. Preserve the type-only backend import in the host; importing the provider-owning backend module at runtime would undo the worker boundary.

<a id="r5-3"></a>

### 3. [P1] A display node ID can acquire a shorter fork endpoint between rendering and the action

Locations: [NodePanel.tsx:163](../../../src/components/NodePanel.tsx#L163), [claude-fork.ts:59](../../../electron/providers/claude-fork.ts#L59), [claude-fork.ts:73](../../../electron/providers/claude-fork.ts#L73), and selection carry at [store.ts:138](../../../src/store.ts#L138).

The renderer requests a fork with only the family ID and display node ID. The Claude writer reloads the family, finds the current display node under that ID and derives its anchor anew. But a display ID is the **head** of a group, not a durable description of its endpoint. New membership can split that group while preserving its head ID.

**Reproduced with the real Claude provider/writer and copied endpoint fixtures:**

1. Initially only P exists. Its adjacent assistant parts A and B draw as one selected node, `First prose.\n\nLater prose.`, with head ID `ep-a1` and fork anchor `ep-a2`. A later user turn makes this a historical selection, not a following selection.
2. A quiet fork F, containing only through A, appears on disk. The correctly implemented endpoint rule now splits A and B into separate display nodes.
3. Before the renderer's watch reload, send the fork request for the still-displayed A+B node. The backend resolves `ep-a1` to A alone and **returns success**. The newly written temporary fork contains `First prose.` and **omits `Later prose.`**.

This is writer-output evidence; native resume of that fork was not executed. No malformed transcript or vendor-format speculation is required. The discovery/watch delay is a normal opportunity for the view and backend to differ.

There is a related selection effect after reload: `carry()` immediately preserves `ep-a1` because it still exists. The selected prefix changes from through B to through A, although B still survives in the tree. Thus the earlier endpoint can also become the subsequent action target after reload.

The last-part anchor rule remains correct **within each reconstructed snapshot**. What is missing is a contract tying the cut to the snapshot the user selected. The mismatch concerns the contents of the new fork; originals remain untouched.

**Acceptance:** retain the selected semantic endpoint when a display group splits or merges, and include enough expected endpoint/part identity in the fork request to validate the user's cut. Honor that cut when it remains legal, or refuse with a refresh/reselection explanation. Never silently reinterpret an old head ID as a different range. Test both the click-before-reload case and a historical selection across regrouping; retain the existing exact-text fork sweep.

<a id="r5-4"></a>

### 4. [P2] An in-flight reload can discard a newer member choice

Locations: [store.ts:279](../../../src/store.ts#L279), [store.ts:293](../../../src/store.ts#L293), [store.ts:329](../../../src/store.ts#L329), and the member selector in [NodePanel.tsx](../../../src/components/NodePanel.tsx).

The improved reload order captures the current focus in its candidate list. Its generation guard changes only on open/close. Choosing another member in the selector directly updates `focus`, without invalidating or rerouting a pending lookup.

**Reproduced with deferred renderer API responses:** open a family focused on F and select a shared user root held by F and G. A reload starts looking up F while the family splits. Before it answers, choose G in the member selector. The old lookup returns F's surviving component. It passes the unchanged view-generation check, adopts F, clears the newer G focus because G is outside that component, and leaves the panel acting on F. G is never requested.

This is distinct from the fixed static split case: preferring focus at the start of a request is correct, but that preference can change while a store scan is running.

**Acceptance:** before adopting a result, reconcile it with the latest user context. If the current focused member is absent because the result belongs to an earlier focus, resolve the current member rather than clearing it. Add a deferred-response test for F → G during reload, alongside the existing close/open generation and static split tests. A member choice must remain authoritative until the user changes it or that member is actually gone.

<a id="r5-5"></a>

### 5. [P2] Failed annotation writes still look saved — inherited persistence-feedback gap

Locations: [store.ts:343](../../../src/store.ts#L343), [store.ts:355](../../../src/store.ts#L355), and the void annotation event handlers in [NodePanel.tsx](../../../src/components/NodePanel.tsx).

`patch()` updates the rendered node optimistically, then awaits `api.patchNode()` without catching a failure, recording an error or reverting/marking the edit unsaved. The star/dead-end/label handlers discard the promise. A read-only/full Agentree home can therefore leave an annotation visibly applied even though it was not persisted, with no banner or retry state.

**Reproduced:** make the annotation API reject with an I/O error and call the real store's `setStatus(..., "favorite")`. The returned promise rejects, the node remains marked favorite, and `State.error` remains null. The click handler has no rejection handling to show it. The test mocked the backend rejection; no real annotation home was damaged or made unwritable.

This behavior predates this branch. It is not evidence that the new settings-error fix failed: that fix handles settings correctly, while annotations retain the older failure path. It is also separate from the documented concurrent-write and no-tombstone limitations.

**Acceptance:** expose annotation write failures where the annotation was edited, and either restore the confirmed state or explicitly retain a dirty edit with retry. Do not imply persistence from the optimistic mark alone. Account for a sidecar write failing after another member's sidecar succeeded; unconditional rollback is not proof that every disk copy rolled back.

<a id="r5-6"></a>

### 6. [P3] Windows terminal launch expands percent sequences inside literal paths

Location: [terminal.ts:58](../../../electron/terminal.ts#L58).

The generated PowerShell command is quoted correctly for PowerShell, then embedded inside a `cmd.exe /c start ...` command. `cmd` expands `%NAME%` even inside that outer quoted command, before PowerShell can interpret its single-quoted literal. A valid directory whose literal name includes such a sequence can therefore become a different store path. The cwd passed through `/D` has the same boundary concern.

**Executed quoting probe:** use a synthetic `CODEX_HOME` of `C:\stores\%AGENTREE_REVIEW_TOKEN%` and set that harmless review variable to `expanded` in the child environment. The generated PowerShell payload, run directly, prints the literal intended value. The same payload through the launcher's `cmd → PowerShell` boundary prints `C:\stores\expanded` instead. The probe omitted `start`, opened no window and invoked no agent; it tested the nested parsing boundary only.

This is independent of finding 2: it is present in the launch helper once the missing proxy method is wired. Ordinary tested paths containing spaces, apostrophes or `&` do not exercise percent expansion.

**Acceptance:** pass literal cwd/store values through both shell layers unchanged, including paired percent sequences. Avoid exposing PowerShell literals to an additional shell's expansion, or encode/pass data through a mechanism that `cmd` cannot reinterpret. Keep the existing new-console and PowerShell 5.1 behavior. This is a less common valid-path case, not a reason to replace the Windows launcher with a console-less detached process.

## Verification and limits

| Check | Result at reviewed HEAD |
|---|---|
| Existing fixture/renderer/host tests | **114/114 pass**, 16 files |
| Typecheck | Pass, including VS Code extension |
| Electron production build | Pass, including worker/preload |
| VS Code production build | Pass, including worker/webview/shim |
| Runtime | Node **26.3.0**, Windows; minimum supported runtime not executed |
| Additional focused test suite | Five tests reproduced findings 1–5; assertions checked the faulty behavior, not corrected behavior |
| Windows quoting probe | Direct PowerShell versus nested `cmd → PowerShell` comparison reproduced finding 6 |
| Built-worker real-store audit | **154 listed families:** 62 Claude, 87 Codex, 5 Copilot; 20 multi-member families; **1,512 displayed nodes** |
| Structural/member audit of loaded families | No duplicate node IDs, dangling parents, cycles, broken held-member ancestry or invalid member tips |
| Health | Claude: 70 files, 0 failed; Codex: 292 files, **1 failed**; Copilot: 5 files, 0 failed |
| Cold/warm list observation | About **3,694 ms / 29 ms**; a host 50 ms interval fired 59 times during the cold call |
| Host-bundle source inspection | No provider/parser/settings implementation symbols found in the host bundles |
| Full diff whitespace check | Still reports the known CRLF-related trailing whitespace in `test/fixtures/make-fixtures.mjs` |

The counts describe this snapshot of live stores, not a benchmark or a completeness guarantee. In particular, structural validity of the loaded families does not establish completeness: finding 1 removes a conversation before that audit can inspect it.

The real-rollout copy check establishes the parser's behavior on an actual vendor-written file and isolates one triggering record. It does not execute the vendor's app-server or resume loader. Source metadata identifies its CLI version; no new vendor-generation canary was run.

An interactive check was attempted with a disposable Electron profile and copied fixtures. The Windows computer-use helper repeatedly returned **“native pipe is unavailable … os error 2”**, including after a session reset, so no app state/screenshot could be captured. The UI inspection remains unverified; this tool failure is not an Agentree finding. The user stopped the running Electron instance. No UI-driven native agent actions were attempted.

Also not executed: a real terminal resume or Codex fork against a relocated store, native Claude compaction/tool-ending resume canaries, VSIX installation on minimum VS Code, macOS/Linux terminal launches or a dependency vulnerability audit. Temporary reproduction source files were removed after the review; only the report/index and the roadmap's now-observed format follow-up were edited.

## Architecture, model and fitness for purpose

The worker/provider/host split remains appropriate. The new launch description puts root resolution in the worker while leaving terminals/process ownership in the host. The raw Codex page graph is necessary for prompt-edit branches; using app-server only for Codex forks and preserving the separate Claude writer remain justified owner decisions. None of these findings calls for an SDK, HTTP service, framework rewrite or central database.

The round 4 identity work addresses its reported collision: the new strong prompt namespace and shared ownership check cover both read and write aliases. `endedAt` separates display start time from the latest endpoint, and static family splits now prefer the user's focused/selected side. The settings feedback, missing-root watch and extension README changes are present and covered to the extent their tests establish. Those fixes should not be described as absent merely because new interactions remain.

Two boundary contracts need more attention. First, a typed RPC surface is not implemented merely because a cast says it is: finding 2 is a completeness defect between the worker table and the host proxy. Second, a display group's head identity is insufficient to identify an action's semantic cut over time: finding 3 crosses the rendered snapshot and backend reload. The existing distinctions between message, occurrence, membership, vendor turn, display group and edge remain useful; carry endpoint intent through that final boundary as well.

The live-view model likewise needs to distinguish a result's original member context from the latest user choice. Testing final member sets and static tips cannot expose the race in finding 4. Deferred-response tests are appropriate here, while exact prefix/anchor assertions are appropriate for regrouping and fork actions.

The UI's fork names/search, explicit member selector, branch tags, fork/edit edges and compression all serve the stated purpose. The remaining optional grouped list, Copilot Chat, subagent lanes and installer packaging are not blockers for branched-chat viewing. Existing architecture and documentation ownership are suitable; prioritize the observed parser failure, missing runtime bridge and snapshot-safe fork semantics before adding more features.

Keep the remaining evidence gaps explicit. The Windows native-pipe failure did not close the visual checks. The real mixed-vocabulary observation, however, moves that particular roadmap item from hypothetical to confirmed and needs a sanitized regression fixture now. The repeated-Claude-UUID crafted case remains unobserved in this pass and should retain its weaker label.
