# Agentree roadmap (2026-10-27)

> **Completed-plan snapshot, through `b400dbd`.** The original brief, owner decisions and completion notes below are retained as history. Its “Today”, “Build” and open-question passages describe planning-time state. Use the [current roadmap](../../roadmap.md) for remaining work; the [round 3 review](review-findings-round-3.md) remains open.

> **Status (2026-10-27, same branch).** A1–A4, B1–B4 and C1 are built; B5
> is deferred. The owner's answers: the directory filter matches **any
> member's** directory (open question 1), and "last file change" **stays**
> a sort option (question 2). Departures from the text below, decided while
> building:
>
> - A1: physical locators live on `MemberInfo.files`, not on each
>   occurrence. A session in several folders is read as one record set
>   (shadow copies skipped, diverged copies unioned), so every anchor
>   resolves; the fork writes next to the newest copy holding the turn.
>   The health warning says copies are "read as one session", not "the
>   newest is used".
> - A2: "the last cwd" was wrong on real data: Claude records the shell's
>   cwd, which follows every `cd`. The session's directory is the last cwd
>   its project folder's name encodes, else the last that isn't inside or
>   above the previous one.
> - B3: the focus target is computed by the provider (`MemberInfo.tipId`):
>   Codex forks by reference hold turns they have no occurrence of.
> - B4: a fork titled "<parent> (fork)" is tagged `fork <id8>`; no colour
>   band.
> - C1: `AGENTREE_HOME` is environment-only (the settings live in it).
>
> Real stores after the change: Claude 62 → 61 entries (the moved session
> once, 52 nodes, filed under its new folder), Codex 87 and Copilot 5
> unchanged, no family changed shape; 85 Codex threads that the extension
> re-stamped when it loaded them now show their real last activity.

What to build next, and why. This is the agreed plan from product discussions
with the owner after the modernization reviews ([review-findings.md](review-findings.md)
and [review-findings-round-2.md](review-findings-round-2.md), both resolved).
Round 2's review read this plan too; its cautions are folded into A1, B3, B4
and C1 below. Treat it as the brief: each item says what is wrong today (with the
evidence), what to build, where in the code, and how to know it's done.

Read [AGENTS.md](../../../AGENTS.md) first. It explains the transcript formats, the
tree model and the decisions referred to here. Where this file and AGENTS.md
disagree about *current* behaviour, the code wins; check it.

## Ground rules (binding)

These come from the owner's earlier decisions and from AGENTS.md. Don't revisit
them without asking.

- **Never modify a harness's transcripts or databases.** Writes go only to new
  files in the harness's own fork format, through the harness's own API
  (`thread/fork`), or to Agentree's `~/.agentree/` sidecars.
- **Codex:** the tree comes from the raw rollout files; `codex app-server` is
  used only to fork. **Claude:** forks are written in the extension's own
  format; the Agent SDK is not bundled.
- **Store work runs in the backend worker** (`electron/backend.ts`). The host
  thread does IPC, watching and hand-offs only. New store-touching calls go
  in the `methods` table, not on the host.
- **Display grouping never decides a fork cut.** Fork anchors and their
  refusals (`forkBlocked`) come from the provider; the same-role merge keeps
  the last part's. Nothing in this plan may widen or narrow what a fork
  includes (AGENTS.md, "One node, several identities").
- **Fixtures first.** When behaviour depends on a transcript shape, add a
  synthetic fixture for it (`test/fixtures/make-fixtures.mjs`) before
  changing the parser. Tests assert exact ancestry and tree invariants, not
  only counts.
- **Settings change what you see or where data lives, never how a transcript
  is interpreted** (see Phase C).
- **Docs move with the code.** Each item below lists the docs it touches:
  AGENTS.md for mechanisms, README and `docs/user-guide.md` for behaviour.

## Order of work

| Phase | Items | Why first |
|---|---|---|
| **A. List correctness** | A1 duplicate sessions · A2 directory attribution · A3 recency · A4 list keys | The list currently shows wrong or duplicated data. |
| **B. Finding and seeing branches** | B1 provider filter · B2 branch names on cards · B3 search reaches branches · B4 named branches in the tree · B5 grouped list (optional) | The app's main purpose: seeing branched chats. |
| **C. Settings** | C1 settings store and panel | Needs A3's two recency values; small once A and B exist. |

