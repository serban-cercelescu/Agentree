# Day view review — 2026-10-28

> **Historical review of the `day-view` branch, `7d3a66c..45e2f26` (the day view and the run-desktop skill); resolved.** The original report follows the resolution below unchanged, except for the anchors added to each finding; its line references are to `45e2f26`. It was received truncated at its end. Current contracts are in the [design notes](../../design.md#day-view); the [second round](review-findings-day-view-round-2.md) followed.

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `45e2f26`).** All seven
> findings had merit. Each structural one was fixed at the contract it
> crossed rather than at the instance: an action boundary for writes to
> agent stores (1), a provider-supplied family revision (2), and the
> endpoint-preserving selection rule shared with reloads (3). The rest are
> local fixes. One related defect turned up while fixing 1: the skill's
> `fixtures` mode pointed the app at the committed fixtures, so a fork there
> would have written into the repository. It now runs on a temp copy.
>
> | # | Fix | Check |
> |---|---|---|
> | 1 | `AGENTREE_READ_ONLY_STORES` (`electron/readonly.ts`): `forkAnyAt` refuses before any provider is asked, and both hosts refuse `openNative` and `resumeInTerminal`. The skill's `real` mode sets it; its text guard is gone. `fixtures` mode copies the stores into the run's temp directory, deleted on `quit` | registry test: refused fork, no provider asked, hand-offs refused, `0` turns it off. In the app, `click-text fork` (the reported bypass) resolved to **fork after this turn** and was refused; bridge calls to resume and open were refused; no session was added |
> | 2 | `SessionMeta.revision`: each provider's digest of the member files' identities and the family's own name-index and lineage entries. The day cache is keyed by `provider:id:revision`, and a family without one isn't cached. Claude's family-meta cache now also keys on those lineage entries | day test on copied stores: a Codex rename and a Claude record rewritten under the same uuid and timestamp leave times and counts unchanged and change the revision. The day shows the new title and text and re-reads exactly those two families |
> | 3 | `DayTurn.ref` (`NodeRef`: `ForkPoint` + `stableIds`). `openSession(…, { select: ref })` resolves it with `locate` in `shared/render.ts`, which the store's reload `carry` now uses too (same order: end, id, identity), and asks for the focused member's family first | store tests: a turn drawn through `p-a2` opens on `p-a2` after a quiet fork split its group. A focused chat whose family split is loaded by its own id and found by identity |
> | 4 | Breaks measure from the latest end of every earlier turn, in any lane (`busyUntil`); the break and its resume label share that decision | layout test: a 09:00–10:00 reply and a 10:01 prompt make no break; a pause is labelled from the latest end across lanes |
> | 5 | Day mode: the view has a 380 px floor with the pane scrolling below it. In a narrow pane the canvas and card share the height (`flex` basis 0; the card shrinks and scrolls) | In the app at 820×600: the card ends inside the body and scrolls, and the pane scrolls. At 820×420 the pane scrolls |
> | 6 | The timeline is focusable, and every control that picks a chat or a turn moves focus to it; a focused button keeps its own Enter | In the app: after clicking a lane name, focus is on the timeline and Enter opens the tree |
> | 7 | The day viewport is kept in the store when the view unmounts (`dayViewport`) and restored for the same day; a fresh fit also reveals a kept selection | In the app: the last lane's turn, opened and Esc'd, is back inside the canvas |
>
> Not covered by tests: focus, the kept viewport and constrained heights
> (the renderer tests render to static markup, with no DOM). They were
> checked in the desktop app only. The VS Code webview was not driven.
>
> Verification: 161 tests in 19 files (156 before), typecheck and both
> production builds pass on Node 26.3.0, Windows. Host bundles contain the
> read-only guard and no provider code.

## Original report

<a id="dv-1"></a>

