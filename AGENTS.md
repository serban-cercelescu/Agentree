# Agentree — design notes for agents working on this repo

Engineering notes on how Agentree parses, draws, and forks agent
conversations — the transcript formats, the tree model, and the decisions
behind them. Read this before touching the parsers or the fork logic: most
of what looks odd in the code exists because of a transcript reality
documented here. User-facing overview and installation live in
[README.md](README.md).

## Architecture

Electron, with **no HTTP server**. The renderer has no Node access; everything
crosses the contextBridge as a handful of typed IPC calls:

```
assets/                   logo.png (transparent), sized variants, logo.icns
electron/main.ts          BrowserWindow + ipcMain handlers (filesystem lives here)
electron/preload.ts       contextBridge → window.agentree, and nothing else
electron/registry.ts      one surface over the three providers, routed by id
electron/transcripts.ts   Claude Code provider: ~/.claude/projects → nodes
electron/providers/codex.ts    Codex rollouts → nodes, fork-by-copy
electron/providers/copilot.ts  Copilot event logs → nodes, fork-by-copy
electron/providers/stitch.ts   fork families of linear sessions → one tree
electron/lineage.ts       fork-parentage sidecar (~/.agentree/lineage.json)
electron/meta.ts          sidecar annotation store
shared/types.ts           node/session types + the IPC contract
shared/render.ts          lineage walks, branch counting, token math
src/tree-layout.ts        chain compression + tidy layout
src/components/           TreeCanvas (the SVG) · NodePanel · Toolbar · Welcome
vscode-ext/               VS Code extension — same providers, same renderer
```

`contextIsolation: true`, `nodeIntegration: false`. A viewer that reads your
entire conversation history shouldn't also hand the page `require`.

### VS Code extension

The Electron split maps one-to-one onto a VS Code extension, built from the
SAME sources by `build-vscode.mjs` (`npm run build:vscode`): the extension
host bundles `electron/registry.ts` + `watch.ts` + `meta.ts` (nothing below
`main.ts`/`preload.ts` imports Electron — keep it that way), and the webview
runs the unmodified renderer. `vscode-ext/src/shim.ts` implements the exact
`window.agentree` surface over `postMessage`, loaded as a classic script
before the module bundle because `src/api.ts` reads `window.agentree` at
module-eval time. Host-side watchers are token-keyed like the ipcMain map and
closed on panel dispose. The webview HTML links `index.css` by hand (there is
no index.html for Vite to inject into), overrides the macOS traffic-light
insets, and pins the theme vars to VS Code's `body.vscode-dark/-light`
classes rather than the OS `prefers-color-scheme`. `onUpdateAvailable` is a
no-op there — the extension updates through VS Code. Package with
`npm run package` inside `vscode-ext/`; F5 from the repo root launches an
extension-development host.

## Three harnesses, one tree model

Everything downstream of parsing — layout, chains, annotations, the panel —
sees only `TurnNode[]`. The providers' job is to make three very different
stores produce that one shape. What each store actually is (all verified
empirically, not from docs):

|                    | Claude Code | Codex | Copilot CLI |
|--------------------|-------------|-------|-------------|
| transcript         | JSONL, one record per content block | JSONL "rollout", `session_meta` + `response_item` + `event_msg` records | JSONL event log per session dir |
| structure          | native DAG (`uuid`/`parentUuid`)    | linear, append-only | linear `id`/`parentId` event chain |
| clean display text | must be cleaned (wrappers, ANSI)    | `event_msg` `user_message`/`agent_message` are already clean | `data.content` on `*.message` events is already clean |
| plumbing to avoid  | `<system-reminder>`, command wrappers, task notifications | injected `role:"developer"`/`"user"` response_items (`<permissions instructions>`, `<environment_context>`…) | `transformedContent` (wraps the same text in `<current_datetime>` etc.) |
| usage              | `message.usage` per record | `event_msg token_count` (input includes cached; converted) | not recorded per turn |
| resume             | `claude --resume <id>` | `codex resume <id>` (appends to the SAME rollout) | `copilot --resume=<id>` (replays events.jsonl) |
| fork after turn N  | explicit `last-prompt` pin appended by the command at resume time (+ `--resume-session-at` for print mode) | new rollout = copied prefix + fresh `session_meta` with `forked_from_id` | copy session dir, truncate events.jsonl, rewrite ids |

