# Full modernization review, round 4 — 2026-10-28

> **Historical review, `58cf671..fc0ccc2`; resolved.** The original report follows the resolution below unchanged; its line references are to `fc0ccc2`. Current contracts are in the [design notes](../../design.md), remaining work in the [roadmap](../../roadmap.md).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `fc0ccc2`).** All seven
> findings had merit. Each code finding was reproduced by a regression test
> that fails on `fc0ccc2` and passes after its fix; finding 7 is prose. Where
> a finding was one instance of a missing contract, the contract was added:
> current identity keys get a form no earlier scheme saved, and older keys
> one ownership rule on read and write (1); store roots travel with every
> launch, resolved in the worker (2); a node's start is not its end (3); a
> successful old-root load is not proof of membership (4).
>
> | # | Fix | Test |
> |---|---|---|
> | 1 | Identity scheme 4: prompt keys `p:<promptId>\|<digest>`, a form schemes 2–3 never saved, so a current key always means its node. Scheme-3 `u:` keys join scheme 2's as `legacyIds`. `ownership` in `meta.ts`: an older key (any earlier scheme, raw ids included) is used — read, carried forward or patched by a write — only when exactly one node of the family answers to it. `writeAnnotation` now receives the family | annotations: twin prompts keep independent labels; an ambiguous older key shown on neither and never rewritten. claude: scheme-3 `u:` keys carried forward |
> | 2 | `harnessEnv` (`paths.ts`) names the harness's store variable whenever its root isn't the default; the Codex app-server is spawned with it; `launch.ts` gives `resumeLaunch` (argv + env) and the copyable commands; hosts ask the worker for the launch (`backend.resumeLaunch`) — VS Code passes it as the terminal's env, the desktop writes it into the command. `Provider.resumeArgv`, which no host used, was removed. The panel notes that a chat-panel hand-off uses the extension's own configuration | appserver: fake server reports `CODEX_HOME` (unset / saved setting / variable wins); shell, desktop: quoted env in commands and launches |
> | 3 | `TurnNode.endedAt` (last record of a streamed reply, last part of a same-role run, last Codex message of a turn); `newestLeaf` and `heldTip` rank by `endOf`, tie-breaking as before | endpoints: same-role run and streamed reply, tip and member tip |
> | 4 | Reload asks for the focused member, then the selected node's holders, then the old root and other members | store: split with and without focus; claude: bridge deletion splits a real fixture family, identities survive |
> | 5 | `settingsError`, shown in the settings dialog and on the welcome screen, cleared by the next successful save; `saveSettings` resolves to whether it saved; a path field that failed says "Not saved" and keeps the draft; the welcome screen also shows `error` (shared `ErrorBanner`) | welcome (server-rendered): failure shown in the dialog and on the screen, cleared after a retry; list error shown |
> | 6 | A missing dir target is stat-checked each second and, once it exists, attached and reported. Found while testing it: a recursive `fs.watch` on a Windows 8.3 short path aborts the process in libuv; watches now use the real long path | watch: polled and unpolled roots created after the watch started |
> | 7 | Extension README describes the member selector/focus and the relocated-store behaviour, links `#limitations`; bridge comments describe both hosts | — (link check) |
> | test | The fork-invariant sweep compares text exactly instead of whitespace-folded | every fixture fork |
>
> Verification: 114 tests in 16 files (101 before), typecheck and both
> production builds pass; host bundles still contain no provider or settings
> code. A read-only audit of the owner's real stores (scratch Agentree homes,
> committed `fc0ccc2` against the change) found the same 155 families and
> 1,514 nodes, with identical members, roots, branch points, titles and member
> tips, and no structural problems; none of the stores hit finding 3's
> ordering. There are no saved annotations there, so findings 1 and 4 rest on
> fixtures. Not done: an interactive UI check, a real Codex fork or terminal
> resume against a relocated store, native resume canaries.

