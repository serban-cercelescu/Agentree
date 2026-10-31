# Review handoff: Agentree modernization (branch `modernize`, 2026-10-27)

> **Historical handoff, 2026-10.** Retained with its assumptions, implementation corrections and evidence labels. It does not override the [current design notes](../../design.md) or [working instructions](../../../AGENTS.md). The [round 3 review](review-findings-round-3.md) has since been resolved; references below to `AGENTS.md` as the engineering manual describe its role at the time.

> **Status:** reviewed. The findings and their resolution are in
> [review-findings.md](review-findings.md); several [assumption]s below are
> now settled there (e.g. fork-by-`path` does not work on codex-cli 0.164,
> and the "first message id" family key was replaced). This file is kept as
> the record of what was handed to the reviewer; AGENTS.md is current.

This document is for an agent reviewing work done on Agentree in one long
session. It covers:

- what was asked and what was decided;
- what changed, feature by feature;
- what was checked, and how strong each check was;
- where the review should look hardest.

It is meant to be read **before** the diff. Read the documents in this order:

1. This file.
2. [`docs/modernization-handoff.md`](modernization-handoff.md): the brief the work
   started from. Its status note at the top lists the places where
   implementation contradicted it.
3. [`AGENTS.md`](../../../AGENTS.md): the design notes, rewritten during this work.
   Treat it as a set of **claims to check**, not as ground truth. It was written
   by the same agent whose work you are reviewing.
4. The diff: `git diff 58cf671..modernize` (`58cf671` is the pre-work baseline).

Every factual claim below carries one of these tags:

- **[verified]** observed on the owner's real data or by running the real tool;
- **[tested]** covered only by unit tests over synthetic fixtures;
- **[source]** read from vendor code that was shipped, but not executed;
- **[assumption]** inferred and never checked. **Prioritise these.**

---

## 1. Situation

| | |
|---|---|
| Repo | `C:\Users\SadeepthaBandara\source\repos\Agentree`, a fork of `serban-cercelescu/Agentree` (`origin` = `Sadeeptha-B/Agentree`, `upstream` = serban) |
| Owner's setup | Windows 11 and VS Code 1.143.1 (Electron 43). Claude Code extension 2.1.310 (CLI 2.1.296), Codex extension `openai.chatgpt` 26.1021 (codex-cli 0.162.1). The owner works in the VS Code chat panels and branches by forking from a message. |
| Goal | Show Claude and Codex conversations as trees, including the forks made in the VS Code extensions. Fork at any turn and hand off to the native extension. Work on Windows, and fail loudly when on-disk formats change. Copilot Chat is out of scope (a later phase). |
| Branch | `modernize`; nothing has been pushed |
| Commits | `30b1988` providers + tests · `f5882cd` UI · `3ca81e0` docs + v0.2.0 · `db34888` desktop app parity (round 3) · then this document |
| Tooling state | `npm run typecheck` is clean (app, Electron main, extension, tests). `npx vitest run`: 25/25 pass [verified at the end of the session]. Electron's binary was downloaded after the owner approved it (`allowScripts` in package.json). |

### What the owner asked, in order

1. Plan and implement the handoff doc's modernization for Claude and Codex
   (Copilot later). At the end, update AGENTS.md and give instructions for using
   the app and the extension.
2. Give a feature-level overview of the work and the remaining items.
3. Bring the Electron desktop app up to date "within the same scope". This
   happened after the owner approved the Electron binary download.
4. This review handoff.

### Decisions the owner confirmed (during planning)

| Decision | Choice | Why it matters for review |
|---|---|---|
| Source of the Codex tree | **Raw rollout files ("page graph"); `codex app-server` only for `thread/fork`** | This reverses the handoff's "use app-server for list and load", based on evidence (§3.2). Check that the evidence holds. |
| How Claude forks are written | **Reimplement the Claude VS Code extension's own fork format**, plus `forkedFrom` and a lineage sidecar. The Agent SDK is not bundled (its licence is "All rights reserved"; the repo is MIT). | The format is copied from minified vendor code (§3.1). Drift risk. |
| Git | Branch `modernize`, a commit per phase, no push | — |

---

## 2. Map of the change

New files:

```
electron/paths.ts                 lazy roots honouring CLAUDE_CONFIG_DIR / CODEX_HOME / AGENTREE_HOME (+COPILOT_HOME)
electron/shell.ts                 quote() + resumeCommand(): PowerShell 5.1 on win32, POSIX elsewhere
electron/health.ts                HealthScan: per-provider counters behind the welcome-screen status rows
electron/native.ts                nativeLink(): vscode:// deep links into the Claude / Codex extensions
electron/terminal.ts              desktop "resume in terminal": per-OS new terminal window
electron/providers/claude-fork.ts Claude fork-at-turn writer (replaces electron/fork.ts, now deleted)
electron/providers/codex-appserver.ts  minimal newline-JSON-RPC client; thread/fork only
scripts/electron.mjs              Electron launcher (strips ELECTRON_RUN_AS_NODE); replaces scripts/dev-app.mjs
test/{claude,codex,shell,desktop}.test.ts + test/fixtures/** (generated by make-fixtures.mjs)
docs/review-handoff.md            this file
```

Rewritten or substantially changed:

```
electron/transcripts.ts      Claude provider: parse refactor, family detection/stitching, health
electron/providers/codex.ts  full rewrite: paginated page graph + legacy path + fork via app-server
electron/providers/stitch.ts generalised: key-based structural stitch over DAGs
electron/registry.ts         Provider interface, guarded calls, allHealth(), providerById()
electron/watch.ts            family-directory watches, .jsonl.zst, archived_sessions
electron/main.ts, preload.ts, ipc.ts   new IPC: providerHealth, openNative, resumeInTerminal; Windows frame
electron/update.ts, build-electron.mjs update check follows the build's own git origin
electron/providers/copilot.ts          ported to paths/shell/health/members (logic otherwise unchanged)
shared/types.ts              ProviderHealth, MemberInfo, SessionRef, ActionResult; TurnNode.sourceSessionId/crossSession
src/components/NodePanel.tsx  member-session block, open/resume/fork actions
src/components/Welcome.tsx    health rows, "N sessions" badge, Windows path display
src/components/TreeCanvas.tsx + src/tree-layout.ts  dashed cross-session edges; crossSession nodes are structural
src/store.ts, src/styles.css
vscode-ext/src/extension.ts, shim.ts   openNative / resumeInTerminal / providerHealth
README.md, vscode-ext/README.md, AGENTS.md, package.json (scripts, v0.2.0), vscode-ext/package.json
```

The constraint to keep: **nothing below `main.ts`/`preload.ts` may import
`electron`**, because the VS Code extension bundles `registry.ts` and everything
it imports. `terminal.ts` and `native.ts` are pure Node for this reason.

---

## 3. Features: behaviour, evidence, weak spots

### 3.1 Claude Code

**On-disk reality the design rests on**

- **[verified]** The VS Code extension's "Fork conversation" writes a NEW
  transcript.
  - Every copied record gets a fresh `uuid` (with `parentUuid` re-linked).
  - It **keeps** `message.id`, `promptId`, `requestId` and timestamps. The one
    exception: the last copied record is re-stamped with the fork time.
  - It appends `{type:"custom-title", customTitle:"<title> (fork)"}`.
  - It writes **no lineage field**.

  The routine was read from `forkSession` in
  `~/.vscode/extensions/anthropic.claude-code-2.1.310-win32-x64/extension.js` [source] and
  confirmed on the pair `311498fc` ⟵ `792729c5` [verified]: 182 shared assistant
  message ids, 0 shared uuids. The copy also contains only the active chain: one
  of two parallel `tool_result` records was dropped.
- **[verified]** 65 transcripts on the machine form 4 families by shared
  `message.id`.

**Behaviour**

- **Families.** Sessions are grouped per project dir by:
  1. `forkedFrom.sessionId` on records;
  2. the lineage sidecar;
  3. a shared **first assistant `message.id`**.

  This last one is `groupFamilies`. The argument for it: the API mints that id
  once per response, so only a copy can share it. A shared opening prompt alone
  never merges sessions [tested: fixture session `S`].
- **Parent choice inside a family** (`familyParents`):
  1. explicit lineage;
  2. otherwise, ordering by the count of `(fork)` in the title, then file
     birthtime;
  3. the parent is the earlier member with the longest shared key prefix along
     its newest chain.