### Forking where the harness has no resume-at flag

Claude Code can branch *inside* one transcript, so forking writes nothing.
Codex and Copilot cannot — their sessions are linear files, and their CLIs
resume only at the tip. But both can be forked by **copy-truncate**: write a
new session whose transcript is the old one up to the chosen turn.

- **Codex** does this itself (`codex fork`, tip-only): the child rollout
  carries a verbatim copy of the parent's records plus `forked_from_id` in its
  `session_meta`. Agentree writes exactly that format at ANY turn, so
  `codex resume <new-id>` — and codex's own tooling — accept the result.
  Verified: a fork cut before a "PONG" exchange resumed knowing only "PING",
  and a fork of a tool-using session recalled its tool results from the copied
  `function_call_output` records.
- **Copilot** resolves `--resume` purely from `~/.copilot/session-state/<id>/`;
  no row in its central SQLite is needed. The copy must rewrite the
  `sessionId` inside the copied `session.start` event — left stale, the
  resumed CLI logs new turns under the PARENT's id in the central store
  (observed before the rewrite was added). The central `session-store.db` is
  copilot's derived mirror and is never touched.

Both forks are non-destructive: a new file/dir appears, nothing existing
changes. The cut always lands on the turn's LAST raw record (`lastRawId`),
same as Claude — merged turns span many records.

### Stitching fork families back into a tree

A fork family (parent + copy-truncated children) *is* a tree, encoded as
shared prefixes across files. `stitch.ts` rebuilds it: children are matched
against their parent's chain turn-by-turn on (role, normalised text) — safe
because the prefix is a byte copy — and their suffix hangs off the last shared
turn. The welcome list shows one entry per family (the ⑂ badge counts the
stitched branch points); opening any member opens the family.

Parentage comes from `forked_from_id` for Codex (append-only, survives
anything). For Copilot it lives in Agentree's own sidecar
`~/.agentree/lineage.json`, because Copilot **regenerates workspace.yaml on
every resume and silently drops unknown keys** — a `forked_from:` key written
there was gone after one resume.

### Codex parsing notes

- The `session_meta` first line embeds the full base-instructions prompt —
  routinely 30–100 KB. Anything that "reads the first line" must be prepared
  to grow its buffer.
- `event_msg` records are the display stream; `response_item` records are
  read only for `function_call` names and reasoning summaries (the reasoning
  itself ships encrypted).
- Subagent threads (`thread_source: subagent`) are Codex's sidechains and get
  no listing of their own.
- Codex's `input_tokens` includes the cached part; Agentree stores the
  Anthropic-shaped split (uncached remainder + `cache_read_input_tokens`).

## The tree already exists

Claude Code writes one JSONL transcript per session, and every `user` /
`assistant` record carries `uuid` and `parentUuid`. A node with two children
*is* a branch — the CLI just has no way to show you one.

On this machine: **283 transcripts, 22 of them genuinely branched.**

### One turn is many records

Claude Code writes **one record per content block**. A reply with thinking +
text + a tool call becomes three chained `assistant` records sharing one API
`message.id`:

```
uuid=d6150676  blocks=[thinking]  textLen=0
uuid=c5c12fc1  blocks=[text]      textLen=155
uuid=4680dc83  blocks=[tool_use]  textLen=0
```

Drawn naively that's three nodes per turn, two of them blank. `transcripts.ts`
groups by `message.id` and emits one node per turn, merging the blocks. Some
messages span 27 records.

### Plumbing is stripped, real markup is not

Records carry ANSI escapes from captured command output and Claude Code's own
wrapper markup (`<local-command-stdout>`, `<command-name>`, `<bash-input>`, the
"Caveat:" preamble, `<system-reminder>`). Those are cleaned:

- **dropped entirely**: `local-command-caveat`, `system-reminder` — boilerplate
  addressed to the model, never written or read by a person;
- **unwrapped**: the rest keep their inner text, losing the tag.

