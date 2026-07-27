# Agentree

A desktop app that draws your Claude Code conversations as an SVG tree.
Read-only: you talk to Claude in the CLI, and use this to see the shape of a
conversation and copy session ids back out to `--resume`.

```
npm install
npm run build && npm start     # app
npm run dev                    # app + Vite HMR
```

No API key, no Anthropic SDK, no network calls, no localhost port. It reads
`~/.claude/projects/**/*.jsonl` off disk and never writes to them.

## Architecture

Electron, with **no HTTP server**. The renderer has no Node access; everything
crosses the contextBridge as a handful of typed IPC calls:

```
assets/                 logo.png (transparent), sized variants, logo.icns
electron/main.ts        BrowserWindow + ipcMain handlers (filesystem lives here)
electron/preload.ts     contextBridge → window.agentree, and nothing else
electron/transcripts.ts parse ~/.claude/projects → nodes (read-only)
electron/meta.ts        sidecar annotation store
shared/types.ts         node/session types + the IPC contract
shared/render.ts        lineage walks, branch counting, token math
src/tree-layout.ts      chain compression + tidy layout
src/components/         TreeCanvas (the SVG) · NodePanel · Toolbar · Welcome
```

`contextIsolation: true`, `nodeIntegration: false`. A viewer that reads your
entire conversation history shouldn't also hand the page `require`.

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
cd "…" && claude --resume <sessionId> --resume-session-at <messageUuid>
```

`--resume-session-at` is an undocumented CLI flag (the Agent SDK's
`resumeSessionAt`): it loads the conversation as the chain ending at that uuid,
and the new exchange branches off it — same session id, same file, same tree,
drawn live by the watcher. Agentree writes **nothing**; the target travels on
the command line.

This is the third design, and the first correct one:

1. **Copying the transcript under a new id** made every fork list as an
   unrelated conversation (and cost a full file copy per fork).
2. **Appending `/rewind`'s explicit `last-prompt` pointer** worked — but only
   if nothing wrote after it. A session open in a CLI appends its own
   non-explicit pointer on exit, and the loader's reducer lets any later
   record clear the pin. Users fork while the session is open, then exit to go
   resume: the pin died in exactly that gap, every time (observed as
   interleaved `explicit=True` / `explicit=None` pairs in a real transcript).
3. **The flag** has neither problem: nothing is written until the user actually
   resumes, and no interleaved writer can stomp a command-line argument.

The anchor is the turn's **last** raw record (`TurnNode.lastRawId`), not its
`id`: a turn spans one record per content block, so anchoring on `id` would
resume mid-reply. Verified end-to-end: resume at a mid-session assistant uuid →
the model knows the prefix, has never seen the later turns, and its reply lands
as a second child of the anchored node.

Caveat: hidden flags aren't a stable interface. If a future CLI drops
`--resume-session-at`, the fallback is design 2's pointer append issued
immediately before the resume.

## Live view

The tree follows the transcript on disk. With a session open, `fs.watch` covers
that file; on the welcome screen it covers the whole projects tree, so a
conversation started in another terminal appears on its own.

- The watch is on the *directory*, not the inode — a watch on a file goes deaf
  the moment the file is replaced.
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

## Known gaps

- **`/btw` forks behave weirdly** — forks made off a `/btw` (side-question)
  turn come out wrong; the behaviour needs investigating and fixing.
- `listSessions` parses every transcript per call — 283 files is fine, but it
  wants an mtime-keyed index beyond a thousand.
- No file watching; sessions re-read on `refresh`.
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