- **Stitching** (`stitch.ts`). A child node maps onto a tree node when the
  match keys are equal AND its parent is already mapped onto that node's parent.
  The first unmatched node is the divergence point; it gets `crossSession`.
  - Keys: replies use `m:<message.id>`; prompts use
    `u:<promptId ?? timestamp>|<80-char gist>`.
  - Stitching runs on unmerged nodes, and `mergeSameRoleRuns` runs afterwards.
    The merge never crosses sessions and never absorbs a `crossSession` node.
- **Titles.** Last `custom-title` > last `ai-title` > first real prompt.
  `ide_opened_file`, `ide_selection` and `ide_diagnostics` blocks are dropped
  (added to the DROP list, including the unpaired-opener/closer passes).
- **Fork** (`claude-fork.ts`). Walk the physical `parentUuid` chain from
  `node.lastRawId`, drop `progress` records, give fresh uuids, re-link each
  record to the previous copied one, and set `sessionId` to the new id. Keep
  timestamps, except the last record gets "now". Add
  `forkedFrom:{sessionId, messageUuid}`, then a `custom-title "<title> (fork)"`.
  Write a new file in the same project dir with the `wx` flag, and record lineage
  in the sidecar.
  - It refuses `injected`, `midTurn` and `preCompact` anchors.
  - It does NOT copy file-history snapshots or deltas (a deliberate choice; see
    the weak spots).

**Evidence**

- [verified] On real data, all 4 families list as one entry each, and the
  `311498fc` tree diverges at depth 14 with the fork's first prompt marked
  `crossSession`.
- [verified] End-to-end fork:
  1. Agentree forked `9c9017e6` after its first reply, creating `a85dba11`.
  2. `claude -p --resume a85dba11 "...what was my most recent question… did I
     mention a web app?"` answered with the first question and "no web app".
     The parent's second prompt was about a web app, so the fork had only the
     prefix.
  3. The resumed turn stitched in as a dashed branch off the correct node.
  - Note: the session's original cwd (`…\repos\map`) no longer existed, and the
    CLI found the session anyway.
- [tested] Fixture tests: the ide wrapper, `api-request-blob` ignored, the fork
  pair next to a rewind, the fork writer's output format, fork-of-fork
  (`(fork) (fork)` title, `forkedFrom` = the fork), and the shared prefix
  appearing once.

**Weak spots / review focus**

1. **[assumption] The "first assistant message.id" family key.**
   - Are there real cases where two sessions share a first message id without
     being forks? Candidates: the CLI's `--fork-session`, `/resume` behaviours,
     or sessions restored or copied by tools.
   - Conversely, a fork *started from a compacted session* might not begin with
     the parent's first message id. Check what the extension's fork copies after
     a `/compact`. The chain walk stops at the `compact_boundary` (null
     `parentUuid`). If the extension's own fork also starts there, its first
     assistant message id is a post-compaction one, so the family is **missed**.
     This is likely a real gap.
2. **[assumption] Parent ordering.** `(fork)` count first, then birthtime. If
   the owner renames a fork (dropping "(fork)") and file birthtimes are reset by
   a copy or restore, the parent and child can swap. The tree still renders, but
   the dashed edge lands on the wrong branch and the family root id changes.
   Annotations survive, because they're read from all members.
3. **User-prompt keys use `promptId`.** `promptId` is shared by a prompt and the
   `tool_result` records of that prompt, but those don't become nodes, so that
   is fine.
   - Check `queued_command` attachment projections: they now carry the
     attachment's `promptId`.
   - Check prompts without a `promptId` that fall back to `timestamp`. The fork
     re-stamps the *last* copied record. If a fork is taken *at a user prompt*
     (last copied record = a prompt without a `promptId`), the key changes, and
     that prompt would appear twice (once in the parent, once in the child).
     **Not tested.**
4. **Fork of tool-heavy sessions is unverified.** The end-to-end check used a
   4-turn session with no tools.
   - The chain walk mirrors the extension, which drops sibling records of
     parallel tool calls.
   - Whether `claude --resume` on such a fork produces an API error (a
     `tool_use` without a matching `tool_result`) or is repaired by the CLI's
     loader is **[assumption]**. Test a fork after an assistant turn whose last
     block was a `tool_use`.