The tag list is a deliberately short **allow-list**, not "strip anything
angle-bracketed". A census over the corpus found `<doc>` ×260, `<name>` ×90,
`<email>` ×102 and dozens more — all genuine content inside code samples and
quoted XML. A blanket strip would corrupt the very text it's meant to clean.
Five prose mentions of `` `<system-reminder>` `` (inside backticks, discussing
the tag) survive, correctly.

A record that is *nothing but* wrappers is rebuilt from the trimmed inner
values, because unwrapping in place strands the pretty-printer's indentation
(`/model` followed by twelve spaces and `model`).

### Only turns that said something get a node

A node must have text after the merge. That removes two large classes of noise
which together outnumber the real turns in an agentic session:

- `user` records that exist only to carry `tool_result` blocks back to the
  model — transport, not conversation;
- `assistant` turns whose entire content was a tool call or bare thinking.

The filter runs **after** the merge, so a turn that is thinking + tool_use +
one line of prose survives as that one line. Uncaptioned screenshots are
labelled `[image]` rather than dropped (3 in 2116 user records, but silently
losing one would be worse than a label).

Dropping these does not cost branch structure: `resolveParent` re-links
children to the nearest surviving ancestor, and the branched-session count was
identical before and after (22).

### Same-role runs fold into one turn

A linear run of consecutive same-role nodes becomes one node:

- **assistant** — with tool results gone, an agent loop is assistant →
  assistant → assistant; separate API messages, but one reply to one prompt;
- **user** — a slash command arrives as several records (command name, its
  stdout, hook output) before the next assistant turn.

Only merges where the parent has exactly one child, so branch points are never
collapsed — a branch below a run just re-parents onto the head. Usage is
**summed** here (each part is a distinct API call), which is the opposite of the
per-block merge above, where every record repeats one message's usage and
summing would multiply it. Absorbed ids are retained so sidecar annotations
still resolve.

### Most "branches" were an artifact

Parallel tool calls produce a fake fork: the second `tool_use` block and the
first tool's result both hang off the same record.

```
BRANCH at c36bdf9c  parent=assistant[tool_use]
   child  assistant[tool_use]   ← next tool call of the SAME turn
   child  user[tool_result]     ← result of the first one
```

Before coalescing turns and dropping tool results, one session counted **⑂9
when only 1 was real**, and the corpus looked like 56 branched sessions rather
than 22. Both fixes were needed: merging alone leaves the tool_result hanging
off the merged node.

### Lineage gotcha

Claude Code interleaves other record types — `attachment`, `system`,
`file-history-snapshot`, `mode` — into the same parent chain. Filtering to
displayable turns without **re-linking across the gaps** leaves most
`parentUuid` pointers dangling and collapses a 378-node tree to about seven
reachable nodes. `transcripts.ts` does two passes: build the full lineage from
every record that has a uuid, then resolve each kept node's parent to its
nearest surviving ancestor.

## Chains

Conversation trees are caterpillars: one long spine with short stubs. Drawn
node-per-circle they're a featureless vertical line thousands of pixels tall.
So runs of single-child turns collapse into one **chain** with a count badge —
click to expand the whole run, click again to collapse. Runs shorter than
`MIN_CHAIN` (3) draw as plain nodes instead: a chain spans ~2 rows and hides
its turns behind a pill, so a "⋯ 1" standing in for a single node saves nothing
and costs a click.

Effect on a real session: **89 turns → 5 drawn elements**, branch structure
legible at a glance.

Four things this got wrong first, all fixed and worth not re-introducing:

- **A chain must emit the node it terminates in.** Otherwise a collapsed run
  ends in empty space, hiding exactly the leaf you want to inspect. Every
  branch now visibly ends in a real, selectable node.
- **Don't keep the whole selected path uncompressed.** In a caterpillar that's
  nearly every node, so it defeats compression on exactly the shape compression
  exists for. The path is shown by edge highlighting instead.
- **Don't size a chain proportionally to the turns it hides.** A 200-turn run
  becomes an 8000px line. The span is fixed (`CHAIN_ROWS`); the badge carries
  the length.
- **`fit` must add the chain span to the measured height**, or the tail clips.

## Layout

Tidy tree by **subtree extent**, not fixed columns. Each subtree is laid out in
its own coordinate space and packed against its sibling with a fixed gap, then
the parent is centred over its children and the subtree grown to envelop its own
box. Because two subtrees never overlap, two nodes in the same row never can —
which is what lets a labelled node be a variable-width box instead of a dot.