A and B touch the same files (`Welcome.tsx`, `store.ts`, the Claude and Codex
list code) and can ship as one "welcome list" pass. Keep A's fixes in their own
commits.

---

## Phase A: list correctness

### A1. One session listed twice when its transcript exists in two project folders

**Observed (owner's machine).** A Claude session whose repo was renamed or
moved exists as two files with the **same session id** in two project folders:
the old folder holds an 11.8 MB copy, the new folder a 23.5 MB superset that
continues after the move. Agentree lists it twice. Filtering the welcome list
by an unrelated directory then left both cards stuck on screen (see A4).
Opening the session is ambiguous: `locate()`
([transcripts.ts:939](../../../electron/transcripts.ts#L939)) returns whichever
folder `readdirSync` yields first, so one copy can never be opened.

**Cause.** Two assumptions that don't hold:

1. a session id is unique across project folders;
2. families live inside one project folder. `listSessions` groups per folder
   ([transcripts.ts:1334](../../../electron/transcripts.ts#L1334)), so a fork or
   copy in another folder can never join its family.

**Build.**

- Index **logical session ids across all project folders** before grouping:
  one session id, many physical files.
- **Don't pick a copy by recency or size without proof.** Two copies can keep
  the same prefix and then each grow a different suffix; choosing the newer
  or larger one would silently drop a real branch (round-2 review). A copy
  whose record DAG is contained in another's (by uuid, which copies of the
  SAME session share) is a **shadow** and can be dropped from parsing; when
  neither contains the other, parse both and merge their DAGs (they share
  uuids, so the union is exact), or surface the conflict in health. Shadow
  identities stay in the cache signatures and are watched, so a shadow that
  gains records is re-evaluated. `locate()` uses the same resolution.
- Keep **project attribution separate from identity**: which folder(s) a
  session appears under is for the rail and filter (A2), not for deciding
  what it is.
- Put the physical locator (file path, project folder) on each
  **occurrence** (`TurnNode.occurrences`, `MemberInfo`), not only on the
  session, so a fork action picks a real file.
- **Group families across all project folders.** API message ids are global,
  so `groupFamilies` can run once over every summary (~7,000 ids on the
  target machine; cheap). A family's members may then have different cwds.
- The session watch (`registry.watchTargets`) covers every member's folder,
  not just the first one found.
- Health: count shadow copies as `skipped`, and say so in a warning ("N
  sessions have copies in more than one project folder; the newest is used").

**Done when.** A fixture with one session id in two folders (one a prefix of
the other) lists once, opens the superset, and a fork of it in a third folder
joins the family. A second fixture where the two copies diverge after a
shared prefix draws BOTH suffixes. Tree invariants hold. The welcome list on
the owner's machine shows that session once (round 2 confirmed it currently
appears twice: 52- and 16-node cards that both open the 52-node file).

**Docs.** AGENTS.md: "Claude Code" (families), "Live view", "Fail loudly".

### A2. A session is filed under the first directory it ever used

**Observed.** The session in A1 continued in its new folder for most of its
life, yet both cards say the old folder: the cwd is the **first** one recorded
(`if (!cwd && rec.cwd)`, [transcripts.ts:668](../../../electron/transcripts.ts#L668);
`readCwd` likewise, [transcripts.ts:951](../../../electron/transcripts.ts#L951)).
The rail counts it under the old, deleted folder.

**Build.**

- Use the **last** cwd recorded on a conversation record (user/assistant).
  That is where the session continues, and where "resume in terminal" should
  start.
- Normalise paths for comparison only: drive-letter case, `/c/…` vs `C:\…`,
  and a trailing separator. The same session records all three forms. Display
  the path as recorded.
- A family's directory is its root's (A1 makes cross-folder families
  possible). The directory filter should match **any** member's directory, so
  a fork made in another repo still shows under it. This is the owner's call;
  see Open questions.

**Done when.** A fixture whose records move from one cwd to another lists
under the second, in any of the three path spellings.

**Not a bug:** conversations whose folder no longer exists stay listed.
Transcripts are history, and resume falls back to the home folder.

### A3. The list sorts by the last write to the files, not the last activity

**Observed (owner's machine).** Five Codex threads whose last messages were on
Oct 21–24 all showed "7h ago", re-stamped within eight minutes of each other
on Oct 27. The records written then were `thread_settings_applied`, a
`task_complete`, `token_count` / `token_usage_record`, and a `response_item`
message: a background model call that produced no visible item. In effect,
the Codex extension touching threads when VS Code loaded them makes them look
recently used. So the list reads as "last opened", not "last worked on".

**Cause.** `updatedAt` is the newest timestamp on **any** record: Claude
`touchedAt` ([transcripts.ts:666](../../../electron/transcripts.ts#L666)), Codex
`page.touchedAt` ([codex.ts:353](../../../electron/providers/codex.ts#L353)). That
rule was chosen so a Claude session in a long tool loop (no new message for
minutes) still looks live. The rule is right; the set of records it counts is
too wide.

**Build.** Compute **two** values per session and keep both on `SessionMeta`:

- `activeAt`: last conversational activity (the default sort):
  - **Claude:** newest `user` / `assistant` record, including tool-only ones,
    plus delivered `queued_command` attachments and `compact_boundary`.
    Excludes titles, `last-prompt`, `mode` / `permission-mode`,
    `file-history-*`, `summary` and request-capture bookkeeping.
  - **Codex:** newest `item_started` / `item_completed` of **any** item type
    (tool calls included, so a long agent loop stays live). Excludes
    `thread_settings_applied`, `token_count`, `token_usage_record`,
    `task_started` / `task_complete`, `turn_context`, `world_state`,
    `response_item` and `session_meta`.
  - **Copilot:** newest `*.message` / tool event (check the event types
    against a real session first).
- `touchedAt`: today's value ("last file change"), kept for C1's sort option.

The welcome list sorts by `activeAt` and shows it. The relative time gets a
tooltip naming what it measures. Families use the max over members, as today.

**Done when.** Fixtures: a Codex thread with settings-only records after its
last item sorts by the item; a Claude session in a tool loop with no new prose
still sorts by its newest tool record. On the owner's machine the five threads
above show their real last-message dates.

**Docs.** AGENTS.md: "Welcome screen" (the `updatedAt` paragraph) and the Codex
section. User guide: the list's "N ago".

### A4. List keys are only the session id

**Observed.** With A1's duplicate, two cards had the same React `key`
([Welcome.tsx:225](../../../src/components/Welcome.tsx#L225)). When the list was
filtered, React didn't remove them, and they rendered above the filtered
results with stale content: they still showed their directory, which the list
prints only when no directory filter is set
([Welcome.tsx:232](../../../src/components/Welcome.tsx#L232)). The filter itself is
correct ([Welcome.tsx:95](../../../src/components/Welcome.tsx#L95)).

**Build.** Key by `provider:id`. Also dedupe defensively in
`registry.listAllSessions`: if two entries share `provider:id`, keep the newer
and log it. The user should never see a duplicate, even if a provider regresses.

**Done when.** A unit test on `listAllSessions` with a provider returning a
duplicate gets one entry.

---

## Phase B: finding and seeing branches

Background: a **fork family** (sessions linked by copied history) is **one**
card on the welcome screen, titled after its root, with an "N sessions" badge.
Chats that share a topic but not history are separate cards, correctly.
Agentree joins only on evidence (shared message or turn ids, explicit lineage).

### B1. Filter by agent

**Today** the search box matches title, directory and id only
([Welcome.tsx:98](../../../src/components/Welcome.tsx#L98)). The provider chips in
the health rows are decoration.

**Build.** Make the health-row chips toggles, backed by a `providerFilter`
held in `store.ts` next to `cwdFilter`. It combines with the directory and
search filters. The rail's per-directory counts follow it. The active-filter
bar ("show all") shows it, with a way to clear it. No query syntax.

**Done when.** One directory plus "Codex only" narrows correctly, and the rail
counts agree with the list.

### B2. Show a family's branch names on its card

**Today** a fork's own title (often more descriptive than the root's) appears
only in the side panel, after you open the tree and click a node in it.

**Build.** Add a compact line under the root title:
`⑂ <member title> · <member title> · …`, newest active first (A3), truncated
with "+N". Clicking a name opens the tree focused on that member (B3). This
needs the member list on `SessionMeta`: id, title and `activeAt`, computed
where `familyMeta` / `describe` already build members. Mind the family-meta
caches; their keys already cover every member's file identity.

### B3. Search reaches every chat in a family

**Build.**

- The search matches member titles and ids as well as the root's.
- A match on a member shows the root card with that member's name highlighted
  in the B2 line.
- Opening it (and B2's click) passes a **focus member**: `openSession(id,
  {focus})` in `store.ts` selects the newest leaf among nodes the member
  HOLDS, instead of the family's newest leaf. Membership is
  `sourceSessionId` OR an entry in `occurrences`: a shared turn is drawn
  under one member's id, and a fork with no turn of its own yet has no node
  whose `sourceSessionId` is its own — focus it on its last copied turn.

**Done when.** Typing a fork's title finds its family card. Opening it lands
on the fork's latest turn with the path highlighted.

### B4. Name the branches in the tree

**Today** the dashed edge shows *where* a fork starts but not *which* chat it
is. You have to click a node and read the panel.

**Build.**

- Label each node with `branchKind: "fork"` (a fork's first turn) with its
  member's title, drawn as a small tag above the node. The kind is explicit
  in the model, so don't infer fork-vs-edit from session ownership. Those nodes are always
  structural, never buried in a chain, so the tag always has a place.
- If the user set their own label on that node, show theirs and put the
  member title in the tooltip.
- `nodeWidth()` in `tree-layout.ts` must budget for the tag: SVG can't measure
  text before rendering, and the no-overlap guarantee depends on the width
  estimate.
- Optional, after the tags: a faint per-member colour band on node rims. Fork
  edges are long-dashed and collapsed chains dotted; the legend must keep
  those distinct.
- Codex prompt edits (`branchKind: "edit"`) are branches of the **same**
  thread, so they get no title tag (there's no separate chat to name). Leave
  them as dashed edges.
- A tag names the member; where the member's parent is `inferred`
  (`MemberInfo.parentEvidence`), the tooltip should say so, as the panel does.

**Done when.** A family with three named forks shows three tags. A fuzz pass
over random trees with tags (as for the original layout) finds no overlaps.

### B5. Optional: a grouped list view

Only if B2 and B3 aren't enough in practice. A toggle that shows a family as
its root card plus indented child rows, one per member, each with its own
`activeAt`. Sorting stays by the family's newest activity. Keep
one-card-per-family as the default.

**Docs for B.** README ("Everyday use"), the user guide (§3 tour, §4 "Keep a
busy tree readable", cheat sheet), AGENTS.md "Welcome screen" and "Layout"
(tags and node width).

---

## Phase C: settings

### What exists today

There is no settings UI and nothing is persisted. The VS Code extension
contributes only its command.

| Setting | Mechanism |
|---|---|
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME` | environment (`COPILOT_HOME` isn't in the README) |
| `AGENTREE_HOME`, `AGENTREE_CODEX_BIN` | environment |
| `AGENTREE_NO_UPDATE_CHECK` | environment, desktop only |
| compress chains | toolbar checkbox, not persisted (`compress`, [store.ts:121](../../../src/store.ts#L121)) |
| directory and search filters | welcome screen, not persisted |

Environment variables are awkward in VS Code: the extension host inherits
whatever environment VS Code was started with.

### C1. A settings store and panel

**The rule:** a setting changes **what you see** or **where data lives**,
never **how a transcript is interpreted**. Interpretation settings make trees
depend on configuration the reader can't see, and bugs impossible to
reproduce.

**Settings to add:**

1. **Sort conversations by:** *last message or tool activity* (default,
   `activeAt`) or *last file change* (`touchedAt`). There is deliberately
   **no** per-agent activity setting. Which records count differs per agent
   because their formats differ; that is an internal rule (A3), not a user
   choice.
2. **Agents to scan:** Claude / Codex / Copilot. Turning one off skips its
   scan (speed, noise). This is separate from B1's chips, which are a
   temporary filter.
3. **Show archived Codex conversations.** Today a family whose threads are all
   archived is always hidden
   ([codex.ts:884](../../../electron/providers/codex.ts#L884)).
4. **Remember view state:** compress chains, last directory, last provider
   filter.
5. **Open new forks in the chat panel automatically.** Today this is fixed
   per host: VS Code yes, desktop no
   ([NodePanel.tsx:146](../../../src/components/NodePanel.tsx#L146)).
6. **Data locations and the codex binary:** the environment variables above
   as editable paths. **Environment variables still override.**
7. **Launch update check:** desktop only.

**Where settings live:** `~/.agentree/settings.json`, edited from one in-app
panel (a gear on the welcome screen). Both hosts run the same renderer and the
same backend worker, so one implementation serves both. Concretely:

- add `getSettings` / `setSettings` to the backend `methods` table and the
  `AgentreeApi` contract (preload and VS Code shim);
- scan settings (2, 3, 6) are applied in the worker: `paths.ts` reads settings
  after the environment;
- view settings (1, 4, 5) are applied in the renderer;
- a settings change triggers one list refresh, AND rebinds what's bound to a
  path: the worker's caches for a moved root, and every installed watch
  (watch targets are resolved once, so a watch on the old root would keep
  watching it).

VS Code Settings UI integration (`contributes.configuration`) can come later
if synced settings across machines are wanted.

**Out of scope:** parser internals (stripped tags, counted record types, title
precedence), the health threshold, layout constants (`MIN_CHAIN`,
`CHAIN_ROWS`), debounce and poll intervals, and showing hidden plumbing
threads (Codex guardian reviews, subagents). The last belongs to the
"subagent lane" gap, if anywhere.

**Docs.** README "Configuration" (both the panel and the environment
variables, adding `COPILOT_HOME`), and a short user-guide section.

---

## Carried over (already tracked in AGENTS.md "Known gaps")

These are not part of the phases above. Listed here so nothing is lost.

- **Unverified hand-offs:** Claude `editor.open` for sessions outside the
  open workspace; the Codex `vscode://openai.chatgpt/local/<id>` deep link;
  resuming a Claude fork of a compacted session or of a turn ending in
  `tool_use`; any interaction inside the VS Code webview (theme, narrow
  widths); macOS and Linux terminal launch.
- **Scope items:** VS Code Copilot Chat provider (read-only); a weekly canary
  against real harnesses (needs API keys, so the owner's call); a subagent
  lane; an Electron installer; copying file-history snapshots into Claude
  forks; forking before a `/compact` (refused today, never tried).

- **From round 2, not in the phases:** sidecar writes are atomic per file but
  not across processes (desktop app + extension can race; last writer wins);
  an inferred fork direction can still be wrong for a batch-copied directory
  with renamed titles (labelled, not prevented).

## Open questions for the owner

1. **Directory filter with cross-folder families (A1/A2):** match the
   family's root directory only, or any member's? The recommendation is any
   member's.
2. **Keep "last file change" as a sort option (C1.1)** or drop it once
   `activeAt` is trusted?
3. **Publisher id:** `vscode-ext/package.json` uses `sadeeptha-b` as a
   placeholder. If the extension is ever published, it must match the
   Marketplace publisher id.

## Verification expected per item

- `npm run typecheck` and `npm test` clean.
- New fixtures for each new transcript shape; assertions on exact ancestry
  and tree invariants.
- A read-only smoke run over the owner's real stores (see the snippet in
  [review-handoff.md](review-handoff.md) §4, run with `AGENTREE_HOME` pointed
  at a scratch copy). Report before/after list counts and any family that
  changed.
- For UI items, a screenshot of the desktop app (the VS Code webview can't be
  driven by an agent; say so rather than imply it was checked).