5. **[assumption] The Claude VS Code extension's own session list/open copes
   with the extra `forkedFrom` field** on every record. Only the CLI was
   checked. The SDK writes the same field, which makes this likely.
6. **File-history snapshots are not copied**, so "rewind code" inside an
   Agentree-made fork has nothing to restore. The extension copies them and
   replays deltas into them. Decide whether this is acceptable or should be
   ported.
7. **The `preCompact` refusal is inherited from the old design.** With a
   copy-fork, forking *before* a compaction might work (the new file would
   contain the full pre-compact chain without the boundary). Unexplored, so it
   could be a capability that is refused unnecessarily.
8. **Opening a session in the panel** uses `claude-vscode.editor.open(id)`
   [source]. Whether it finds sessions whose cwd is outside the open workspace
   is **[assumption]**. The UI offers "resume in terminal" as the fallback.
9. **DROP_OPEN_TAIL / CLOSE_HEAD now include `ide_*`.** An unpaired literal
   `<ide_selection>` in prose (not in backticks) deletes the rest of that record.
   Low risk, but real.

### 3.2 Codex

**On-disk reality the design rests on**

- **[verified]** Codex uses paginated rollouts:
  - The first page of a thread is `rollout-…-<threadId>.jsonl[.zst]`. Later
    pages are `…-<threadId>_<pageId>.jsonl[.zst]`.
  - Every non-root page's `session_meta` has
    `history_base:{thread_id:<pageId>, end_ordinal_exclusive}`.
  - Ordinals are global and continue across pages.
  - Prompt edits (`turn_trigger:"edit_user_message"`) and forks are both new
    pages cut earlier.
  - **All 24 observed cuts land on turn boundaries**, and turn ids are shared by
    reference.
  - The handoff claimed 0 `history_base` occurrences because it hadn't
    decompressed the `.zst` files.
- **[verified]** `thread/turns/list` returns only the active path. For example,
  for `01a1396e` it returned 10 turns while its pages also contain abandoned edit
  turns.
- **[verified]** `thread/list` takes about 6 s, returns duplicate rows, and has
  `forkedFromId` empty. `thread/read` fills `forkedFromId`.
- **[verified]** `archived_sessions/` holds bases of live forks: archived
  `01a138ef` is the parent of `01a13945`.
- **[verified]** Item ids are not unique (`item-1`, `item-2` repeat per turn).
- **[verified]** `session_index.jsonl` maps `{id, thread_name}`; the last entry
  for an id wins.
- **[verified]** VS Code wraps user text as
  `# Context from my IDE setup: … ## My request:\n<prompt>`.

**Behaviour** (`codex.ts`)

- **Scanning.** Scan `sessions/` and `archived_sessions/` for `.jsonl` and
  `.jsonl.zst` files. `zlib.zstdDecompressSync` is feature-detected; when
  absent, health reports an error. Each page parse is cached by (mtime, size).
- **Turns per page.** Records are grouped by `payload.turn_id`, in ordinal order.
  - Within a turn, `UserMessage` becomes a user node. The IDE preamble is
    stripped (only when a `## My request` heading exists). A second
    `UserMessage` in the same turn is marked `midTurn`.
  - Consecutive `AgentMessage` items (commentary + final) join into one
    assistant node.
  - `Reasoning.summary_text` becomes thinking. Tool items become tool names.
  - `token_usage_record` is summed onto the turn's latest assistant node.
- **Node ids.** Nodes are `<turnId>:<itemId>`. `lastRawId` is the turn id
  (the fork anchor).
- **Tree.** A page's first turn hangs off `tailBefore(basePage, cut)`. Pages are
  placed in pageId order, and a duplicate turn id is placed once.
  `crossSession` is set when the page is a fork (a different thread) or an edit
  (`cut <= base.lastOrdinal`).
- **Families.** Families are union-find over base links, thread membership and
  legacy `forked_from_id`.
  - A family is hidden if all its pages are archived, or none has turns.
  - Guardian and subagent threads are dropped and counted as "hidden".
  - Missing bases produce a health warning and become separate roots.
- **Legacy (pre-paginated) rollouts** use the old `user_message`/`agent_message`
  parser plus content stitching. They can't be forked at a turn.