Node width comes from `nodeWidth()` in `tree-layout.ts` and is *deliberately
generous*: SVG cannot measure text without rendering it, so a box is sized from
its character count, and under-measuring puts a box on top of its neighbour.
`TreeCanvas` draws the box using the same function, so the box drawn is exactly
the box siblings were spaced around. Fuzzed over 300 random trees / 139k
adjacent pairs: zero overlaps, zero out-of-bounds.

Structural nodes are **roots, branch points, leaves, and anything annotated** —
nothing else. A branch's first child is deliberately *not* structural: keeping
it drew a stray dot under every fork before compression could start.

**Selection is styling, never geometry.** `isStructural()` deliberately ignores
the selected node: making it structural would split a chain on every click,
changing the tree's dimensions and making the whole diagram jump. For the same
reason auto-fit runs once per session (via a ref, so a layout change can't
re-trigger it) — after the first frame the viewport belongs to the user. Drag to
pan, wheel to zoom (anchored at the cursor), `fit` to re-frame.

## Getting back to the CLI

Select any node; the panel gives you the session id plus ready-made commands:

```
cd "/Users/you/Quirky" && claude --resume 2a4fb7fd-5e5c-4f9d-be1e-dcf7a0b90f94
```

Sessions are stored per working directory, so `--resume` only finds one from
its own cwd — hence the `cd`. A `--fork-session` variant is offered too.

### Fork after a turn

`⑂ fork after this turn` hands you a command that resumes the session *from the
selected turn*:

```
cd "…" && printf '%s\n' '{"type":"last-prompt","leafUuid":"<uuid>","explicit":true,"sessionId":"<id>"}' \
  >> "<transcript>" && claude --resume <sessionId> --resume-session-at <messageUuid>
```

Two mechanisms, belt and braces, because they cover different CLI entrypoints:

- the appended record is `/rewind`'s **explicit `last-prompt` pin** — the only
  thing *interactive* resume obeys. Verified on CLI 2.1.220: the TUI hydrates
  the chain ending at the pinned uuid and the next exchange lands as a second
  child of it. `"explicit": true` is load-bearing — a bare `leafUuid` pointer
  is ignored and the resume lands on the tip (also verified).
