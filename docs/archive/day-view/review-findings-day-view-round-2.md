# Day view review, round 2 — 2026-10-28

> **Historical review of `45e2f26..2f2c44b` (the [first round](review-findings-day-view.md)'s resolution); resolved.** The original report follows the resolution below unchanged, except for the anchors added to each finding; its line references are to `2f2c44b`. Current contracts are in the [design notes](../../design.md#day-view).

<a id="resolution"></a>

> **Resolution (2026-10-28, same branch, after `2f2c44b`).** All five
> findings and the documentation note had merit. Three were one rule
> applied in only some places, and were fixed by applying it everywhere:
> - selection identity on every snapshot a selection crosses (1);
> - wheel cancellation on both canvases (2);
> - `endOf` for "latest" in the day view, as in the tree (4).
>
> Two were missing structure: modal isolation for Settings (3), and an
> interval context for turns that started before the day (5).
>
> | # | Fix | Check |
> |---|---|---|
> | 1 | `locateBy` (`shared/render.ts`) is the resolver over anything that carries a `NodeRef`. Its order is unchanged: end, id, identity. `locate` is `locateBy` over a family's nodes. `loadDay` resolves the selected turn's `ref` against the refreshed day, among that agent's turns, and re-keys `daySelected` | store test: a selection drawn through `ep-a2` moves to `ep-a2` when a refresh splits its group, and to `F`'s copy when `P` is deleted and `F` re-roots |
> | 2 | `useCanvasWheel` (`src/wheel.ts`): a native `{ passive: false }` wheel listener on the canvas, attached through a callback ref and removed on unmount. The tree and day canvases both use it; React's passive `onWheel` is gone from both | In the app at 820×600 (CDP mouse-wheel event): the day zooms 60%→48% with the pane's `scrollTop` still 0. A wheel over the day header scrolls the pane 44.8px. The tree zooms 140%→112% |
> | 3 | Settings is a modal: `aria-modal`, focus moves into it on open and back on close, Tab cycles inside, and its `onKeyDown` stops every key at the dialog (Esc closes it). The day view's shortcuts also stand down while `settingsOpen` | In the app, with a turn selected and Settings open: ← and Enter changed nothing, Tab stayed in the dialog, and Esc closed it with the selection kept and focus back on the timeline |
> | 4 | `laneLatest(layout, lane)` returns the lane's latest-ending turn by `endOf` (the later-starting on a tie). The chat list's range ends at that turn's end; ←/→ still step in start order | layout test: the `test/endpoints.test.ts` branch (A 10:01–10:03, B at 10:02) lands on A |
> | 5 | `DayActivity.running` (`DayRun`): turns that started before the window and end at or after its start. They have no mark, keeping the display rule. Their chat is listed so the filters apply to them, but a lane is drawn only with turns. `buildDayLayout` seeds `busyUntil` from them | backend test: a Copilot reply from 23:55 to 00:30 stays on its first day and appears in the next day's `running`. layout test: with it, 00:02 → 00:31 is no break |
> | P3 | The first report moved to `docs/archive/day-view/` (owner's move). Its links in the design notes and the modernization archive were updated, and this archive got a README. AGENTS.md names both archives | All repository links and anchors checked |
>
> Not covered by tests: event cancellation, modal focus and scroll geometry
> (the renderer tests render static markup). They were checked in the
> desktop app with the run-desktop skill, which gained a `wheel` command
> for this. The VS Code webview was not driven.
>
> Verification: 165 tests in 19 files (161 before), typecheck and both
> production builds pass on Node 26.3.0, Windows.

## Original report

<a id="dv2-1"></a>

1. [P2] A live day refresh still loses the selected endpoint.
   [store.ts (line 272)](../../../src/store.ts#L272)
   loadDay preserves selection solely by turnKey, which contains the group’s head ID. The new NodeRef is used when opening Tree, but is discarded when refreshing Day itself.
   I reproduced this through the built worker and renderer store on copied fixtures:
   - Selected ep-a1 displayed “First prose. Later prose.”, ending at ep-a2.
   - A quiet fork appeared and the day refreshed.
   - Selection remained on ep-a1, now displaying only “First prose.”
   - Opening Tree then selected that shortened endpoint.
   Preserve the previous selected turn’s reference across loadDay, resolve it against the new projection, and update daySelected accordingly. The same path should preserve selection when canonical ownership or the family ID changes.

<a id="dv2-2"></a>

2. [P2] Wheel zoom also scrolls the outer pane.
   [DayView.tsx (line 170)](../../../src/components/DayView.tsx#L170)
   React registers its wheel listener as passive in the installed version, so this handler’s preventDefault() cannot cancel browser scrolling. The new outer-pane scrolling makes that observable.
   At 820×600, one browser-native CDP wheel event changed both:
   - Timeline scale: approximately 0.886 → 0.708
   - Outer pane scrollTop: 0 → 44.8
   Consequently, zooming moves the whole timeline beneath the pointer as well as changing its scale. Register a native wheel listener with { passive: false } on the intended interaction surface and clean it up on unmount. Preserve ordinary scrolling outside that surface.

<a id="dv2-3"></a>

3. [P2] Day keyboard shortcuts operate behind Settings and can dismiss it indirectly.
   [DayView.tsx (line 138)](../../../src/components/DayView.tsx#L138)
   The window-level handler remains active while Settings is open. It excludes input elements, but does not check settingsOpen or whether the event belongs to the dialog.
   Reproduced in Electron:
   - Select a day turn and open Settings.
   - Press ←: the background selection changes and pick() moves focus out of Settings into the timeline.
   - Press Enter: the background tree opens, unmounting Settings.
   Suspend day navigation while the dialog is open, and keep keyboard focus within the active dialog. Esc currently also clears the background selection while closing Settings.

<a id="dv2-4"></a>

4. [P2] Clicking a chat selects its latest-starting turn, rather than its latest-ending turn.
   [day-layout.ts (line 314)](../../../src/day-layout.ts#L314)
   laneLatest returns the last entry in the start-time ordering. This violates the existing endOf contract and can disagree with the same chat’s Tree tip.
   Using the branch pattern already covered by test/endpoints.test.ts:
   - Answer A starts at 10:01 and continues until 10:03.
   - Answer B starts and ends at 10:02.
   - Tree correctly considers A latest; Day’s lane selection chooses B.
   Keep chronological navigation ordered by start, but calculate the lane’s “latest” selection using its maximum known end time. The chat card’s displayed activity range should use that end time too.

<a id="dv2-5"></a>

5. [P2] Turns spanning midnight are missing from the next day’s busy-time context.
   [registry.ts (line 268)](../../../electron/registry.ts#L268)
   The updated idle calculation works for projected turns, but the projection completely excludes turns that started before the day—even when their endedAt falls inside it.
   I reproduced two synthetic sessions:
   - A reply runs from 23:55 yesterday until 00:30.
   - Another chat has turns at 00:01 and 00:02.
   - The first chat receives its next prompt at 00:31.
   Day displays a 29-minute idle break, although something was running until one minute before the prompt.
   Carry overlapping activity intervals into the day projection’s layout context. Their marks can remain assigned to their starting day, preserving the documented display rule.

There is also a P3 documentation issue in the current uncommitted move: the report now exists under docs/archive/day-view/, while references in [design.md (line 1012)](../../../docs/design.md#L1012) and the modernization archive README still target the deleted location. Update those references when completing the move.

The architecture remains appropriate for Agentree. Worker-owned projection, provider-supplied revisions, action-level read-only checks, and the shared selection resolver fit the existing boundaries. I found no new store-write bypass. The remaining model gaps concern applying selection identity consistently across every refresh and retaining enough interval context to calculate inactivity accurately.

The reported cache reproductions now have meaningful regression coverage. The desktop checks also confirmed lane-button Enter and viewport restoration. The main testing gap is interactive browser behavior: static markup cannot establish event cancellation, modal keyboard isolation, or scroll geometry.