- **Fork.**
  1. Find the page that owns the turn.
  2. `onCurrentHistory` walks from the thread's newest page down its bases,
     narrowing the cut at each step. If the turn is on the current history, call
     `thread/fork {threadId, lastTurnId, excludeTurns:true}`. Otherwise pass
     `path` (that page's file).
  3. The binary is the newest one bundled with the Codex VS Code extension
     (`~/.vscode*/extensions/openai.chatgpt-*/bin/<plat>/codex(.exe)`), then
     PATH (`.cmd` via shell), or the `AGENTREE_CODEX_BIN` override.

**Evidence**

- [verified] Agentree lists 103 non-archived interactive threads, identical to
  app-server's unique `thread/list` ids (0 missing, 0 extra). That's 93 families
  from 122 parsed pages, with 161 guardian pages hidden and zero unknown record
  types.
- [verified] Family `01a1353f` renders as one tree of 5 threads (including
  archived `01a138ef`), with 9 dashed fork/edit edges. A screenshot was taken of
  the desktop app.
- [verified] Real fork: `01a08084` at turn 1 created thread `01a17c6d`. Through
  app-server, `thread/read` shows `forkedFromId = 01a08084`, and
  `thread/turns/list` shows exactly the one prefix turn. It took about 10 s.
- [tested] Fixtures: a `.zst` edit page, a fork through an archived thread,
  guardian hiding, a missing base, the IDE wrapper, steering, legacy stitching,
  and fork-target selection (by thread vs. by page path, with app-server mocked).

**Weak spots / review focus**

1. **[assumption] "The thread's newest page (largest UUIDv7 pageId) is its
   current/active history."** Edits always create a new page. But if Codex can
   switch back to an older edit branch, or rewrites state in SQLite, then
   "current" is wrong and the fork goes to the wrong path.
   - To check: compare `onCurrentHistory`'s choice with `thread/read`'s `path`
     for all threads that have more than one page.
2. **[assumption] Fork-by-`path` for turns on abandoned edit pages.** The API's
   doc comment says `path` overrides `threadId` [source]. It has never been
   executed. Its semantics with `lastTurnId` on a non-latest page are unknown.
3. **[assumption] Turns never span pages.** Observed to hold. The code guards
   duplicates by placing the turn once, but if a turn did span pages, the second
   page's part of that turn would be lost.
4. **The family "root"** is the base-less page with the smallest pageId. If the
   root thread is archived, the list entry's id and resume command point at an
   archived thread. Loading works (archived pages are scanned), but "resume" on
   the family header targets an archived thread. The panel's per-member actions
   are correct.
5. **`thread_source` values.** `chatgpt_handoff` and any unknown string are
   **shown**. Only `guardian_review`, `"subagent"`, object forms, and
   `source.subagent` are hidden. New plumbing sources would leak into the list.
6. **Usage attribution.** A `token_usage_record` that arrives before the turn's
   first `AgentMessage` is dropped (there's no assistant node yet). Check whether
   the per-turn token numbers look plausible against `token_count` totals.
7. **The IDE preamble** is stripped only when `## My request` (or
   `## My request for Codex`) is present. Other preambles (`# Files mentioned by
   the user:` with no request heading) keep the full text.
8. **Performance (also see §5).** A cold scan decompresses every page. The
   10 s fork time is mostly a fresh app-server per fork.
9. **The deep link `vscode://openai.chatgpt/local/<id>`** was read from the
   extension's router [source]. It was triggered once via `code --open-url`,
   but the result could not be observed (the extension logs to an output
   channel, not to disk). **[assumption] that it opens the thread.**

### 3.3 Copilot CLI

Ported mechanically: `paths.ts` roots, `shell.ts` resume commands, health
counters, and a `members` list. The parsing and fork logic are unchanged from
upstream. The machine has 5 sessions and they list [verified]. There are no
tests and no fork check. Review for regressions only.

### 3.4 Cross-cutting

- **Health** (`health.ts`, `registry.allHealth`).
  - Counted per scan: files seen, hidden, parsed, listed, versions, and unknown
    record types.
  - It warns when fewer than half of the candidate files parse.
  - A provider that throws is caught, and the other providers still list.
  - Claude counts unknown *top-level types* only. New bookkeeping types appear
    often (`artifact-*`), so these are listed but never escalated.
  - Check whether the 0.5 threshold and the "candidates = seen − hidden"
    definition actually fire on a real format break. The Codex break from
    before this work (0 parsed of 276) would have produced a warning.
- **Shell commands** (`shell.ts`).
  - win32: `Set-Location -LiteralPath '<cwd>'; <argv>` (PowerShell 5.1, with
    `''` escaping).
  - Elsewhere: POSIX `cd '<cwd>' && …`.
  - Bare words skip quoting (`[A-Za-z0-9_\-=.:/@]+`).
  - [tested]
- **Paths** (`paths.ts`). Every root is resolved lazily from env overrides,
  which is also what makes the tests possible. `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME` match the vendors' own variables.
- **Watching.** A session watch covers its family's *directory*: the Claude
  project dir, recursively. That includes `subagents/` and unrelated sessions in
  the same project, so they also trigger reloads. Codex and Copilot roots are
  also stat-polled every second. The filter accepts `.jsonl`, `.jsonl.zst` and
  `.yaml`.

### 3.5 UI (both hosts)

- **Panel.** "Conversation" (family) and "Session" (the member that owns the
  selected node, with a fork badge, the parent's title, and the entrypoint).
  - Actions: open in Claude Code / Codex, resume in terminal, copy resume
    command, copy id, and ⑂ fork after this turn.
  - In VS Code a fresh fork auto-opens in the chat panel. The desktop app shows
    buttons instead.
- **Tree.** Edges into `crossSession` nodes are long-dashed (`9 5`). Collapsed
  chains were changed to **dotted** (`0.1 5`, round caps) so the two can't be
  confused.
  - **Note:** this restyle was made after the last screenshot, so it has not
    been seen rendered.
  - `crossSession` nodes are structural (never buried in a chain).
- **Welcome screen.** A health row per present provider, an `N sessions` badge,
  Windows-aware `tilde()` / leaf-name display.
- [verified by screenshot, Electron on Windows] The welcome screen and the Codex
  family tree with dashed edges and the legend rendered correctly. The panel
  buttons were present.
- Not checked: dark/light theme in the VS Code webview, and the panel on narrow
  widths. **No interaction was performed in the VS Code webview** (the agent
  could not drive it).

### 3.6 Desktop app (Electron) parity, added in round 3

- **`openNative`.** `shell.openExternal(nativeLink(ref))`. Windows routes
  `vscode:` to `"…\Code.exe" --open-url -- "%1"` [verified via the registry].
  Whether the session actually opens is **[assumption]**, the same as §3.1.8
  and §3.2.9.
- **`resumeInTerminal`** (`terminal.ts`).
  - Windows uses
    `cmd.exe /d /c start "" /D "<cwd>" powershell.exe -NoExit -Command "<argv>"`
    with `windowsVerbatimArguments`. [verified]: a real launch in a directory
    named `agentree term & test` ran the command in that cwd.
  - The first design spawned `powershell.exe` with `detached:true` and **never
    appeared**. libuv maps `detached` to `DETACHED_PROCESS`, which leaves a
    console app with no console at all.
  - macOS (osascript + Terminal.app) and Linux (the first emulator found on
    PATH) are [tested] only.
  - A missing cwd falls back to home.
  - **Review:** cmd.exe expands `%VAR%` even inside double quotes. A cwd
    containing a literal `%NAME%` would be expanded. This is a low-risk nit:
    cwds come from the user's own transcripts, and session ids are
    regex-validated in the main process.
- **Window.** `titleBarStyle:"hiddenInset"` only on macOS. On other platforms
  it removed the window controls entirely. Windows and Linux now get the native
  frame plus `autoHideMenuBar`. The preload stamps `<html data-platform>`, and
  the CSS removes the macOS insets when the platform isn't darwin.
- **`ELECTRON_RUN_AS_NODE`.** [verified] Shells spawned from inside VS Code
  inherit `ELECTRON_RUN_AS_NODE=1`, which made `npm start` run Electron as Node
  and crash on `ipcMain` being undefined. `scripts/electron.mjs` (used by
  `npm start` and `dev:app`) and `bin/agentree.cjs` now delete it. [verified]:
  `npm start` from such a shell opened the app.
- **Update check.** `build-electron.mjs` stamps `repo` (owner/name) from
  `git remote get-url origin` into `build-info.json`, and `update.ts` compares
  `main` of *that* repo. The fallback repo is hard-coded to
  `Sadeeptha-B/Agentree`. The update command is
  `git pull` + `npm install` in host-shell syntax.
  - **Review:** with a feature branch checked out and pushed, comparing against
    `main` can produce "diverged" and show a banner whose `git pull` won't help
    on that branch. This was pre-existing logic, but now more likely in a fork.

---

## 4. Verification performed (complete list)

| What | How | Result |
|---|---|---|
| Typecheck | `npm run typecheck` (now includes `tsc -p vscode-ext` and `test/`) | clean |
| Unit tests | `npx vitest run` | 25/25 (claude 8, codex 8, shell 3, desktop 6) |
| Real-data listing | tsx smoke script over `registry.listAllSessions/allHealth` | claude 65 files → 60 listed (4 families); codex 284 files, 161 hidden, 93 families; copilot 5 |
| Codex completeness | Agentree threads vs app-server `thread/list` unique ids | 103 = 103, symmetric difference 0 |
| Codex page-graph premises | scratch scripts over all 276 files | 21–24 pages with `history_base`; every cut at a turn boundary; 1 missing base |
| Claude fork pair premises | scratch scripts on `311498fc`/`792729c5` | message/prompt/request ids and timestamps preserved; uuids not |
| Claude fork e2e | Agentree fork + `claude -p --resume` | the fork knows only the prefix; it re-stitches as a branch |
| Codex fork e2e | Agentree fork via app-server + `thread/read` + `thread/turns/list` | correct lineage and prefix |
| Electron app | launched with a scratch `-r` hook that clicked into a family and called `capturePage` (`--disable-gpu`; the GPU compositor failed in this sandbox) | renders; 9 cross edges; buttons present |
| Windows terminal | real launch via `openTerminal` into a cwd with a space and `&` | command ran in that cwd |
| vscode: protocol | registry lookup | registered to Code.exe `--open-url` |
| VS Code extension | `npm run build:vscode` + `vsce package` | builds. **The VSIX on disk predates round 3** (stale panel). |

**Not performed:** any interaction inside the VS Code extension webview; the
Claude and Codex deep links actually opening sessions; macOS and Linux; fork of
a tool-heavy Claude session; fork-by-path in Codex; a performance check inside
the VS Code extension host.

The smoke scripts live in the session scratchpad, not the repo. A minimal
replacement:

```ts
// save as smoke.mts at the repo root; run with: npx tsx smoke.mts
import { listAllSessions, allHealth, loadAnySession } from "./electron/registry.ts";
const all = listAllSessions();
console.log(allHealth());
for (const s of all.filter((s) => (s.members ?? 1) > 1))
  console.log(s.provider, s.id, s.members, s.nodeCount, s.branchPoints, s.title);
const d = loadAnySession(process.argv[2] ?? all[0].id)!;
console.log(d.members, d.nodes.filter((n) => n.crossSession).map((n) => [n.sourceSessionId, n.text.slice(0, 60)]));
```

**Caution:** if you run from a shell spawned by VS Code, `ELECTRON_RUN_AS_NODE`
is set. That doesn't matter for tsx, but launch Electron directly only with it
unset.

---

## 5. Prioritised review checklist

**P1: correctness that could mislead the owner**

1. Claude family detection after `/compact` (§3.1, weak spot 1). Find a
   compacted session that was forked in the extension, or construct one, and
   check whether it is joined.
2. The Codex "current page = newest pageId" rule (§3.2, weak spot 1).
   Cross-check against `thread/read`'s `path` for every multi-page thread.
3. Claude fork after a turn that ends in `tool_use`, and a fork taken at a user
   prompt (§3.1, weak spots 3 and 4).
4. Parent/child direction when titles are renamed and birthtimes are reset
   (§3.1, weak spot 2).
5. The stitch algorithm (`stitch.ts`) on adversarial DAGs: rewinds inside the
   *shared prefix* of both files, a parent that rewound *after* the fork, and
   interjection (`queued:`) nodes on either side.

**P2: robustness and performance**

6. **`listAllSessions` is synchronous** and runs on the VS Code extension
   host's event loop and in Electron's main process.
   - A cold scan took about 2.7 s on this machine, decompressing all the zstd
     pages; a warm scan about 14 ms.
   - That is a 2.7 s freeze of *all* extensions on first open, and again after
     cache-invalidating churn.
   - Consider moving it to a worker or making it async and chunked.
   - The pre-existing design was already synchronous.
7. Every `loadCodexSession` / `forkCodexAt` / `locateCodex` call runs
   `scanPages()`, which stats every file and rebuilds families. That's cheap
   when warm, but check that the watcher, at 1 s polling plus a 250 ms debounce,
   doesn't cause repeated full family rebuilds during a live Codex turn.
8. Health semantics: thresholds, and noise from Claude's unknown types.
9. The app-server client: timeouts, stderr ignored, `exited.catch` to avoid
   unhandled rejections, `.cmd` shim via `shell:true`. Check the
   arguments-are-constants claim.

**P3: fidelity to the owner's intent and to the docs**

10. Re-check AGENTS.md's numbered claims against the code. It was written by
    the same agent. Watch for statements that are stronger than the evidence
    above.
11. README usage steps: follow them literally on Windows (extension install and
    desktop app).
12. `package.json` still has `repository` = serban; `vscode-ext/package.json`
    still has `publisher` = `serban-cercelescu`. Is that intended? The owner
    hasn't been asked.
13. The handoff doc's §6 P0 asked for fixtures that include "a Copilot fork
    pair". That's not done (Copilot Chat is deferred, and Copilot CLI has no
    fixtures).

**P4: style and consistency**

14. The repo convention is long "why" comments (see the original files). New
    code follows it. Check that the comments don't overstate verification.
15. Line endings: the working tree is CRLF (`core.autocrlf=true`). Several files
    were normalised to LF before editing; git normalises them on commit.
    `test/fixtures/.gitattributes` sets `-text` so the fixtures stay
    byte-exact.

---

## 6. Side effects on the owner's machine (made during verification)

- Claude session **`a85dba11-91f0-4b5d-9d19-ef60dc6d7302`**: an Agentree fork of
  `9c9017e6`, written to `~/.claude/projects/c--Users-SadeepthaBandara-source-repos-map/`.
  One real `claude -p` turn was spent on it. A `~/.agentree/lineage.json` entry
  was written for it.
- Codex thread **`01a17c6d-c757-7562-9886-3e9876e35c5f`**: a fork of
  `01a08084` (in Codex's sessions and state DB). Its deep link was also sent to
  the owner's VS Code once (`code --open-url`).
- The owner has been told these can be deleted or archived. Don't treat them
  as real user data when reviewing family counts.
- Temporary directories (`agentree-claude-*` under the OS temp dir from tests,
  and `agentree term & test`) were cleaned up, except the vitest temp copies,
  which are left to the OS.
- The Electron binary was downloaded and `allowScripts` added to `package.json`
  (the owner approved this).

---

## 7. Out of scope / remaining work (as told to the owner)

- **VS Code Copilot Chat provider (phase 4).** Read-only: op-log replay, plus
  workspace→folder mapping, dedupe by sessionId, and fork matching on user AND
  assistant text plus the "Forked:" title. Format notes are in handoff §3.3.
- **Weekly canary CI (phase 5).** It needs API keys and money, so it's the
  owner's decision.
- **Smaller items:**
  - a resident app-server for faster Codex forks;
  - copying file-history snapshots in Claude forks;
  - a subagent lane;
  - an Electron installer package;
  - repo metadata pointing at the fork;
  - rebuilding the VSIX after round 3.

---

## 8. What the review should produce

- A list of **confirmed defects** (with a reproduction, or a code path plus a
  concrete input), **plausible risks** (what evidence would settle them), and
  **doc claims that overstate the evidence**. Order them by the impact on the
  owner's main use: seeing branches correctly in VS Code, and forking from the
  right point.
- For each §3 "[assumption]" you were able to test, record the result, so the
  next round can upgrade the tag in AGENTS.md.
- Do not "fix" the owner-confirmed decisions in §1 without raising them first.
  These are: raw Codex files, a reimplemented Claude fork, and no SDK.