Reviewed **`58cf671..fc0ccc2`**, the complete modernization: 138 changed files, 12,992 insertions and 1,772 deletions. This includes the round 3 fixes, rather than only the changes since the previous review. Read alongside the working instructions, current design/user documentation, original brief, handoffs, completed roadmap and earlier findings/resolutions.

**Assessment:** the architecture and feature set fit the purpose of viewing branched coding-agent chats. The branch is substantially stronger than the base. I would address findings 1–4 before calling the modernization complete: annotations can overwrite a sibling's data, configured stores can disagree with the fork process, and two cases select a different branch/session from the one intended. Finding 5 affects feedback from the new settings workflow. Finding 6 is an inherited live-discovery limitation, not a new regression. Finding 7 is stale documentation shipped with the primary product.

This review changes no application implementation. The reproductions used temporary homes, synthetic transcripts, a mocked renderer API, a fake Codex subprocess and server-rendered React output. The real-store audits used scratch Agentree homes and performed reads only. No original harness transcript/database was written, no real vendor fork/resume was requested, and no model generation was invoked.

## Findings

<a id="r4-1"></a>

### 1. [P2] Legacy prompt aliases can overwrite or clear another prompt's current annotation

Locations: [meta.ts:119](../../../electron/meta.ts#L119), [meta.ts:172](../../../electron/meta.ts#L172), [meta.ts:206](../../../electron/meta.ts#L206), [identity.ts:84](../../../electron/identity.ts#L84).

Scheme 2 and scheme 3 **strong prompt keys share a namespace**. For two prompts with the same `promptId`, `run tests` and `run  tests`, scheme 2's folded key for the second is exactly scheme 3's current key for the first. This is a deterministic alias collision, not a hash collision. The scheme change distinguishes the transcripts correctly, but annotation compatibility can join them again.

There are two effects:

- An old ambiguous annotation is assigned to the single-spaced prompt. The `claims` check only guards the older-key lookup; `current` accepts the same key first without that check. The promise that an ambiguous old key is shown on neither prompt does not cover this case.
- **New annotations are affected too.** Save label A on the first prompt, then label B on the second, using only current code. `writeAnnotation()` calls `olderKeys()` without an ambiguity/ownership check and patches the first prompt's current key as the second prompt's legacy alias. Both now show B. Clearing the second prompt then clears both entries, losing A.

**Reproduced:** real `parseRecords`, `writeAnnotation` and `applyAnnotations` calls on a synthetic pair. The current-write case yielded `['B current label', 'B current label']`; clearing B left the sidecar empty. No pre-upgrade sidecar was needed. The existing ambiguity regression covers weak literal-chain keys, which do not exercise this strong-key namespace overlap.

**Acceptance:** a current label on either prompt can be created, edited and cleared independently; an ambiguous historical entry is preserved without being arbitrarily assigned or rewritten. Carry enough scheme provenance, or introduce a distinct namespace with compatibility for all prior keys. Only migrate/patch an alias when its ownership is unambiguous across the family. Checking read claims alone will not fix the write path.

<a id="r4-2"></a>

### 2. [P2] The fork subprocess does not use a Codex home selected in settings

Locations: [codex-appserver.ts:158](../../../electron/providers/codex-appserver.ts#L158), [paths.ts](../../../electron/paths.ts), [extension.ts:159](../../../vscode-ext/src/extension.ts#L159), [main.ts](../../../electron/main.ts).

Readers resolve `CODEX_HOME > settings.paths.codexHome > default`, but `withAppServer()` spawns Codex without an environment override. With `CODEX_HOME` unset and a nondefault saved home, the tree comes from the configured store while `thread/fork` uses Codex's default store. The usual result is a thread-not-found failure. If both stores contain that thread ID, the API can operate on the other copy and put its new fork in a store Agentree is not displaying.

**Reproduced:** saved a temporary `paths.codexHome`, left `CODEX_HOME` unset, and launched a fake app-server through the real client. `codexHome()` resolved the saved location; the subprocess reported `CODEX_HOME` unset. This proves the launch-context mismatch, not the behavior of a real Codex fork against those stores.

The terminal hand-offs have the same integration gap by source inspection: both hosts launch the provider's bare resume argv, and neither carries the saved Claude/Codex/Copilot root into the new terminal. The generated copyable commands also omit it. A native extension hand-off similarly needs an explicit policy when that extension uses a different home; a URI alone cannot configure the receiving extension.

**Acceptance:** with environment overrides absent, a saved Codex home is used by both reading and the fake server's fork launch. Preserve environment precedence. Terminal resume/copy commands must target the effective provider home, or clearly explain when the receiving runtime must be configured separately. Keep store resolution in the worker; a typed launch description returned to the host would preserve the existing boundary.

<a id="r4-3"></a>

### 3. [P2] A merged reply's start timestamp can select an older branch as the member's tip

Locations: [render.ts:75](../../../shared/render.ts#L75), [transcripts.ts:349](../../../electron/transcripts.ts#L349), [store.ts:223](../../../src/store.ts#L223).

`mergeSameRoleRuns()` retains the head's `timestamp`, while `heldTip()` ranks leaf groups using that timestamp. A group's latest continuation is therefore dated by its first part. The new member-focused open trusts the resulting `tipId`, so it can land on a branch that was last active earlier.

**Reproduction:** one user root has assistant branches A and B. A's first message is at time 1, B's reply at time 2, and a further assistant message under A at time 3. A and its continuation merge; the merged group still has timestamp 1. `heldTip()` chooses B, even though A contains the newest continuation and its fork anchor correctly points at the time-3 part. The same comparator problem also affects the family's `newestLeaf()` and following behavior.

This start-time behavior already existed in the base's grouping/latest-leaf logic; the modernization additionally exposes it through `assignTips()` and named-member focus. It is not a return of the fixed last-anchor bug: the anchor is correct, but the temporal information used to choose the endpoint is incomplete.

**Acceptance:** the merged branch containing time 3 is selected as the latest held endpoint, and focusing its member lands there. Preserve a group's temporal extent or last-part time separately from its display start time. Cover both per-message content-block aggregation and same-role aggregation, and assert the selected path rather than only its structural validity. List sort settings must not change this interpretation.

<a id="r4-4"></a>

### 4. [P2] Reload abandons a surviving focused fork when a family splits

Locations: [store.ts:280](../../../src/store.ts#L280), [store.ts:289](../../../src/store.ts#L289), [store.ts:310](../../../src/store.ts#L310).

Reload tries the old root first and stops at the first successful load. A successful root load does not prove it still contains the focused member. When removal of a bridge transcript splits a family, the root can survive in one component and the user's focused fork in another. Reload adopts the root's component, drops the focus and moves the selection there without trying the surviving fork.

**Reproduced with actual synthetic Claude files and the real provider/store:** P contains answer A. Its fork B contains the copied A and a regenerated first answer B on another branch. F forks B's regenerated branch, so F holds B but no copy of answer A. Initially the three are one family through B. Open focused on F, then remove only B's temporary transcript. P and F now load as separate families. Reload calls P, accepts it, clears focus and selects P's history. F remains loadable but is never requested.

The original grouping evidence is legitimately gone; the fix does not need to invent a surviving P–F relationship. It needs to keep the user on F's surviving component.

**Acceptance:** prefer a surviving focused member, or otherwise the selected node's relevant surviving member, when deciding which new component to adopt. Preserve selection by semantic identity within that component. Test bridge deletion with both components still on disk, in addition to the existing deleted-root case.

<a id="r4-5"></a>

### 5. [P2] Failed settings saves are invisible on the screen where settings are edited

Locations: [store.ts:181](../../../src/store.ts#L181), [App.tsx:38](../../../src/App.tsx#L38), [Welcome.tsx:90](../../../src/components/Welcome.tsx#L90).

`saveSettings()` catches a write error and places it in `State.error`. Settings are edited on the welcome screen, but `App` returns `<Welcome />` before its error banner, and `Welcome` never reads the error. A permission failure, full disk or failed atomic replacement therefore has no visible explanation. A path field can continue displaying its local unsaved draft, despite the panel's automatic-save presentation.

**Reproduced:** mocked `setSettings` to reject with a unique error, called the real store action, and server-rendered the welcome screen with Settings open. The error was present in store state and absent from the rendered markup. This is a rendered-output check, not an interactive/visual app check.

The hidden welcome-error pattern predates the branch, but the new settings feature now routes all of its persistence failures into it. Initial list/open failures can also remain invisible through this path.

**Acceptance:** the welcome/settings UI displays the failure and makes the unsaved state clear. After a successful retry, remove the obsolete error. Retain the entered value if useful, but do not present it as a completed save.

<a id="r4-6"></a>

### 6. [P3] Missing roots are never watched when they later appear — inherited limitation

Location: [watch.ts:122](../../../electron/watch.ts#L122), also [watch.ts:161](../../../electron/watch.ts#L161).

Polling is installed only if the directory exists when the subscription starts. `fs.watch` on a missing root fails and is ignored. Creating that root later installs neither mechanism. `watchLater()` retries rejected target resolution, but this case resolves successfully, so it never retries installation.

**Reproduced:** subscribed to two absent temporary roots, one with polling requested and one without. Created each root and a JSONL file, then waited longer than the poll interval plus debounce. Neither callback ran. This affects first-session discovery, for example after configuring a new Claude or Copilot home. It is separate from the documented new-Claude-fork-in-an-unwatched-project-directory gap.

**Acceptance:** observe creation of an absent configured root, then attach the normal watch and reconcile the list. Polling missing roots or observing an existing ancestor can do this without parsing stores on the host. This behavior is inherited from `58cf671`; track it as a follow-up rather than describing it as a modernization regression.

<a id="r4-7"></a>

### 7. [P3] The extension README still advertises the resolved round 3 defects

Location: [vscode-ext/README.md:33](../../../vscode-ext/README.md#L33), also its shared-history paragraph under Use.

The README packaged with the primary VS Code product says round 3 has unresolved distinct-prompt, quiet-endpoint and action-context defects. It also tells users that focusing a quiet member does not preserve action context. Those statements contradict the fixes, their current tests and the current root documentation. Its limitations link ends in `#limitations-and-open-review`, while the current guide's heading is `## Limitations` (`#limitations`).

**Verified by source/link inspection**, not a Marketplace publication check. The extension README was updated in this branch, but these resolution-era statements were left behind. The bridge type comments also still label Open/Resume as VS-Code-only despite the implemented desktop parity.

**Acceptance:** the packaged README describes the implemented member selector/focus behavior and links to the guide's existing limitations anchor. Keep historical findings in the dated report with their resolution; avoid presenting them as current product limitations. Update the stale host comments at the same time. No runtime tests are required for this prose correction.

## Verification and evidence limits

| Check | Result |
|---|---|
| Existing test suite | **101/101 pass**, 12 files |
| Typecheck | Pass, including the extension |
| Electron production build | Pass, including worker/preload |
| VS Code production build | Pass, including worker/webview/shim |
| Runtime used for these checks | Node **26.3.0**, Windows; minimum supported runtime not executed |
| Focused reproductions | Findings 1–4 and 6 reproduced in disposable-store/scripts; finding 5 reproduced with a temporary Vitest/React server-render test |
| Built VS Code worker, real stores | **155 families:** 62 Claude, 88 Codex, 5 Copilot; 20 multi-member families; **1,512 displayed nodes** |
| Real-store structural/member audit | No duplicate node IDs, dangling parents, cycles, broken held-member ancestry or invalid member tips |
| Provider health | Zero failed parses across 367 files; Claude reports 12 unknown `tools-used` records |
| Worker listing timing | First run about **8.7 s cold / 95 ms warm**; repeated fresh-worker audit about **5.2 s / 48 ms**; observations, not benchmarks |
| Full diff whitespace check | Fails on the already recorded CRLF-related trailing whitespace in `test/fixtures/make-fixtures.mjs` |

Reproduction assertions intentionally checked the undesired behavior. They do not add passing regression coverage for a fix. Temporary reproduction scripts/test files were removed after the review; the setups and acceptance conditions above are retained. Production build outputs are ignored artifacts.

The audit also found two current semantic keys each claimed by two Claude display groups with equal text and the same displayed parent. That alone is not a defect: semantic identity need not be a unique physical occurrence. No finding is inferred merely from those repeated keys. Their raw node IDs were distinct and the trees structurally valid.

Two additional robustness concerns were not promoted to release findings. A synthetic repeated raw UUID reproduced Claude parsing concatenating old/new text while the fork writer keeps the last record. Source inspection also suggests that a mixed legacy/item-vocabulary Codex stream would lose its older prose; that crafted stream was not executed. A separate read-only scan found **no repeated Claude record UUIDs in 70 files and no mixed-vocabulary Codex streams in 292 files**. This pass did not establish that current vendors produce either input. Preserve this distinction instead of presenting crafted format possibilities as observed compatibility failures.

Not executed: an interactive VS Code/Electron visual check, VSIX installation on minimum VS Code, native vendor resume/deep-link canaries, macOS/Linux terminal launches, or a dependency vulnerability audit. Passing builds do not close those gaps. Existing source/verified/unverified vendor evidence remains as documented; it was not revalidated against a different vendor release here.

## Architecture, data model and purpose

The local worker/provider/host design is appropriate. Store interpretation stays in the worker; the renderer is shared and has no Node bridge beyond the declared API; hosts handle watches, terminals and native hand-offs. Production builds and source inspection support these boundaries. Moving Codex reads to app-server would discard the prompt-edit branches this product is meant to show. The raw page graph, archived bases, official Codex fork API and separate Claude fork writer remain justified owner decisions.

The distinctions between semantic message, occurrence, membership, vendor turn, display group and edge kind are useful and are implemented more consistently after round 3. The audit supports structural/member consistency on the available stores. The remaining selection defects illustrate two further contracts: a group's **start time is not its endpoint time**, and a family's **successful old-root lookup is not proof of continued membership**. Keep those decisions explicit rather than inferring them from convenient display fields.

Annotation identity is now bounded and exact over parsed text, but compatibility needs a stronger namespace/provenance rule. The current documentation's assertion that key forms cannot collide is too broad for strong prompt keys. Atomic replacement and membership replication solve different problems; neither prevents a legacy alias from patching another current identity. The documented concurrent-write/no-tombstone limits remain separate follow-ups, not duplicates of finding 1.

Effective store roots also belong to action context. The worker can return a narrow launch description containing resolved argv/environment, while the host retains terminal/process ownership. This would address the configuration mismatch without importing providers or doing store discovery on the host. Native extension hand-offs need a clear compatibility policy because the receiving extension owns its own configuration.

The UI additions serve the stated purpose: one family per card, named searchable forks, explicit member focus, exact endpoints, fork/edit edges and visible fork tags make branched histories easier to locate and inspect. Optional grouped-list work, Copilot Chat, subagent lanes and installer packaging are not prerequisites for that purpose. No framework rewrite, HTTP server or central database is warranted by these findings.

The current documentation ownership split is sensible; finding 7 is a missed synchronization in the extension's packaged entry point, not a reason for another documentation reorganization.

The most useful next verification is semantic acceptance coverage for the findings, followed by the already recorded visual/member-selector and disposable native canaries. Keep exact text/ancestry/action assertions alongside layout fuzzing and structural audits. In particular, do not let the existing fork-invariant helper's whitespace-folded text comparison stand in for an exact whitespace-preservation check. Repeatable CI for tests, typecheck and both production builds remains worthwhile release work already tracked in the roadmap.