1. [P1] The desktop driver’s “real” mode can still fork into original stores.
   [driver.mjs (line 154)](../../../.claude/skills/run-desktop/driver.mjs#L154)
   click-text checks the supplied search text before resolving the button. click-text fork passes the guard, then can match and activate “fork after this turn”. Keyboard activation also bypasses this check.
   This contradicts the skill’s read-only guarantee and AGENTS.md’s original-store boundary. Enforce the restriction at the fork action/API boundary; checking resolved button text would improve this particular command but would leave other activation paths available. Source-inspected only; I did not execute this against real stores.

<a id="dv-2"></a>

2. [P2] The day cache can retain stale names and conversation text indefinitely.
   [registry.ts (line 309)](../../../electron/registry.ts#L309)
   The cache key uses record timestamps and counts, which do not identify every change to the projected data.
   On copied fixtures, I reproduced both:
   - Renaming a Codex thread through session_index.jsonl updated List and Tree, while Day retained the old title. Search consequently used the old name.
   - Appending an updated Claude record with the same identity and timestamp changed Tree’s text while Day retained the old preview.
   Use a provider-supplied family revision covering transcript file identities and relevant metadata/index changes. Adding the title alone would leave the text case unresolved.

<a id="dv-3"></a>

3. [P2] Opening Tree from Day loses the drawn endpoint when grouping changes.
   [DayView.tsx (line 59)](../../../src/components/DayView.tsx#L59), [store.ts (line 304)](../../../src/store.ts#L304)
   Day carries only the node’s head ID into openSession. The existing design explicitly establishes that this ID does not identify the displayed endpoint.
   Reproduction using the existing endpoint fixtures:
   - Day draws ep-a1 as “First prose. Later prose.”
   - A quiet fork appears before the tree load, splitting that group.
   - Tree opens on ep-a1, now only “First prose.”, instead of the endpoint ep-a2.
   Carry the drawn endpoint and semantic identity through the projection, and resolve the selection using the existing endpoint-preserving rules. The handoff should also follow the focused member when family membership changes.

<a id="dv-4"></a>

4. [P2] “Idle” breaks include time when an agent was actively working.
   [day-layout.ts (line 195)](../../../src/day-layout.ts#L195)
   Break detection subtracts consecutive start timestamps and ignores endedAt.
   A reply starting at 09:00, ending at 10:00, followed by a prompt at 10:01 produces a 61-minute idle break, despite only one minute of inactivity. I reproduced this directly.
   Calculate inactivity from the running maximum of known turn end times across lanes. If start-to-start compression is the intended meaning, the UI needs to describe that interval accurately instead of calling it idle.

<a id="dv-5"></a>

5. [P2] Short, narrow panes clip the side card and its controls.
   [styles.css (line 644)](../../../src/styles.css#L644)
   In column mode, the canvas’s 260px minimum and the non-shrinking card can exceed the available height. Both surrounding containers hide overflow.
   At 820×600 on fixtures, the day body ended at y=586, while the card extended to y=673. Its lower portion was clipped; internal scrolling cannot expose content whose final position remains below that clipping boundary.
   Let the canvas/card share the available height, or provide an outer scrolling fallback. This matters for the primary VS Code host.

<a id="dv-6"></a>

6. [P2] Enter fails after selecting a chat through a button.
   [DayView.tsx (line 119)](../../../src/components/DayView.tsx#L119)
   The handler excludes every focused BUTTON from Enter-to-open behavior. Lane labels and “Chats this day” entries are buttons, so selecting through them leaves focus in a state where arrows navigate but Enter does not open the selected turn.
   I reproduced this with a focused lane button. Move focus to the timeline when navigation begins, or distinguish chat-selection controls from buttons whose own Enter action must take precedence.

<a id="dv-7"></a>

7. [P2] Esc preserves selection but can return with that turn completely offscreen.
   [DayView.tsx (line 84)](../../../src/components/DayView.tsx#L84)
   Opening Tree unmounts Day. Returning remounts it and fits from the first lane, discarding the viewport without revealing the retained selection.
   On fixtures, I selected the last lane, opened Tree, and pressed Esc. The selected dot returned at y≈1887, below a canvas ending at y≈845.
   Preserve the day viewport across the handoff, or reveal the retained selection after the initial fit.

The overall design is appropriate: a worker-owned projection of existing provider trees, a typed bridge shared by both hosts, pure filtering/layout helpers, and conservative startedAt bounds. Keeping parsing, stitching, membership and annotation interpretation outside the day renderer preserves the established boundaries. The documented preview and annotation limitations are reasonable scope choices.

The main architectural gaps are cache revisions and selection identity across snapshots. Both should reuse explicit backend/model contracts. The tests cover substantial static behavior, but currently miss mutations beneath unchanged timestamps/counts, endpoint changes between reads, browser focus, viewport restoration, and constrained-height layout.

Verification: all 156 tests, typecheck, both production builds, and dif

*(The report was received truncated here.)*
