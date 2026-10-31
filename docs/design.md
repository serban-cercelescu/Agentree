# Agentree design and engineering notes

Current implementation context, consolidated on 2026-10-27 from the engineering material formerly in `AGENTS.md` and updated for the round 3 resolution. This document preserves provider research, observed behavior, rationale and earlier failed approaches. Working commands and ownership boundaries live in [AGENTS.md](../AGENTS.md); user workflows, settings and limitations live in the [user guide](user-guide.md).

> **Reviews:** the findings of the [round 3](archive/2026-10-modernize/review-findings-round-3.md#resolution), [round 4](archive/2026-10-modernize/review-findings-round-4.md#resolution) and [round 5](archive/2026-10-modernize/review-findings-round-5.md#resolution) reviews are resolved; each report maps its findings to fixes and regression tests. The contracts they established are described below: [membership and focus](#membership-focus-and-family-lifecycle) (with a node's [start and end](#a-node-starts-and-ends)), the [fork point](#the-fork-point), the [identity scheme](#identity-scheme-and-compatibility), [metadata across copies](#one-session-several-folders), [Codex vocabulary selection](#codex-the-page-graph), [settings isolation and launch environment](#settings), the [worker method table](#the-backend-worker), [annotation ownership, reconciliation and write failures](#annotations), the [live view](#live-view) and the [Windows terminal launch](#windows).

## Contents

- [Architecture and host/worker boundary](#architecture)
- [One node, several identities](#one-node-several-identities)
- [Harnesses, one tree model](#harnesses-one-tree-model)
- [Codex page graph and forks](#codex-the-page-graph)
- [Claude Code, source copies, stitching and forks](#claude-code)
- [Copilot CLI](#copilot-cli)
- [Health and format drift](#fail-loudly)
- [Chains](#chains) and [layout](#layout)
- [Live view and family lifecycle](#live-view)
- [List identity, membership and activity](#welcome-screen)
- [Settings implementation](#settings)
- [Load and caches](#not-dying-under-load)
- [Annotations and persisted data](#annotations)
- [Windows and launch behavior](#windows)
- [Verification evidence](#tests)
- [Rendering and assets](#notes)
- [Known gaps and further work](#known-gaps)

Facts marked **verified** were observed on real data or by running the
installed tool; **source** means read from shipped vendor code but not
executed; **tested** means synthetic fixture coverage. Anything unmarked that
matters is called out as unverified. Versions
as of 2026-10-27: Claude Code extension 2.1.310 / CLI 2.1.296, Codex extension
`openai.chatgpt` 26.1021 (its bundled codex-cli is 0.164.0-alpha.11.1; rollouts
on disk span 0.145–0.164), VS Code 1.143 (Electron 43). The harnesses change their on-disk formats without notice.
When that happens, the welcome screen's health row is the first place it shows
(see "Fail loudly").

## Architecture

Two local hosts, VS Code or Electron, with **no HTTP server**. The renderer has no Node access, and
everything crosses the contextBridge as a handful of typed IPC calls. The
host (Electron main, or the VS Code extension host) does no transcript work
itself: every call that reads or writes a store runs in a **backend worker
thread**.

```
assets/                        logo.png (transparent), sized variants, logo.icns
electron/main.ts               BrowserWindow + ipcMain handlers; forwards store calls to the backend
electron/preload.ts            contextBridge → window.agentree, and nothing else
electron/backend.ts            the table of store calls the worker serves (list, load, annotate, fork, health, watch targets)
electron/worker.ts             worker-thread entry serving backend.ts (bundled as worker.cjs)
electron/backend-client.ts     host-side handle on the worker: async proxy, restart on crash
electron/registry.ts           Provider interface; routes by "who owns this id"; health; annotate; watch targets
electron/paths.ts              every root, lazily: environment variable > settings > default
electron/settings.ts           ~/.agentree/settings.json: validated per field, cached by stat
electron/shell.ts              resume argv per harness + commands in the host shell's syntax (PowerShell / POSIX)
electron/launch.ts             a session's resume launch (argv + store environment), resolved in the worker
electron/native.ts             vscode:// deep links into the Claude Code / Codex extensions
electron/terminal.ts           desktop "resume in terminal": a new OS terminal window
electron/update.ts             desktop launch-time update check against the build's own origin
electron/health.ts             per-scan counters for the welcome screen's status rows
electron/transcripts.ts        Claude Code provider: parse, fork families, list/load
electron/providers/claude-fork.ts   Claude fork-at-turn (writes the extension's fork format)
electron/providers/codex.ts         Codex provider: paginated page graph, legacy rollouts
electron/providers/codex-appserver.ts  JSON-RPC client for `codex app-server` (thread/fork)
electron/providers/copilot.ts       Copilot CLI event logs → nodes, fork-by-copy
electron/providers/stitch.ts        key-based stitching of copy-forked sessions into one tree
electron/identity.ts           semantic node identity (stableIds): digests, bounded qualification, older schemes
electron/lineage.ts            fork-parentage sidecar (~/.agentree/lineage.json)
electron/meta.ts               sidecar annotation store (~/.agentree/meta/): every identity scheme, member reconciliation
electron/watch.ts              live view: fs.watch + stat polling of targets the backend resolved
shared/types.ts                node/session/health types + the IPC contract
shared/render.ts               lineage walks, branch counting, token math
src/tree-layout.ts             chain compression + tidy layout
src/components/                TreeCanvas (the SVG) · NodePanel · Toolbar · Welcome · Settings
src/list.ts                    welcome-list rules: filters, rail, search, fork names
vscode-ext/                    VS Code extension: same providers, same renderer
test/                          vitest suites, synthetic fixtures (test/fixtures/make-fixtures.mjs), a fake codex app-server
```

`contextIsolation: true`, `nodeIntegration: false`. A viewer that reads your
entire conversation history shouldn't also hand the page `require`.

### The backend worker

A cold scan decompresses every Codex page and parses every Claude transcript:
about 2.6–4.8 s on the target machine (warm: ~20 ms, from the caches). On the
host thread that froze the whole VS Code extension host, or the Electron
window. So `backend.ts` runs in a `worker_threads` worker, built as
`worker.cjs` next to each host bundle. The worker owns the parse caches; the
host keeps only what must live there: IPC, `fs.watch`/stat polling, opening
terminals and deep links. Verified: during a 4 s cold scan driven through
`backend-client.ts`, a 50 ms timer on the host thread kept firing (71 of 83
expected ticks; before, none).

- The host never imports a provider. `backend-client.ts` imports backend.ts
  for its **type** only, and resume argv lives in `shell.ts` so the host can
  build terminal commands without loading parsers. `grep` the built
  `main.cjs` / `extension.cjs` for a parser symbol if in doubt.
- Because of that, the proxy can't read the worker's method table at run
  time; it restates the names as a record over `MethodName`
  (`METHOD_NAMES`), which the compiler checks for completeness. A method
  added to `backend.ts` and not there fails typecheck. (Before, a separate
  name list omitted `resumeLaunch`, and terminal resume threw in both hosts:
  [round 5 finding 2](archive/2026-10-modernize/review-findings-round-5.md#r5-2).)
- Watch targets are resolved in the worker (finding a session's files can mean
  a scan) and watched on the host (`watchLater`).
- A worker that dies fails the calls in flight and is restarted on the next one.
  Calls belong to the worker **generation** they were sent to: a dying worker
  emits `error` and then `exit`, and a retry made on the first event already
  lives on the replacement, so each worker fails only its own pending calls.
  `dispose` is final.

### VS Code extension (the primary product)

The Electron split maps one-to-one onto a VS Code extension built from the
SAME sources by `build-vscode.mjs` (`npm run build:vscode`):

- The extension host bundles `backend-client.ts`, `watch.ts`, `shell.ts`,
  `native.ts`; its `worker.cjs` bundles the registry and every provider.
  Nothing below `main.ts`/`preload.ts` imports Electron. Keep it that way.
- **Minimum VS Code is 1.101**: the first release on Electron 35 / Node
  22.15, the first Node with `zlib.zstdDecompressSync`. The extension host
  runs VS Code's bundled Node, never the system one, so an older VS Code can't
  read compressed Codex pages however new the installed Node is.
- The webview runs the unmodified renderer. `vscode-ext/src/shim.ts`
  implements the exact `window.agentree` surface over `postMessage`. It is
  loaded as a classic script before the module bundle, because `src/api.ts`
  reads `window.agentree` at module-eval time.
- Both hosts implement the same two hand-off actions, each in its own way:

  | | VS Code extension | Desktop app (Electron main) |
  |---|---|---|
  | `openNative` | Claude: `claude-vscode.editor.open(sessionId)` in-process. Codex: `openExternal(${uriScheme}://openai.chatgpt/local/<id>)` | `shell.openExternal(nativeLink(ref))`, the same `vscode://` deep links. Windows routes them to `Code.exe --open-url` |
  | `resumeInTerminal` | integrated terminal in the session's cwd | a new OS terminal window (`terminal.ts`) |

  The links come from the extensions' own URI handlers.
  `anthropic.claude-code` handles `/open?session=<id>` by calling
  `claude-vscode.primaryEditor.open`. `openai.chatgpt` forwards the path to
  its webview router, which routes threads at `/local/<id>`. A session whose
  cwd no longer exists resumes from the home directory; the CLIs still find
  it by id.
- `api.host` (`"vscode"` | `"electron"`) tunes wording and the default hand-off
  behaviour: in VS Code a fresh fork opens itself in the chat panel, while the
  desktop app shows the buttons. The open-fork setting can override that default.
- Host-side watchers are token-keyed like the ipcMain map and closed on panel
  dispose.
- The webview HTML links `index.css` by hand (Vite has no index.html to inject
  into), overrides the macOS traffic-light insets, and pins the theme vars to
  VS Code's `body.vscode-dark/-light` classes instead of the OS
  `prefers-color-scheme`.
- `onUpdateAvailable` is a no-op there; the extension updates through VS Code.

Package with `npm run package` inside `vscode-ext/`. F5 from the repo root
launches an extension-development host. `npm run typecheck` covers the
extension too (`tsc -p vscode-ext`).

## One node, several identities

A drawn `TurnNode` represents several different layers, and the fields
keep them apart, because each answers a different question:

| Layer | Field | Answers |
|---|---|---|
| **message** (semantic) | `stableIds` (`legacyIds`) | which message is this, in every copy? Claude `m:<message.id>` / `p:<promptId>|<digest>`, Codex `<turnId>:<itemId>`; text-only evidence (no prompt id, Copilot, legacy Codex) is qualified by its parent's identity ([scheme](#identity-scheme-and-compatibility)). Keys annotations, carries a selection across a re-rooted reload |
| **occurrence** (physical) | `sourceSessionId`, `occurrences` | which session supplies the drawn message, and which other members have copies under their own raw ids? |
| **membership** | `heldBy` | which member sessions' history holds ALL of this node — the sessions that open or resume onto it? |
| **vendor turn** | `turnId` | which unit of work can a fork cut after? (Codex turn; Claude records are each an anchor) |
| **display group** | `absorbedIds`, `lastRawId`, `forkBlocked` | what the same-role merge folded together, and the ONE anchor a fork after it uses |
| **edge** | `branchKind` | how the branch into it was made: `fork` (a new session) or `edit` (a Codex prompt edit, same thread) |

The rule that ties them: **display grouping never has authority over a fork
cut, nor over membership.** The merge never folds across vendor turns, and a
merged node's anchor and verdict are its LAST part's, so an enabled "fork
after this turn" includes every message the node shows and nothing after it.
(The first version fell back to an earlier anchorable part and silently
forked before a shown mid-turn message or second prompt; two such nodes
existed in the owner's Codex history.) Nor does the merge fold across a
member's **endpoint**: a run continues only into a part held by exactly the
sessions that held the part before it. So whoever holds a copy of any part
of a merged node holds all of it, and a quiet fork's selected endpoint shows
only what it contains. (Before, a quiet fork that copied one reply was drawn
ending on that reply merged with its parent's next one — [round 3 finding 2](archive/2026-10-modernize/review-findings-round-3.md#r3-2).)
Physical file locators live on the session
(`MemberInfo.files`), not on occurrences: a session stored in several files
is read as one record set, so every anchor resolves whichever file holds
it (see "One session, several folders").

### The fork point

A node id names a display group's **head**, not where the group ends, and
the group can change between the snapshot the user clicked in and the one
the backend reloads: a quiet fork appearing splits a run under the same
head, one disappearing folds the head into a longer run, a live reply
extends it. So a fork request carries the cut as drawn — `ForkPoint`
(`forkPointOf`): the node id, the session it is drawn from, and the record
its last part ends on (`lastRawId`). Every provider resolves it the same way
(`resolveForkPoint` in `shared/render.ts`): the same node while it still
ends there, else the one node that now does (a split), else a refusal asking
the user to reselect. An old head id is never read as a different range.
For Codex the end is the turn, so a turn that gained prose is still that
turn; one that gained a steering prompt is refused by its `forkBlocked`.

The renderer keeps the same contract across a reload: `carry` selects the
node that ends where the selection did before falling back to the same id
(a group that grew or was folded in) and then to `stableIds` (a re-rooted
family). Before, a split shortened both the selected prefix and a fork
taken from it ([round 5 finding 3](archive/2026-10-modernize/review-findings-round-5.md#r5-3)).

### Membership, focus and family lifecycle

Canonical display ownership, member history and action intent are separate:

- `sourceSessionId` is the canonical session supplying a drawn node. Shared
  history appears once; it can belong to several members simultaneously.
- `heldBy` lists every member whose history holds the whole node, set by the
  provider on a loaded family. Claude, Copilot and legacy Codex: the owner
  plus every session with a copy (`copyHolders`: owner and occurrences),
  which is exact because the merge never crosses an endpoint. Codex: the
  threads whose current page/base history holds the turn — an inherited turn
  need not be copied into a thread's files, so occurrences can't say it.
- `MemberInfo.tipId` is the latest-ending leaf among the nodes that list the
  member in `heldBy` (`assignTips`), the same rule for every provider.
- **Focus is view state** (`State.focus` in the renderer store). Opening a
  member by name (`openSession(id, {focus})`) selects its tip and focuses it.
  Open/Resume act on the focused member wherever the selected node lists it
  in `heldBy`, otherwise on the node's canonical owner (`actionTarget` in
  `shared/render.ts`). A node held by several members offers a selector in
  the panel's Session block, which changes the focus. Selecting nodes keeps
  the focus; a reload keeps it while the member is still in the family;
  opening the family without one clears it. Before, a quiet fork's shared
  node offered its parent's actions ([finding 3](archive/2026-10-modernize/review-findings-round-3.md#r3-3)).
- A fork's first own node receives the fork edge/tag. A quiet fork still
  counts as a member and appears in the list's fork names, but creates no
  distinct drawn suffix.
- Families can gain members, lose their original root, or split if the
  evidence linking them disappears — a deleted member that alone shared
  history with two others leaves two families. Any member's id loads the
  family it is in now, so reload asks first for the focused member, then
  for the sessions holding the selected node, and only then for the old root
  and the other members; the first that loads is adopted, and the selection
  is carried by its [fork point](#the-fork-point), then `stableIds`. The old
  root still loading proves only that it survived, not that the user's
  member is still with it ([round 4 finding 4](archive/2026-10-modernize/review-findings-round-4.md#r4-4)).
  The focus can change while the stores are read: a result looked up for an
  earlier choice that doesn't hold the current one is not adopted, and the
  lookup runs again from the current choice, so a member choice stands until
  the user changes it or the member is gone ([round 5 finding 4](archive/2026-10-modernize/review-findings-round-5.md#r5-4)).
  Nothing reconstructs a relationship for which no evidence survives.
  Annotations are reconciled as membership grows (see [Annotations](#annotations)).

### A node starts and ends

`timestamp` is when a node **starts** (its first record or part): it is what
the panel shows and how siblings are ordered. `endedAt` is when its **last**
part was written, where that is later — a reply streamed as several records,
a same-role run, Codex commentary followed by a final answer. Which branch was
active last is always read from the end (`endOf`): `newestLeaf` (the family's
tip and "following") and `heldTip` (each member's tip). Ranked by start, a run
continued after a sibling branch was written looked older than it, and
focusing its member landed on the sibling ([round 4 finding 3](archive/2026-10-modernize/review-findings-round-4.md#r4-3)).
The list's sort setting doesn't touch this: it orders sessions, not leaves.

### Identity scheme and compatibility

Stable keys are a persistence contract: annotations are saved under them.
`electron/identity.ts` owns the scheme; this is **scheme 4**.

- Text is digested **exactly as parsed** — the first 20 hex characters of
  SHA-1 over the whole text, whitespace included. Indentation and line breaks
  are meaning in code, and every copy-fork preserves text byte for byte.
  (Scheme 2 folded whitespace runs, so two prompts differing only in an
  indented line collided: [finding 1](archive/2026-10-modernize/review-findings-round-3.md#r3-1).)
- A **strong** key stands alone: `m:<message.id>`, `p:<promptId>|<digest>`,
  Codex `<turnId>:<itemId>`.
- A **weak** key (text only: a Claude prompt with no prompt id, Copilot,
  legacy Codex) is qualified by its parent's identity at a fixed size:
  `w:` + 24 hex of SHA-1 over the JSON array `[key, parentIdentity]`
  (`"root"` without a parent). Exact copies get identical keys; the same text
  under another parent gets another. (Scheme 2 used the literal
  `key@parentIdentity`, quadratic in a long chain: [finding 7](archive/2026-10-modernize/review-findings-round-3.md#r3-7).
  On the owner's history the longest key went from 945 characters to 91.)

Earlier keys stay readable (`meta.ts`, see [Annotations](#annotations)):

| Scheme | Form | Found by |
|---|---|---|
| 1 | Raw per-file uuids | The node's own, absorbed and occurrence ids |
| 2 | Prompt keys `u:<promptId>\|<folded digest>`; weak keys as `k_n@…@k_1@base` literals | `legacyIds`: each part's scheme-2 identity where it differs, computed with the same bounded hash over the folded keys. A saved literal is converted to that form by folding it from its base (`scheme2Fingerprint`), so the quadratic string is never rebuilt |
| 3 | Prompt keys `u:<promptId>\|<exact digest>`; `w:` weak keys | `legacyIds`: each part's scheme-3 identity where it differs (a weak key under a prompt-id parent changed with that parent) |
| 4 | Prompt keys `p:<promptId>\|<exact digest>`; `w:` weak keys | `stableIds` |

Why scheme 4: schemes 2 and 3 saved prompt keys in the **same form**, `u:…`,
so a saved `u:` key can't say which scheme wrote it — and for two prompts
sharing a prompt id and differing only in whitespace, scheme 2's key for one
is scheme 3's for the other. Writing to one then patched the other's label
as its "old" key ([round 4 finding 1](archive/2026-10-modernize/review-findings-round-4.md#r4-1)).
Current keys now have forms no earlier scheme saved with another meaning:
`p:` is new, `m:` and Codex keys never changed meaning, and a `w:` key
means the same in schemes 3 and 4 unless its parent chain changed — then
the scheme-3 one is a legacy id. There is still no version field. An older
key is used only under the [ownership rule](#annotations): one that two
nodes of the family answer to is given to neither, and left on disk as it is.

## Harnesses, one tree model

Everything downstream of parsing (layout, chains, annotations, the panel)
sees only `TurnNode[]`. Each provider's job is to make a very different store
produce that one shape:

|                    | Claude Code | Codex | Copilot CLI |
|--------------------|-------------|-------|-------------|
| transcript         | JSONL, one record per content block | paginated JSONL pages, `.jsonl` or `.jsonl.zst` | JSONL event log per session dir |
| structure          | native DAG (`uuid`/`parentUuid`) | page graph via `history_base` (exact tree) | linear `id`/`parentId` event chain |
| a fork is          | a NEW file holding a copy of one chain (no lineage field) | a NEW thread whose first page references the parent page (0.153–0.162 also wrote copied prefixes) | a copy-truncated session dir |
| other branches     | rewinds inside one file | prompt edits: a new page of the same thread | none |
| clean display text | must be cleaned (wrappers, ANSI, `ide_*`) | `item_completed` `UserMessage`/`AgentMessage`; strip the VS Code context preamble | `data.content` on `*.message` events |
| plumbing to avoid  | `<system-reminder>`, `<ide_*>`, command wrappers, task notifications, `api-request-blob` | `response_item` messages (`role: developer`/`user` harness injections) | `transformedContent` |
| usage              | `message.usage` per record | `token_usage_record` per response (input includes cached; converted) | not recorded per turn |
| resume             | `claude --resume <id>` | `codex resume <id>` | `copilot --resume=<id>` |
| fork after turn N  | Agentree writes the extension's fork format (`claude-fork.ts`) | `codex app-server` `thread/fork {threadId, lastTurnId}`, whole turns only | copy dir, truncate events.jsonl, rewrite ids |
| open in VS Code    | `claude-vscode.editor.open(id)` | `vscode://openai.chatgpt/local/<id>` | — |

**Invariant:** never modify a harness's transcripts or databases. Writes go
only to new files in the harness's own fork format, through the harness's own
API (`thread/fork`), or to Agentree's `~/.agentree/` sidecars.

## Codex: the page graph

Verified on 286 rollouts / 25 cuts.

```
~/.codex/sessions/Y/M/D/rollout-<localStamp>-<threadId>.jsonl[.zst]            a thread's first page
~/.codex/sessions/Y/M/D/rollout-<localStamp>-<threadId>_<pageId>.jsonl[.zst]   later pages
~/.codex/archived_sessions/…                                                  same, archived
~/.codex/session_index.jsonl                                                  {id, thread_name} lines, last wins
```

- Every record has `timestamp`, `ordinal`, `type` and `payload`. **Ordinals are
  global** and continue across pages.
- A non-first page's `session_meta` carries
  `history_base: {thread_id: <pageId>, end_ordinal_exclusive}`: "my history is
  that page's history before this ordinal, then my own records".
  - A **prompt edit** (`turn_trigger: "edit_user_message"`) starts a new page of
    the same thread, cut before the edited turn.
  - A **fork** starts a new thread whose first page is cut after the chosen
    turn. It also records `forked_from_id` / `forked_from_ordinal_exclusive`.
- **Every observed cut lands on a turn boundary.** So the tree is exact, with
  no matching: a page's first turn hangs off the last turn of its base with
  `firstOrdinal < cut` (recursively through the base's own base).
- **History encoding and event vocabulary vary independently**, and are read
  independently. A page speaks one vocabulary. `history_mode: "paginated"`
  pages use items. Any other page is read by what carries its **prose**
  (`readsAsLegacy`): items when a `UserMessage`/`AgentMessage` item exists
  (legacy prose events beside them are then not read), legacy events when
  only they carry prose, and items when there are items and no prose of
  either kind, so an untaught item vocabulary still counts as failed. An
  item's presence proves nothing on its own: a VS Code rollout of CLI
  0.164.0-alpha.11.1 (observed) has legacy prose and one completed
  `Extension` item, and switching on that item emptied the conversation
  ([round 5 finding 1](archive/2026-10-modernize/review-findings-round-5.md#r5-1)). Codex 0.153–0.162 also wrote forks of paginated threads as
  **copied prefixes**: `forked_from_id`, no `history_base`, and the parent's
  turns physically repeated (verified: 7 such forks on the target machine,
  their copied turn ids and items identical to the parent's). With the item
  vocabulary the copy aligns on turn ids: a turn already placed is drawn once,
  and the first own turn after a prefix copied from another thread gets the
  fork edge. Pages are placed in page-id order (UUIDv7 = creation order), so a
  source is always placed before its copies. Explicit `forked_from_id`
  joins families whatever the encoding.
- Older pages are **zstd-compressed** (232 of 276 here). They are read with
  `zlib.zstdDecompressSync`, which exists in Node ≥ 22.15 / 23.8 and VS Code's
  Electron 43. It's feature-detected, and its absence is a health error.
- **Archived threads can be bases of live forks** (verified: an archived
  thread was the parent of two live ones), so `archived_sessions/` is always
  scanned. A family whose every thread is archived gets no list entry unless
  the user enables the archived-conversation setting.
- A page whose base is no longer on disk becomes a separate root and raises a
  health warning (one such page on the target machine).
- `thread_source: "guardian_review"` (auto-review threads, the majority here)
  and subagent sources are Codex's own plumbing, so they're hidden and counted as
  "hidden" in health.
- A page holding turn records that yield no turn counts as **failed** in
  health (an item vocabulary nobody taught the parser), not as parsed. It
  stays in the graph, since other pages may continue it.
- Display stream: `event_msg` → `item_completed` →
  - `UserMessage` (`content[].text`). VS Code prefixes it with
    `# Context from my IDE setup: … ## My request:\n`, so keep the part after
    the heading. A second `UserMessage` inside one turn is steering typed
    mid-turn and is marked `midTurn`.
  - `AgentMessage` (`content[].text`, `phase` = `commentary` | `final_answer`).
    All of a turn's prose folds into one assistant node.
  - `Reasoning` (`summary_text`) becomes thinking. `CommandExecution`,
    `FileChange`, `McpToolCall`, `WebSearch`, `Extension`, `ImageView` and
    `Plan` become tool names.
- Item ids are NOT unique (`item-1`, `item-2`, … repeat per turn), so node
  ids are `<turnId>:<itemId>`. `lastRawId` is the turn id, i.e. the fork anchor.
- The `session_meta` first line embeds the full base instructions (30–100 KB+).
- Usage: `token_usage_record.payload.usage` per response is summed per turn,
  and the last one is kept as `lastUsage`. `input_tokens` includes the cached
  part, so it's stored as the Anthropic-shaped split. A record that arrives
  before the turn's first prose (a tools-only response; 5 of 6,040 on the
  target machine) is held and added to the first reply.
- Names come from `session_index.jsonl`. A rename touches only that file, so
  its identity is part of every family-meta cache key, and the live view
  stat-polls it.
- **Why not app-server for reading:** `thread/turns/list` returns only a
  thread's *active* path, so every prompt-edit branch is invisible.
  `thread/list` takes ~6 s, returns duplicate rows, and doesn't populate
  `forkedFromId` (only `thread/read` does). The raw page graph lists the same
  103 interactive threads app-server does (cross-checked), plus the branches.
- **Legacy rollouts** (pre-paginated, `event_msg` `user_message` /
  `agent_message`, forks as verbatim copied prefixes) are still parsed and
  stitched by content. They can't be forked through the API (no turn ids),
  and their nodes say so (`forkBlocked`).

### Codex fork

`thread/fork {threadId, lastTurnId, excludeTurns: true}` through a
short-lived `codex app-server` (newline JSON-RPC: `initialize` →
`initialized` → request). `lastTurnId` is **inclusive of the whole turn**:
Codex cannot cut inside one. Verified: the new thread has `forkedFromId` and
exactly the prefix turns. The server is started with `CODEX_HOME` set to the
home Agentree reads whenever that isn't Codex's default (`harnessEnv`), also
when only a saved setting names it: a fork must go to the store the tree came
from, not to `~/.codex` ([round 4 finding 2](archive/2026-10-modernize/review-findings-round-4.md#r4-2);
tested against the fake server, not a real fork in a relocated home).

What can be forked, and through which thread, is decided when the tree is
built, not on click:

- **Only a turn's last node is an anchor.** Every other node of the turn (its
  prompt, commentary before a steering message, the steering message itself)
  carries `forkBlocked` explaining that a fork there would include the rest
  of the turn. Nodes carry `turnId`, and the display merge never folds two
  turns together (an aborted prompt and its replacement stay two nodes), so
  this holds for every drawn node — a test checks it over every fixture
  family.
- **Through a thread whose current history holds the turn.** A thread's
  current history is walked from its newest page down its bases — across
  threads, since a fork continues into its parent's pages — narrowing the cut
  at each step. The thread that placed the turn is preferred; otherwise any
  thread holding it, e.g. a fork of it. Verified on codex-cli 0.164 in a
  scratch `CODEX_HOME` holding copies of a real fork pair: `thread/fork` on
  the fork thread with a `lastTurnId` it only inherits via `history_base`
  produced a thread whose `thread/turns/list` was exactly that turn.
  "Newest page = current head" agreed with app-server's active turn sets on
  all ten multi-page threads of the target machine (its `thread/read` `path`
  is not a usable check: it names a different file for all ten).
- **A turn no thread holds** (cut away by a prompt edit, with no fork keeping
  it) is refused with an explanation. The API's fork-by-`path` can't reach
  it: on 0.164 it needs the `experimentalApi` capability, and even with it
  the server rejects any page that isn't the thread's head ("stale path …
  omit path and resume by thread id"). Agentree doesn't send `path`, and
  writing a rollout itself would break the "Codex forks are made by Codex"
  decision. The binary is the one bundled with the Codex VS Code
extension (`~/.vscode/extensions/openai.chatgpt-*/bin/<plat>/codex(.exe)`,
newest first), then PATH. It's spawned without a shell (except a `.cmd`
shim, quoted, through cmd.exe; `AGENTREE_CODEX_BIN` follows the same rule),
and stderr is ignored: an
unrecognised `config.toml` key logs an ERROR line that is harmless. A server
that exits, or whose stdin errors, fails every outstanding request at once
instead of leaving it to the 60 s timeout (`test/appserver.test.ts` drives the
real client against a fake server).

Exact protocol types for the installed version come from
`codex app-server generate-ts --out <dir>`.

## Claude Code

### The tree already exists inside one transcript

Claude Code writes one JSONL transcript per session, and every `user` /
`assistant` record carries `uuid` and `parentUuid`. A node with two children
*is* a branch (a rewind). The CLI just has no way to show you one.

### …and across transcripts: VS Code "Fork conversation"

Read from the extension's `forkSession` (2.1.310) and verified on 4 real pairs.
The extension's fork:

- writes a **new file** in the same project dir with a new `sessionId`;
- contains the chain ending at the chosen message, minus `progress`
  records, in order. The chain follows `logicalParentUuid` across a
  `/compact` boundary (`getTranscript(message, true)`) **[source]**, so it
  includes the pre-compact history; the boundary keeps `parentUuid: null`
  and its `logicalParentUuid` still points at the **parent's** uuid;
- gives every record a **fresh uuid** (parentUuid re-linked) but **keeps
  `message.id`, `promptId`, `requestId` and timestamps**, except that the last
  copied record is re-stamped with the fork time;
- appends `custom-title: "<title> (fork)"`;
- writes **no lineage field**.

So families are found by evidence the copy preserves: two files that share
**any assistant `message.id`** are one family. The API mints that id once per
response, so independent sessions never share one, however similar their
opening prompts. *Any*, not the first: a fork copies the branch it was taken
on, which need not include the file's earliest reply (a regenerated first
answer). On the target machine the any-id rule gives exactly the same
families as the first-id rule did (no false merges; ~7,000 ids in all).
Explicit lineage (`forkedFrom` on SDK/Agentree forks, the lineage sidecar)
also links families. Grouping runs once over **every project folder**:
message ids are global, and a fork taken after a repo moved lives in another
folder than its source.

### One session, several folders

A moved or renamed repo leaves the session's transcript in the old project
folder and continues it, under the **same session id**, in the new one.
Verified on the target machine: an 11.8 MB copy in the old folder whose 838
uuids are all in the 23.5 MB copy in the new one (a record-for-record
prefix). Session ids are therefore indexed across folders before grouping,
and one id's copies are resolved into one logical session (`resolveSource`)
by **two separate reductions** (`logicalRecords`):

- **Conversation** (records with a uuid) is deduplicated by uuid
  containment. A copy whose uuids are all in another copy is a **shadow**: its
  conversation is not parsed, it counts as hidden in health, but it is kept
  in the cache signatures and watched, so a shadow that grows is re-resolved.
  Copies neither of which contains the other **diverged** (same prefix, a
  different suffix each); their conversation is the union of their records,
  the oldest-activity copy first, then each other copy from its first new
  uuid. Shared uuids let both continuations draw without content matching.
  A uuid two copies rewrote differently keeps the first copy's payload.
- **Metadata** — the uuid-less records Agentree reads: `custom-title`,
  `ai-title`, `summary` — is taken from **every** copy, shadows and the part
  of a diverged copy before its first new uuid included, ordered by when each
  copy was last written (file mtime, then activity, then path), each in file
  order; the parser and fork writer take the last. These records carry no
  timestamp, so the write order of the files holding them is the only order
  there is. Before, a contained copy's newer rename was ignored, and so was
  a diverged copy's rename made before it diverged ([round 3 finding 5](archive/2026-10-modernize/review-findings-round-3.md#r3-5)).
- The logical session's `touchedAt` is the newest of any copy's; its
  creation time is its oldest copy's.

UUID containment proves conversation records are held elsewhere, nothing
more; it is never used to drop metadata. Queue operations (uuid-less but
positional, for mid-turn messages) travel with the conversation stream.

Never pick a copy by recency or size: that silently drops a real branch.
The fork writer reads the same union and writes next to the newest copy that
holds the anchor. Project attribution (the rail, the filter) uses the
session's last cwd, not the folder a copy happens to sit in.

Shared message ids prove two files share history; they say nothing about
**direction**, and the extension's own forks record none. Within a family the
parent is decided in three steps, none of which can contradict the one
before:

1. **Explicit lineage**, validated: an edge that would close a cycle is
   dropped.
2. **An order** with every explicit ancestor before its descendants; inside
   that, **chronologically by file creation** — a fork's file is created
   after its source's, and renaming can't change that. Only among files
   created within a second of each other (a copied or restored directory,
   `SAME_BATCH_MS`) does the count of `(fork)` title suffixes decide.
   (Title-first ordering let a renamed grandchild become its own parent's
   parent even with intact creation times.)
3. **Overlap.** A member without explicit lineage takes the earlier member
   whose tree holds the most of its history: `overlap()` in `stitch.ts`
   maps the member onto the candidate with the stitcher's own rule, over
   **every branch of both**, not just the newest chain. A parent that rewound
   after being forked from still overlaps its child fully.

Every edge points backwards in that order, so parentage is a forest. Each
member's link carries its evidence (`MemberInfo.parentEvidence`): `explicit`
or `inferred`, and the panel says "probably forked from" for the latter. A
wrong inference is not cosmetic: it decides which member owns the turns
between the two fork points (`sourceSessionId`, so what "open" and "fork"
act on) and where the dashed edge goes. It needs a batch-created directory
AND a renamed title; it can't be ruled out, which is why it's labelled.

### Stitching (`stitch.ts`)

Structural, not positional. A child's node maps onto an existing tree node
when both carry the same **match key** and hang off the same tree node (or
are both roots). Matching can only extend down a path that matched so far, so
the first unmatched node is the divergence point. Everything below it is the
fork's own suffix, re-parented onto the last shared turn and marked
`branchKind: "fork"` (drawn dashed). Rewinds inside either file survive, and a
parent that grew after the fork just keeps its extra turns.

- Keys: Claude uses `m:<message.id>` for replies and
  `p:<promptId>|<digest of the whole text>` for prompts (`u:|<digest>`,
  qualified by the parent, without a prompt id). Never the
  timestamp, which a fork re-stamps on its last record; never an opening
  gist, which merged two prompts sharing a long preamble and hung one's
  answer under the other; never whitespace-folded text, which merged two
  prompts differing only in indentation. Without a `promptId` (older
  transcripts) two prompts merge only when their exact text matches under
  the same matched parent: exact same-text copies are indistinguishable and
  branch at their replies. Legacy Codex and Copilot use role + the same exact
  whole-text digest; their copied prefixes are byte copies.
- One whitespace-folded comparison remains, deliberately: matching a queued
  mid-turn message against the records of the same transcript
  (`spliceInterjections`), where the queue holds the text as typed. It is a
  dedup inside one file, never an identity.
- A copy that merges into an existing node is recorded as an **occurrence**
  (`{sessionId, id}`), not dropped.
- Stitching runs on **unmerged** per-message nodes. The same-role merge runs
  after it, because a merge boundary can differ between a parent (which
  branches mid-run) and its fork (which doesn't).
- The merge never folds across sessions. A fork's first turn stays its own
  node, and it is always structural in the layout (never buried in a chain).

### Fork after a turn (`claude-fork.ts`)

Agentree writes **the extension's own fork format** (above) plus
`forkedFrom: {sessionId, messageUuid}` on every copied record (the Agent SDK's
`forkSession` writes that field too), and records the link in the lineage
sidecar. Mirroring the extension: it walks the **logical** chain from the
turn's **last** raw record (`lastRawId`; a turn spans one record per content
block), crossing a compact boundary through `logicalParentUuid`; the
boundary's `parentUuid` stays null so the CLI still resumes from the
summary; a `queued_command` attachment's `source_uuid` is remapped; a
`model_refusal_fallback` record gets `neutralizedByFork`; the source's
`summary` for the anchor is carried over. It writes with `wx`, so nothing
is overwritten.

Parser and writer share ONE ancestry rule, `resolveLineage()`: a boundary's
stale `logicalParentUuid` (one that isn't in the file) resolves to the
record written just before it, because copies are written in chain order.
Without that, a fork of a compacted session parses as two roots and its
history is drawn twice; and when only the parser had it, a fork OF such a
fork walked the raw field, stopped at the stale reference, and dropped the
whole pre-compact history. One deliberate difference from the extension:
Agentree's copy repoints the boundary's `logicalParentUuid` at the copy of
the pre-compact tip, so its own forks are self-contained. A test forks every
forkable node of every fixture family and checks that the fork alone draws
exactly the selected path, and that an unchanged fork adds no node.
File-history snapshots aren't copied: they're rebuilt from deltas Agentree
doesn't model, and a stale one would make "rewind code" restore the wrong
files. The fork is opened in the Claude panel.

Verified end-to-end: a fork taken after the first reply of a two-prompt session
resumed with `claude -p --resume <new>`. It knew the first question and had
never seen the second, and its new turn stitched in as a dashed branch of the
right node. **Not verified**: resuming a fork of a compacted session, or of a
turn ending in a `tool_use` (the extension's own fork has the same shape, so
both are expected to behave as the extension's do).

Refusals are decided at parse time and carried on the node as `forkBlocked`
(the panel shows the reason and disables the button; the writer refuses with
the same text):

- `preCompact` turns: Claude Code resumes a compacted session from its
  summary, and a copy ending before the boundary would ask it to reload the
  uncompacted history. Whether that works is untested, so it's refused;
- `injected` interjections, which have no record;
- `midTurn` attachment nodes, which aren't message anchors (forks of later
  turns keep them).

The Agent SDK (`@anthropic-ai/claude-agent-sdk`) was deliberately not bundled.
Its licence is "all rights reserved" and the repo is MIT, and its session
functions are plain file operations whose output format is reproduced here.

**Superseded designs, for history.** Each one failed in a way worth remembering:

1. *Copy under a new id, no stitching*: every fork listed as an unrelated
   conversation.
2. *An explicit `last-prompt` pin appended at click time*: a still-open CLI
   appends its own non-explicit pointer on exit and clears the pin.
3. *`--resume-session-at` alone*: it is print-mode-only, and interactive resume
   silently continued from the tip.
4. *Pin + flag inside the emitted command* (`printf … >> transcript && claude …`):
   it worked interactively, but it wrote into the user's real transcript,
   depended on undocumented reducer behaviour, was POSIX-only, and couldn't be
   driven from the VS Code chat panel. 3,011 `last-prompt` records on the
   target machine, 0 explicit: the pin was never used there.

### One turn is many records

Claude Code writes **one record per content block**. A reply with thinking +
text + a tool call becomes three chained `assistant` records sharing one API
`message.id`. `transcripts.ts` groups by `message.id` and emits one node per
turn, merging the blocks. Some messages span 27 records.

### Record types

Seen on the target machine: `assistant`, `attachment`, `user`,
`api-request-blob`, `bridge-session`, `last-prompt`, `atis-latch`,
`ai-title`, `api-request`, `queue-operation`, `mode`, `file-history-delta`,
`file-history-snapshot`, `custom-title`, `cost-state`, `pr-link`, `system`,
`api-request-shape`, `frame-link`, `artifact-*`, `permission-mode`. Only
`user`/`assistant` (plus `queued_command` attachments) become nodes.
`api-request-blob` carries `message` content blocks but is **not** a turn.
The two-pass lineage tolerates any type, and unknown ones are counted in the
health row, not treated as errors.

- **Title:** last `custom-title` > last `ai-title` (the CLI's generated title)
  > first real prompt (computed before the same-role merge).
- **`entrypoint`** (`claude-vscode` | `cli`) is shown in the panel.
- The project-dir slug keeps the drive letter's case as written
  (`c--Users-…` and `C--Users-…` both occur). The cwd inside the transcript is
  authoritative, but it is the *shell's* cwd: it follows every `cd` the
  agent runs (verified: sessions filed under `…\src` and
  `…\artifacts\…\checks` when the last cwd was taken). So `sessionCwd()`
  takes the last conversation-record cwd that the project folder's name
  encodes (Claude's slug: every non-alphanumeric becomes `-`): a moved repo
  continues in a new folder named after its new directory, and the session
  resumes there. Without a match it takes the last cwd that isn't merely
  inside, or above, the one before it. Codex likewise takes the newest page's
  last `turn_context.cwd`. One folder is recorded as `c:\…`, `C:\…` and
  `/c/…` (Git Bash), with or without a trailing separator, so paths are
  compared by `cwdKey()` (shared/render.ts) and displayed as recorded.

### Plumbing is stripped, real markup is not

Records carry ANSI escapes from captured command output and Claude Code's own
wrapper markup. Those are cleaned:

- **dropped entirely:** `local-command-caveat`, `system-reminder`, and the VS
  Code extension's context blocks `ide_opened_file`, `ide_selection` and
  `ide_diagnostics`. Left in, "The user opened the file … in the IDE" became
  most sessions' titles;
- **unwrapped:** the rest (`command-name`, `local-command-stdout`,
  `bash-input`, …) keep their inner text and lose the tag.

The tag list is a deliberately short **allow-list**, not "strip anything
angle-bracketed". A corpus census found `<doc>` ×260, `<name>` ×90,
`<email>` ×102 and dozens more, all genuine content inside code samples and
quoted XML. Prose mentions in backticks survive, correctly. A record that is
*nothing but* wrappers is rebuilt from the trimmed inner values, because
unwrapping in place strands the pretty-printer's indentation.

### Only turns that said something get a node

A node must have text after the merge. That removes `user` records that exist
only to carry `tool_result` blocks, and `assistant` turns whose entire content
was a tool call or bare thinking. The filter runs **after** the per-message
merge. Uncaptioned screenshots are labelled `[image]`. `resolveParent`
re-links children to the nearest surviving ancestor, so dropping these doesn't
cost branch structure.

### Same-role runs fold into one turn

A linear run of consecutive same-role nodes becomes one node: an agent loop
(assistant → assistant → assistant), or a slash command's several user records.
It only merges where the parent has exactly one child, never across sessions,
never across vendor turns (`turnId`), never into a fork's first turn, and
never across a member's endpoint (the next part must be held by the same
sessions, `copyHolders`). The
merged node's fork anchor and `forkBlocked` are its **last** part's, so a run
ending in a mid-turn attachment is unforkable as a whole ("fork the turn
after it"). Usage is **summed** here, because each part
is a distinct API call. That's the opposite of the per-block merge, where every
record repeats one message's usage. Absorbed ids are retained so sidecar
annotations still resolve.

“Across sessions” means different canonical `sourceSessionId` values; the
endpoint rule covers what that can't see, a copied member ending inside a run
its parent owns ([round 3 finding 2](archive/2026-10-modernize/review-findings-round-3.md#r3-2)).
So the same transcript can draw as one node alone and as two in a family
with a quiet fork ending between them. Display grouping is a view, and
annotations are keyed per part, so a label made on the merged node shows on
both parts after such a split.

### Most "branches" were an artifact

Parallel tool calls produce a fake fork: the second `tool_use` block and the
first tool's result both hang off the same record. Merging turns AND dropping
tool results were both needed to stop counting those (one session showed ⑂9
when only 1 was real).

### Lineage gotcha

Claude Code interleaves other record types into the same parent chain.
Filtering to displayable turns without **re-linking across the gaps** leaves
most `parentUuid` pointers dangling, which collapsed a 378-node tree to about
seven reachable nodes. So there are two passes: build the full lineage from
every record that has a uuid, then resolve each kept node's parent to its
nearest surviving ancestor.

### Mid-turn messages (`/btw`), interjections and `/compact`

A message sent while Claude is working is recorded as a uuid-less
`queue-operation` pair and, on current CLIs, as a `queued_command`
**attachment** with a real uuid at the delivery point. Task notifications ride
the same queue and attachment type (`commandMode: "task-notification"`, null
origin) and are dropped. Agentree prefers attachments (`origin.kind: "human"`)
and falls back to queue-op reconstruction for old transcripts (deduped by
content), splicing each one **into** the chain, never beside it: an
interjection must not become a spurious branch point. Reconstructed ones
(`queued:<sid>:<n>` ids) are drawn hollow and can't be forked from.

`/compact` writes `system/compact_boundary` with `parentUuid: null` and the
real predecessor in `logicalParentUuid`. The parser follows that field, or a
compacted session shatters into a forest. The resume loader indexes only
messages after the LAST boundary, so earlier turns are marked `preCompact`.
The harness doesn't persist every piece of in-turn prose: if nothing was
recorded between two mid-turn messages, they merge into one node, which is a
faithful rendering of the file.

## Copilot CLI

Unchanged since July 2026 and untested on the target machine's current
version. Forks are copy-truncated session dirs, with the copied
`session.start`'s `sessionId` rewritten (left stale, the resumed CLI logs
under the PARENT's id). Parentage lives in `~/.agentree/lineage.json`, because
Copilot **regenerates workspace.yaml on every resume and drops unknown keys**.
VS Code **Copilot Chat** (`%APPDATA%/Code/User/workspaceStorage/*/chatSessions/*.jsonl`,
an op-log) is the next provider. See the [archived Copilot Chat research](archive/2026-10-modernize/modernization-handoff.md#33-vs-code-copilot-chat-phase-4-read-only) for its format notes.

## Fail loudly

Every provider scan fills a `HealthScan`: files seen, hidden (guardian,
subagent, bookkeeping-only), parsed, **failed**, listed, format versions, and
unknown record types (Claude: top-level `type`; Codex: top-level type,
`event_msg` payload type and item type). Every file lands in exactly one of
hidden / parsed / failed. **Failed** means it should have been a session and
wasn't: unreadable, no parseable line, or conversation records (Claude
`user`/`assistant`, Codex turn records) that yielded no turn — which is what
a changed record shape looks like. Keeping it apart from "hidden" is the
point: before, a wholly malformed file counted as an intentionally empty one
and raised nothing. The welcome screen shows one row per present provider. It
warns about any failed file, warns harder when fewer than half of
parsed + failed succeed, and lists unknown types behind a disclosure. Zero
failed on the target machine's 358 files. A Claude session stored in several
project folders raises a warning naming how many, and how many diverged. A provider that throws doesn't take the others down
(`registry.ts` guards each one), and its row says it crashed. This row would
have flagged the 2026-09 Codex format change, which listed 0 sessions, on day
one.

## Chains

Conversation trees are caterpillars: one long spine with short stubs. Runs of
single-child turns collapse into one **chain** with a count badge, and a click
expands or collapses the whole run. Runs shorter than `MIN_CHAIN` (3) draw as
plain nodes. Effect on a real session: **89 turns → 5 drawn elements**.

Four things this got wrong first, all fixed and worth not re-introducing:

- **A chain must emit the node it terminates in**, or a collapsed run ends in
  empty space.
- **Don't keep the whole selected path uncompressed.** In a caterpillar that's
  nearly every node. The path is shown by edge highlighting instead.
- **Don't size a chain proportionally** to the turns it hides. The span is
  fixed (`CHAIN_ROWS`).
- **`fit` must add the chain span to the measured height**, or the tail clips.

## Layout

The layout is a tidy tree by **subtree extent**, not fixed columns. Two
subtrees never overlap, so two nodes in the same row never can either, which
is what lets a labelled node be a variable-width box. Node width comes from
`nodeWidth()`, deliberately generous because SVG can't measure text before
rendering. `src/tree-layout.test.ts` fuzzes 300 random trees (labels, fork
tags, marks, open and closed chains) and checks that no two drawn elements
(`elementBounds`) overlap.

**Fork tags.** A fork's first turn (`branchKind: "fork"`) carries a small tag
above it with its session's title (`forkTags`), so the tree says *which* chat
a dashed edge starts. The tag's width is part of `nodeWidth()`, and it sits
inside the node's row band: its top is 26px up at most, the row above ends
29px up. A chain's pill ends just above a tagged chain tail's tag; the chain's
dotted line, like an edge, may pass behind it (the tag is opaque). A user
label on the node replaces the tag, and a ★/✕ mark moves inside the tag. A
title that only repeats its parent's plus "(fork)" (the Claude extension's
default) is shown as `fork <id8>` instead: it would say nothing the dashed
edge doesn't. A
Codex prompt edit (`edit`) gets no tag: it's the same thread. The tooltip
names the fork in full and says "probably forked from" when the parent was
inferred.

Structural nodes are **roots, branch points, leaves, annotated turns, and a
fork's first turn** (any `branchKind`). Nothing else is structural.

**Selection is styling, never geometry.** `isStructural()` ignores the
selection, so clicking never re-lays out the tree. Auto-fit runs once per
session (via a ref), so after the first frame the viewport belongs to the user.

Edges into a node with a `branchKind` are **long-dashed** (`.edge.cross`), and the
legend explains them only when the tree has one. Collapsed chains are
**dotted** (round caps), so "turns hidden here" and "a new session starts here"
can't be mistaken for each other. They looked alike when both were short
dashes.

## Live view

The tree follows the transcripts on disk.

- A session watch covers the **directories holding its family**: every
  Claude project dir a member (or a copy of one) lives in, or the
  Codex/Copilot roots. A tree can grow through any
  member, or through a brand-new fork file. The welcome screen watches every
  root.
- The watch is on the *directory*, not the inode. A watch on a file goes deaf
  the moment the file is replaced.
- Watch targets are resolved by the backend worker and watched on the host
  (`watchLater`). A failed resolution (worker restarting) is retried with
  back-off, and once the watch is live it fires one change to reconcile
  anything written between the read and the watch.
- Resolution goes through the `Provider` interface (`watchTargets`), like
  list/load/fork: a session's targets come from the enabled provider that
  owns it, the welcome list's from each enabled provider, each guarded so one
  failing provider leaves the others' targets. A disabled provider's
  discovery is never invoked. (Before, opening any tree first scanned Claude's
  folders, enabled or not: [round 3 finding 6](archive/2026-10-modernize/review-findings-round-3.md#r3-6).)
- A root that doesn't exist when the watch starts (a harness not installed
  yet, a home just configured) is stat-checked every second; once it
  appears it gets the normal watch and fires one change. Before, it was never
  watched until the view re-subscribed ([round 4 finding 6](archive/2026-10-modernize/review-findings-round-4.md#r4-6),
  inherited from the original code).
- Directories are watched by their real, long path: on Windows a recursive
  `fs.watch` on an 8.3 short path (`C:\Users\JOHNSM~1\…`, as a temp dir can
  be) receives long-form event names and libuv aborts the process.
- The renderer drops results for a view that's gone: every open/close bumps a
  view generation, and a reload that resolves after a close is discarded.
- A family can lose its root (its transcript deleted) while a fork survives,
  or split in two. The reload asks for the focused member, the sessions
  holding the selected turn, then the root and every other member it knew,
  adopts the first family that loads (asking again if the user picked another
  member meanwhile), and carries the selection over by where it ended, then
  by `stableIds` (see [membership](#membership-focus-and-family-lifecycle)
  and [the fork point](#the-fork-point)). Closing a tree refreshes the list.
- Codex and Copilot roots (`sessions/` and `archived_sessions/`) are also
  **stat-polled** every second, and so is Codex's `session_index.jsonl`
  (renames). Codex appends were verified invisible to
  macOS FSEvents until the file closes, and the poll costs ~4 ms. The filter
  accepts `.jsonl`, `.jsonl.zst` and `.yaml`.
- Writes are debounced 250 ms, because one reply is a burst of appends.
- Reload keeps your place: `expanded` survives, and the selection follows the
  new tip only if it was already on the tip.

## Welcome screen

- A directory rail ("All conversations", then directories, by `cwdKey`, ranked by most
  recent conversation) and one flat list, newest interaction first, with one
  entry per fork family.
- Badges: `⑂ n` branch points, `N sessions` for a family.
- A family card names its other chats (`SessionMeta.forks`, newest activity
  first, three then "+N"); a fork's own title is often the descriptive one.
  The search matches fork titles and ids too, and a matched fork moves to
  the front of that line, highlighted. A family counts under every member's
  directory, so a fork made in another repo shows there as well (owner's
  choice).
- Clicking a fork name, or opening a card whose search hit only a fork,
  opens the tree **focused** on that member: the selection lands on
  `MemberInfo.tipId`, the latest-ending leaf among the nodes the member holds
  (`heldBy`), and Open/Resume act on that member over its whole history,
  shared prefix included. A fork with no turn of its own lands on the turn
  it was forked at, showing nothing past it. See
  [membership and focus](#membership-focus-and-family-lifecycle).
- Health rows sit above the list. Their provider chips are the agent filter
  (one agent, or all; `providerFilter` in the store). It combines with the
  directory filter and the search, and the rail counts only what it lets
  through. The rules live in `src/list.ts`, testable without a DOM.
- Cards are keyed by `provider:id`, and `registry.listAllSessions` drops a
  second entry with the same identity (keeping the newer, logging the other).
  A provider that regresses into duplicates must not reach the screen: two
  cards with one React key left stale cards above a filtered list.
- No refresh button (the watcher keeps it live) and no "only branched" filter.
- Two times per session and member, both from record timestamps (never
  mtime, which bookkeeping rewrites move). The list sorts by `activeAt`.
  - `activeAt`, last conversational activity. It isn't the newest
    *displayed* turn, which stands still through a long tool loop; tool
    records count. Claude: any `user`/`assistant` record (tool-only replies
    and tool results included), `queued_command` attachments and
    `compact_boundary`. Codex: any `item_started`/`item_completed` event,
    of any item type (legacy: prose events and tool calls). Copilot:
    `user.*`, `assistant.*`, `tool.*`, `external_tool.*`, `subagent.*`
    events. **Verified:** the Codex extension re-stamps threads it merely
    loads with `thread_settings_applied`, `task_*`, `token_count`,
    `token_usage_record` and a `response_item`; five threads idle for days
    looked minutes old when sorted by every record.
    A Codex fork nobody has spoken in has no item at all, and its reloads
    append the same bookkeeping: it dates from its creation
    (`session_meta`), and the family's time counts items only — before,
    one reloaded quiet fork floated a September family to the top.
  - `touchedAt`, the newest timestamp on **any** record ("last file
    change"), shown in the card's tooltip.

## Settings

`~/.agentree/settings.json`, edited from the panel behind the welcome
screen's gear, read and written only by the backend worker
(`getSettings` / `setSettings` in `methods`), so both hosts share one
implementation and one file. **A setting changes what you see or where data
lives, never how a transcript is interpreted**: no setting touches the
parsers, stitching, fork rules or health thresholds.

- Scan settings are applied in the worker: `registry.enabled` excludes agents
  from listing, loading, fork routing, health and watch-target discovery —
  every store call goes through the `Provider` interface, so a disabled
  agent's discovery functions are never invoked (a test spies on them).
  All-archived Codex families can be listed (`archived` on the entry); data locations go
  environment variable > setting > default (`paths.ts`, `configuredPath`).
  `AGENTREE_HOME` is environment-only: the settings live in it.
- View settings are applied in the renderer: the sort time, remembered view
  state (compress, directory and agent filters, saved debounced) and whether
  a new fork opens in the chat panel (unset: VS Code yes, desktop no).
  With remembering off **no view is kept**, enforced in three places: turning
  it off cancels a pending 500 ms save; a save that fires rechecks the flag;
  and `validate` drops `view` whenever `rememberView` is false, so whichever
  write reaches the worker last, none recreates it. Settings responses are
  applied in request order: one that answers after a newer write was sent is
  dropped ([finding 8](archive/2026-10-modernize/review-findings-round-3.md#r3-8)).
- The file is validated field by field, so a hand-broken file falls back
  per field, and cached by (mtime, size), so a write from the other host's
  worker is picked up. Writes are atomic per file, like the sidecars. A write
  that fails is shown where settings are edited (`settingsError`: in the
  dialog, and on the welcome screen once it is closed), a path field that
  didn't save says so and keeps what was typed, and the next save that
  succeeds clears it. (Before, the error landed in a banner only the tree
  view draws: [round 4 finding 5](archive/2026-10-modernize/review-findings-round-4.md#r4-5).)
- **Store paths reach the harness's own processes.** A path setting
  relocates where Agentree reads; the harness's processes must use the same
  store. The worker resolves it (`harnessEnv` in `paths.ts`: the harness's
  variable whenever its root isn't the default), and it travels with every
  launch: the Codex fork server's environment, the copyable resume
  commands, and terminal resume, which hosts start from the worker's
  `resumeLaunch` (argv + environment; `launch.ts`) without resolving any
  root themselves. VS Code passes it as the terminal's environment; the
  desktop app writes it into the command (`$env:X = '…';` / `X='…'`),
  because a macOS or Linux terminal window's shell needn't inherit the
  launcher's. A chat-panel hand-off can't carry it — the vendor extension
  reads its own configuration — so the panel says so when they may differ
  ([round 4 finding 2](archive/2026-10-modernize/review-findings-round-4.md#r4-2)).
- A change refreshes the list, reloads an open tree, and bumps
  `settingsRev`, which re-subscribes every watch: watch targets are resolved
  once, so a moved root needs a new watch. The parse caches are keyed by
  absolute path and evicted per scan, so they rebind by themselves (the Codex
  name-index stamp includes its path for the same reason).

The [user guide settings section](user-guide.md#settings-and-data-locations)
owns defaults, environment variables and user-facing effect timing. The
worker notices another host's settings write on a subsequent stat/read; this
is not a push mechanism that instantly refreshes every open renderer.

## Not dying under load

The backend worker (above) keeps scans off the host thread. Two more
mechanisms, both born of a real incident (Electron at 100 GB RSS):

- **Summary caches** keyed by (mtime, size). Claude caches per-file summaries
  (including each file's assistant message ids, for grouping) plus a
  family-meta cache keyed by every member's identity. Codex caches page parses
  and family metas (keyed by pages + the name index). Only metadata and small
  Codex pages are cached, never Claude node arrays. Deleted files are evicted
  on each scan. Cold scan over ~360 transcripts is 2.6–4.8 s; a warm one is
  ~20 ms.
- **Back-pressure** (`gate()` in `store.ts`): at most one refresh of a kind is
  in flight, and changes arriving mid-refresh coalesce into exactly one
  follow-up.

## Annotations

Labels, dead-end marks and stars live in `~/.agentree/meta/<sessionId>.json`,
never in the transcripts. A family's identity isn't stable — it gains members
when a fork is found, its root changes when the original is deleted, and one
turn has a different uuid in every file holding it — so annotations are keyed
by the turn's **semantic identity** (`stableIds`), not by a uuid:

- **writing** (`registry.annotate` → `writeAnnotation`) loads the family and
  writes the patch into **every member's** file under the node's stable ids:
  one atomic replacement per sidecar, however many ids. An older-scheme
  entry the node owns gets the same patch, so a cleared label can't
  resurface through it;
- **reading** (`applyAnnotations`) checks every member's file, in member
  order, for any of the node's current keys; without a hit, for the keys an
  [earlier identity scheme](#identity-scheme-and-compatibility) saved it
  under (schemes 2–3, then scheme 1's raw uuids, usually in the root's file
  only) that it owns.

**Ownership.** Reads and writes apply one rule to every older-scheme key: it
belongs to a node only if that node is the **only** one in the family that
answers to it (`ownership` in `meta.ts`, over every node's current, legacy
and raw keys). A key two nodes answer to is shown on neither, carried
forward for neither, and not patched by a write to either — it stays on
disk as it was. Current keys need no such check: their forms are never an
earlier scheme's ([why scheme 4](#identity-scheme-and-compatibility)), so a
current key always means its own node. Before, writes patched older keys
without this check, and a label on one prompt overwrote its whitespace
twin's ([round 4 finding 1](archive/2026-10-modernize/review-findings-round-4.md#r4-1)).

**Reconciliation.** What is shown is made durable: every member's sidecar
that holds no entry for the node under its current keys gets the shown entry
— a member discovered after the annotation was written (a new fork), or
every member for an older-scheme hit (the migration, lazy and idempotent).
So an annotation survives the deletion of the member it was written in,
once the enlarged family has been loaded ([round 3 finding 4](archive/2026-10-modernize/review-findings-round-3.md#r3-4)).
Rules that keep this from going wrong:

- a member's existing entry is never overwritten: no conflict is resolved
  by a read, and once the family's sidecars agree a load writes nothing;
- a cleared annotation is an absent entry, and absence is never copied, so
  reconciliation can't undo a clear made through `writeAnnotation`;
- older-scheme entries are never rewritten or deleted by a read, and only an
  owned one is patched by a write.

Not covered: a clear can only reach the sidecars of the members known when
it is made (there are no tombstones), so a stale entry in a sidecar that
rejoins later is shown again. An entry whose transcript was deleted before
any family holding the node was loaded has nothing on disk to map to, and is
not recovered.

Sidecar writes are atomic per file, not across processes: the desktop app and
the extension writing the same sidecar at the same moment can lose one side's
change. A cleared field travels as `null` (the VS Code bridge drops
`undefined`).

**Write failures.** The panel shows an annotation at once, as a guess.
`annotate` throws when nothing was written (the turn is gone) or a sidecar
write fails; the store then shows "Not saved: …" under the annotation
buttons (`annotationError`, cleared by the next save that succeeds) and
redraws the family from disk. It doesn't undo the guess: one member's
sidecar may have been written before another's failed, so only a re-read
says what is saved. Before, a failed write looked saved ([round 5 finding 5](archive/2026-10-modernize/review-findings-round-5.md#r5-5),
inherited from the original code).

### Saved data layout and compatibility

Under the configured Agentree home (the guide owns its location/overrides):

| File | Current representation and behavior |
|---|---|
| `settings.json` | Validated settings object; absent/invalid fields fall back independently. Saved view is optional. See the [configuration contract](user-guide.md#settings-and-data-locations) and `electron/settings.ts` |
| `lineage.json` | Object mapping child session IDs to parent IDs; written for Agentree-made Claude/Copilot forks. Claude validates explicit parentage against cycles. Copilot needs this because it regenerates `workspace.yaml` |
| `meta/<sessionId>.json` | Object mapping node keys (any [identity scheme](#identity-scheme-and-compatibility)) to `{label?, status?, note?}`. Status is `favorite` or `dead-end`; merged nodes can have several keys. Read lookup takes the first matching entry in member/key order; there is no timestamp-based conflict resolution |

Cleared annotation fields are removed from JSON, and an empty entry is removed.
There are no persisted tombstones and no version field; key schemes are told
apart by form. Writes merge a patch with current file contents and use a
temporary file plus rename. That protects against a partial JSON replacement,
not concurrent read/modify/write lost updates.

`meta.ts` also attempts the old `~/.agentview` → Agentree-home directory rename
once at module import when the default location is in use and the new home
does not exist. An explicit `AGENTREE_HOME` suppresses that migration, another
reason to set disposable roots before importing stores in probes.

Keep any future identity change backward-compatible the same way: a new
scheme must say how keys saved under each earlier one are found (as
`legacyIds` and `scheme2Fingerprint` do) and when the hit is ambiguous. A
provider-qualified ID or different hash cannot simply replace existing keys.

## Windows

- Resume commands are emitted in the host shell's syntax by `shell.ts`:
  `Set-Location -LiteralPath '<cwd>'; claude --resume <id>` on win32
  (PowerShell 5.1 has no `&&`), and `cd '<cwd>' && …` elsewhere. A
  relocated store adds `$env:CLAUDE_CONFIG_DIR = '…';` — which PowerShell
  keeps for the rest of that session; it has no per-command prefix — or a
  POSIX `CLAUDE_CONFIG_DIR='…'` prefix scoped to the command.
- **`ELECTRON_RUN_AS_NODE=1` leaks into shells started from inside VS Code**
  (its extension host sets it, and agent tools' shells inherit it). Under it,
  `electron.exe` runs as plain Node and the app dies on `ipcMain` being
  undefined. Every launcher strips it: `npm start` / `npm run dev:app` go
  through `scripts/electron.mjs`, and `bin/agentree.cjs` does the same. Never
  put a bare `electron .` back in package.json.
- The window keeps the native frame on Windows/Linux (`hiddenInset` there
  means no window controls at all). The preload stamps
  `<html data-platform>`, and CSS drops the macOS traffic-light insets
  elsewhere.
- "Resume in terminal" waits for the launcher's `spawn` (or `error`) event
  before answering, so a missing terminal is reported instead of silently
  doing nothing.
- "Resume in terminal" on Windows runs `cmd /d /c start "" powershell.exe -NoExit -EncodedCommand <base64>`
  with `windowsVerbatimArguments`. Node's `detached` maps to
  `DETACHED_PROCESS`, which gives a console program *no* console, so a direct
  spawn never appears (verified). `start` gives it a new window. The script
  is the copied command's own `Set-Location -LiteralPath …; <argv>`, base64
  of UTF-16LE: cmd expands `%NAME%` anywhere in its command line, quoted or
  not, so no path may reach it as text. (Before, cwd and store path were
  quoted into cmd's line, and a directory named with a `%…%` pair could
  become another path: [round 5 finding 6](archive/2026-10-modernize/review-findings-round-5.md#r5-6).)
  A test executes that cmd → PowerShell boundary (without `start`) on Windows.
- The desktop update check follows the build's own `origin` and branch
  (stamped into `dist-electron/build-info.json`), so a fork compares against
  itself and a feature branch against itself — never offering a `git pull`
  that wouldn't bring the update. It offers `git pull` + `npm install` in the
  host shell's syntax.
- `scripts/install.sh` is POSIX-only. `bin/agentree.cjs` is plain Node and
  works anywhere `npm link` does.
- npm's allow-scripts policy can block Electron's binary download. Run
  `npm approve-scripts electron` and then `node node_modules/electron/install.js`.
- With `core.autocrlf=true`, test fixtures are protected by
  `test/fixtures/.gitattributes` (`-text`).

## Tests

After the [round 5 resolution](archive/2026-10-modernize/review-findings-round-5.md#resolution):
122 tests in 16 files, typecheck and both production builds pass. Each round
3, 4 and 5 finding has a regression test that failed on the code before its
fix (round 4's documentation finding excepted). The examples
below describe coverage, not a promise that every possible member endpoint
or native resume was checked. Working commands and safe probe rules are
maintained in [AGENTS.md](../AGENTS.md#commands-and-verification).

`npm test` (vitest) runs over synthetic fixtures generated by
`test/fixtures/make-fixtures.mjs`. Record shapes are copied from real
transcripts with the content replaced; no user data is committed. The suites
point providers at the fixtures through `CLAUDE_CONFIG_DIR` / `CODEX_HOME` /
`AGENTREE_HOME`, and the Claude suite works on a temp copy because it forks.

Assertions are on exact ancestry and tree invariants (unique ids, no
dangling parent, one root per path), not session counts.

- **Claude:** ide-wrapper and api-request-blob handling, title precedence, an
  extension fork pair stitched at the right turn next to a rewind, a
  same-opening-prompt session that must not merge, a parent that rewinds after
  its child was forked, a renamed explicit descendant (no cycle), a fork taken
  on a regenerated first answer, a native fork of a compacted session (stale
  logical parent), a malformed file (failed, not hidden), annotation aliases
  and survival of a deleted root, and the fork writer's output (format,
  lineage, fork-of-fork, logical chain across /compact, a prompt without
  `promptId` as the endpoint, pre-compact refusal). Round 3: prompts that
  differ only in indentation; quiet forks ending between two assistant and
  between two user records (exact `heldBy`, tips, the fork at that endpoint,
  and the focused member's action target); annotations saved under schemes
  2 and 3 (folded, literal-chain and `u:` keys, an ambiguous one, clearing
  them); a label made before its fork existed outliving the original; a
  rename in a contained copy and in a diverged copy before its first new
  record. Round 4: a family split by deleting its bridging member. Round 5:
  a fork point taken before a quiet fork split its node still forks the
  drawn range, and one whose node was folded into a longer one is refused.
- **Codex:** a `.zst` edit page, a fork through an archived thread, a
  guardian thread, a missing base, a copied-prefix fork in the item
  vocabulary, early usage, a rename in the index, an unknown item vocabulary
  (failed), legacy prose beside a completed `Extension` item (the observed
  0.164 shape), the IDE wrapper, steering, legacy stitching, and fork anchors
  (whole turns only, refusal of cut-away turns, routing through a fork that
  still holds the turn), with app-server mocked.
- **Pipeline invariants:** every enabled Claude fork in every fixture family
  is made and checked (the fork alone draws exactly the selected path, its
  text compared exactly, whitespace and all; the family gains no node or
  root); every enabled Codex node ends its own turn.
  Plus a merged node ending in a mid-turn attachment, two prompts sharing a
  long preamble, a renamed grandchild with intact creation order, a fork of a
  compacted fork, an aborted Codex prompt, and a pre-upgrade annotation that
  outlives its root.
- **Backend client:** a real worker (`test/fake-worker.cjs`) that crashes;
  the retry on its replacement must survive the old worker's late `exit`;
  disposal is final. The real worker, bundled by esbuild as the hosts ship
  it, answers every method of `backend.ts` through the proxy, including
  `resumeLaunch` with the store variable of a disposable home.
- **Renderer store** (`src/store.test.ts`, in `src/` for the DOM config):
  a reload resolving after close, a family whose root was deleted, cleared
  fields sent as `null`, the focused member's Open/Resume payload across
  selection and reload, disabling remembered view inside the save debounce,
  an older settings response arriving last, reload after a family split
  (focused member, else the selected turn's side), a selection kept at its
  end when its node splits, a member chosen while a reload is in flight
  (deferred responses), and a failed annotation write shown and redrawn. `src/welcome.test.tsx`
  renders the welcome screen and settings dialog to check a failed save is
  shown, then cleared by a successful retry.
- **Annotations** (`test/annotations.test.ts`): two prompts sharing a prompt
  id and differing only in whitespace keep independent labels, and an older
  key both answer to is shown on neither and never rewritten.
- **Endpoints** (`test/endpoints.test.ts`): the latest-ending branch is the
  tip, across a same-role run and across one reply streamed as several
  records.
- **Watch** (`test/watch.test.ts`): roots that appear after the watch
  started, polled and not, are picked up.
- **Identity** (`test/identity.test.ts`): text-keyed identity size grows
  linearly, copies agree, the same text under another parent and
  whitespace-only differences stay distinct, scheme-2 literals are
  recognised; text-keyed stitching keeps indentation variants apart.
- **Registry**: no duplicate list entries; watch discovery never invokes a
  disabled provider. **Settings**: no view kept while remembering is off.
- **Launch environment:** the fake app-server reports the `CODEX_HOME` it
  was started with — unset by default, the saved home when only a setting
  names it, the variable when that is set; resume commands and terminal
  launches carry the store variable, quoted, on both platforms.
- **App-server client:** the real client against `test/fake-codex` — the
  request shape, a JSON-RPC error, a server exiting mid-request, and on
  Windows a `.cmd` override with a space in its path. The synthetic rollouts
  are parser fixtures only: the real app-server doesn't accept them as
  complete rollouts, so its fork behaviour was verified by hand on copied real
  rollouts (see "Codex fork").
- **Shell quoting** on both platforms; **desktop hand-off**: deep links and the
  per-OS terminal launch (Windows: the encoded script, executed through cmd →
  PowerShell with literal `%…%` in the directory and store path; AppleScript
  escaping, Linux emulator choice, missing-cwd fallback).

When a harness changes format, add a fixture for the new shape before changing
the parser.

## Notes

- Assistant output renders as Markdown via a small hand-written renderer
  (`src/markdown.tsx`) that emits React elements, never an HTML string, so no
  sanitiser is needed. Non-http schemes never become links. It recurses, so
  its regex is instantiated per call: a shared `/g` regex rewinds the outer
  cursor and hangs.
- Per-turn numbers (`context · prompt · % cached`) live in the panel. There are
  no overlay modes: a legend in the canvas corner decodes everything the tree
  encodes, and the tip breathes with a pulsed ring (static under
  `prefers-reduced-motion`).
- Marking a turn as a dead end dims it **and everything beneath it**.
- Token counts are not dollar prices. `costOf` sums uncached/cache-creation/
  cache-read input for prompt tokens; same-role merged usage sums API calls.
  `contextAt` uses the nearest usage-bearing node's **last** call plus output,
  avoiding the repeated-history sum. `inferWindow` currently chooses 200k or
  1M based on whether observed usage exceeds 200k; this is an estimate, not a
  vendor-reported configured window. See `shared/render.ts` and the guide's
  [context explanation](user-guide.md#context-and-token-numbers).
- The app icon is generated from `logo.png` by `scripts/make-icon.py`. Re-run
  it if `logo.png` changes.

## Known gaps

The [user guide](user-guide.md#limitations) owns the user-facing limitations. The [current roadmap](roadmap.md) tracks remaining work. Review reproductions, acceptance conditions and their resolutions remain in the [round 3](archive/2026-10-modernize/review-findings-round-3.md), [round 4](archive/2026-10-modernize/review-findings-round-4.md) and [round 5](archive/2026-10-modernize/review-findings-round-5.md) reports; earlier handoffs, review resolutions and the completed roadmap are in the [historical record](archive/2026-10-modernize/README.md).

Observed counts and timings in these notes describe particular 2026-10-27 datasets, rather than release guarantees. Source inspection, fixture coverage and an executed vendor resume are different strengths of evidence. Keep that distinction when updating a claim.