- `--resume-session-at` is the Agent SDK's `resumeSessionAt`, and the CLI's own
  option table marks it **print-mode-only** ("use with --resume in print
  mode"). Interactive mode silently ignores it. Kept because it makes the same
  command correct under `-p`, and costs nothing interactively.

This is the fourth design:

1. **Copying the transcript under a new id** made every fork list as an
   unrelated conversation (and cost a full file copy per fork).
2. **Appending the pin at fork-click time** worked — but only if nothing wrote
   after it. A session open in a CLI appends its own non-explicit pointer on
   exit, and the loader's reducer lets any later record clear the pin. Users
   fork while the session is open, then exit to go resume: the pin died in
   exactly that gap, every time (observed as interleaved `explicit=True` /
   `explicit=None` pairs in a real transcript).
3. **The flag alone** looked correct because it WAS verified — in print mode.
   Interactive hydration never reads it, so every interactive fork quietly
   continued from the tip. (Bug report: "forking just continues the
   conversation".) The CLI help's "in print mode" clause is the tell.
4. **The pin, appended by the emitted command itself** immediately before the
   resume (`printf … >> transcript && claude --resume …`). Design 2's failure
   needed a writer to land between pin and resume; here that window is
   milliseconds inside one `&&` chain. Agentree still writes nothing at
   fork-click time — nothing happens until the user runs the command.

The anchor is the turn's **last** raw record (`TurnNode.lastRawId`), not its
`id`: a turn spans one record per content block, so anchoring on `id` would
resume mid-reply. Verified end-to-end in the interactive TUI: resume at a
mid-session assistant uuid → the model knows the prefix, has never seen the
later turns, and its reply lands as a second child of the anchored node.

## Live view

The tree follows the transcript on disk. With a session open, `fs.watch` covers
that file; on the welcome screen it covers the whole projects tree, so a
conversation started in another terminal appears on its own.

- The watch is on the *directory*, not the inode — a watch on a file goes deaf
  the moment the file is replaced.
- **Codex rollouts are watched by stat-polling, not fs.watch.** Codex's
  appends are invisible to macOS FSEvents: with a recursive AND a flat watch
  on the rollout's own directory, a live turn grew the file by kilobytes
  (stat saw it within 200 ms) and neither watcher fired once in 60 s — while
  an append to the same file from another process fired instantly. Codex's
  writes surface to FSEvents only when it closes the file (exec mode delivers
  everything in one burst at process exit — observed: zero events for 9 s,
  then the whole rollout at exit). So the codex and copilot roots get a
  1 s stat sweep (path+size+mtime over ~hundreds of transcripts, ~4 ms)
  alongside the fs.watch, feeding the same debounce. Claude stays on pure
  fs.watch — its writes fire FSEvents normally.
- Writes are debounced 250 ms. The CLI appends one record per content block, so
  one reply is a burst; without coalescing the file gets reparsed dozens of
  times per turn.
- Reload keeps your place: `expanded` survives, and the selection only follows
  the new tip if it was *already* on the tip. Otherwise you are reading history,
  and yanking the selection away as turns land would make the app unusable
  during a live session.
- Auto-fit is keyed on session id, so a live reload never moves the viewport.

## Interjections

A message typed while Claude is still working may never become a `user` record.
It is written once as `{"type":"queue-operation","operation":"enqueue",…}` — no
uuid, no parentUuid — and if it is then delivered *into* the running turn (queue
op `remove`, as opposed to `dequeue`) no record is ever created. The model saw
it; the transcript's DAG does not contain it. The tree was silently dropping
whole instructions this way — 10 of them in this project's own session.

`spliceInterjections()` reconstructs them and splices each **into** the chain,
re-parenting the record that followed it. Hanging them off the side instead
would turn every interjection into a spurious branch point — exactly the signal
this app exists to show. The re-parent only happens if the following record
still points where the interjection came after; otherwise the user rewound in
between and inventing a link would misreport history.

Deduplication is by content (normalised 80-char prefix), not by queue op:
`remove` covers both "delivered mid-turn" and "user deleted it", so the presence
of a real record is the only reliable evidence of which happened.

These nodes are drawn **hollow** and cannot be forked from — they have no uuid,
so there is no record to resume at.

## Welcome screen

A directory rail on the left — "All conversations", then every working
directory ranked by its most recent conversation — and one flat list on the
right, newest interaction first. Not grouped by folder: grouping buried a
conversation you touched ten minutes ago under a project you last opened in
March. No refresh button (the watcher keeps the list live) and no
"only branched" filter (the ⑂ badge carries that signal without hiding
anything).

Sessions renamed with `/rename` list under that name: the CLI appends a
uuid-less `custom-title` record, and a name the user chose beats anything
inferred from the first prompt. Last rename wins.

`updatedAt` is the newest timestamp on **any** record — not mtime (which moves
when the CLI rewrites bookkeeping for a session nobody is talking in), and not
the newest *displayed* turn (which stands still through a long tool loop,
making an actively-running session look minutes stale).

## Not dying under load

Two mechanisms, both born of a real incident (Electron at 100 GB RSS):

- **Summary cache** (`summaries` in `transcripts.ts`): the welcome scan parses
  every transcript — hundreds of files, hundreds of MB, ~950 ms and ~250 MB of
  garbage per pass. Cached by (mtime, size), a repeat scan is ~2 ms. Only the
  `SessionMeta` is cached, never the node arrays — keeping every session's
  turns resident would trade a CPU problem for a worse memory one. Deleted
  files are evicted on each scan.
- **Back-pressure** (`gate()` in `store.ts`): a scan takes far longer than the
  watcher's 250 ms debounce, so during an active conversation refreshes were
  issued faster than they completed; every pending IPC promise retained a full
  parse result and the renderer grew without bound. Now at most one refresh of
  a kind is in flight; changes arriving mid-refresh coalesce into exactly one
  follow-up pass — never a queue, never a missed update.

## Annotations

Labels, dead-end marks, and stars live in a sidecar at
`~/.agentree/meta/<sessionId>.json`, keyed by node uuid. Never written into
the transcripts: those are your real work, the CLI may be mid-append on them,
and our UI state shouldn't be indistinguishable from actual conversation
content.

## Notes

- Overlays recolour nodes by **output tokens** or **cache-hit rate**, both from
  the transcript's `message.usage`. Deliberately not a dollar figure: the
  transcript records tokens, not pricing, and a Max subscription has no
  per-token bill.
- Session titles come from the first non-plumbing user turn, computed **before**
  the same-role merge: a merged node can open with slash-command output and only
  then reach the real question.
- Assistant output renders as Markdown via a small hand-written renderer
  (`src/markdown.tsx`) that emits React elements rather than an HTML string. No
  `innerHTML`, so arbitrary transcript text needs no sanitiser; `javascript:`
  and other non-http schemes never become links. It recurses, so its regex is
  instantiated per call — a shared `/g` regex rewinds the outer cursor and hangs.
- The app icon is generated from `logo.png` by `scripts/make-icon.py`, which
  measures the rounded rectangle and rebuilds its boundary as an anti-aliased
  alpha mask. A naive "delete black pixels" would punch holes in the dark tree
  edges and node outlines of the artwork itself. Re-run it if `logo.png` changes.

## Mid-turn messages (`/btw`) and `/compact`

A message sent while Claude is working is recorded twice: as a uuid-less
`queue-operation` pair, and — on current CLIs — as a `queued_command`
**attachment** with a real uuid at the exact delivery point in the lineage.
Task notifications ride the *same* queue and the same attachment type
(`commandMode: "task-notification"`, null origin); naive splicing showed them
as hollow "user" turns the user never typed, which was most of the observed
"/btw weirdness".

Agentree now prefers the attachment records (`origin.kind: "human"` only),
falls back to queue-op reconstruction for old transcripts (deduped by
content), and drops notifications from the tree entirely. Verified against
the live CLI:

- a fork of any turn **after** an attachment-backed mid-turn message retains
  it — the resumed model can quote it back;
- the attachment uuid itself is NOT a valid `--resume-session-at` anchor
  ("No message found"), so those nodes explain themselves instead of forking;
- old-style queue-op interjections have no record at all, so forks crossing
  them still warn that the instruction is lost.

`/compact` writes a `system/compact_boundary` record with `parentUuid: null`
and the real predecessor in `logicalParentUuid` — without following that
field a compacted session shatters into a forest. The resume loader only
indexes messages after the LAST boundary, so forks of earlier turns fail;
Agentree marks those turns `preCompact` and refuses with the reason.

One more transcript reality: the harness does not persist every piece of
in-turn assistant prose. If nothing was recorded between two mid-turn
messages, they merge into one node — that is a faithful rendering of the
file, not a parser bug.

## Known gaps

- Copilot sessions from before the `events.jsonl` format (older CLI versions)
  are not listed — their turns live only in the central SQLite mirror.
- Copilot records no per-turn token usage, so the context/prompt numbers stay
  blank on those trees.
- `listSessions` parses every transcript per call — 283 files is fine, but it
  wants an mtime-keyed index beyond a thousand.
- Subagent turns are dimmed but not given their own lane.
- Not packaged — runs via `npm start`. `electron-builder` would produce a
  `.app`/`.dmg`; not set up yet.

## No overlay modes

Earlier builds had role/cost/cache colour overlays behind toolbar chips. They
were removed: a mode you must know to toggle, showing heat-ramp colours you
must know how to read, is chrome — and the cache ramp ("hot = cold cache")
confused even its author's user. What replaced them lives in the drawing
itself:

- a **legend** in the canvas corner decodes everything the tree encodes;
- the conversation **tip** breathes with a pulsed ring (static under
  `prefers-reduced-motion`), so "where is this session now" needs no mode;
- per-turn numbers stay in the panel (`prompt · output · % cached`), where
  they can carry units and words.


## Dead ends cover their subtree

Marking a turn as a dead end dims it **and everything beneath it** — an
abandoned exploration is abandoned as a whole, so the mark means "nothing down
here" rather than "not this one node". The ✕ still sits only on the marked
turn; unmarking it revives the subtree. Collapsed chains inside a dead subtree
dim too.
