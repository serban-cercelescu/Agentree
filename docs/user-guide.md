# Agentree user guide

> Your agent chats branch all the time. Agentree lets you see the branches,
> and continue from any of them.

When you work with Claude Code or Codex in VS Code, a conversation rarely goes
in a straight line:

- you fork from an earlier message to try another idea;
- you edit a prompt and resend it;
- you rewind after a bad turn.

The chat panel only ever shows the path you're on, so the other paths quietly
disappear. Agentree draws the whole conversation as a **tree**, so you can:

- **see** every branch you've made, in one picture;
- **read** any branch, from the start up to any turn;
- **continue** from (almost) any turn, in the agent's own chat panel.

This guide owns user workflows, configuration and limitations. The
[design notes](design.md) explain the internals and their evidence;
[AGENTS.md](../AGENTS.md) supplies contributor instructions.

- [Launch](#1-get-it-running)
- [Tree legend](#2-the-idea-in-one-picture)
- [List, tree and panel](#3-a-quick-tour)
- [Everyday workflows](#4-everyday-workflows)
- [Fork restrictions](#5-good-to-know)
- [Settings and data locations](#settings-and-data-locations)
- [Desktop and updates](#desktop-and-updates)
- [Limitations](#limitations)
- [Troubleshooting](#6-if-something-looks-off)
- [Cheat sheet](#cheat-sheet)

---

## 1. Get it running

Follow the [README installation steps](../README.md#using-it-in-vs-code),
then reload VS Code if prompted. VS Code 1.101+ is required independently of
your system Node version, because the extension uses VS Code's bundled runtime.
Open the Command Palette:

> **Ctrl/Cmd+Shift+P** → **Agentree: Open Conversation Trees**

Agentree opens in an editor tab. It finds your Claude Code and Codex history on
its own at the default locations. Use [settings](#settings-and-data-locations)
if your agents store history elsewhere. Copilot CLI history is also supported;
VS Code Copilot Chat is not.

> **Prefer a separate window?** Run `npm start` from the repo folder to open the
> desktop app. It has the same views and the same actions.

---

## 2. The idea in one picture

Every message is a dot. You are **blue** and the agent is **orange**. Time
flows downward. When a conversation splits, so does the tree.

```
                You: "Add drag-and-drop to the planner"
                 │
                Agent: "Two options: (A) native HTML5 DnD, (B) a library"
                 │
                You: "Go with A"
                 │
                Agent: implements A
                 │
        ┌────────┴──────────┐
        │                   ╎   ← long dashes: a fork starts here
  You: "Now add            You: "Actually, try B"      (you forked)
   keyboard support"        │
        │                  Agent: implements B
  Agent: …                  │
        ⋮  6                ◉   ← pulsing ring: the latest turn overall
        │
  Agent: "Done, tests pass"
```

There are three kinds of line:

| Line | Meaning |
|---|---|
| `│` **solid** | the conversation continues in the same session |
| `╎` **long dashes** | a **fork** begins here (a new session), or an **edited and resent Codex prompt** (a new branch of the same thread) |
| `⋮ 6` **dotted, with a number** | 6 ordinary turns folded away to save space; click to unfold |

Other marks:

- A **hollow dot** is an older mid-turn message reconstructed without its own
  transcript anchor. Current Claude attachment-backed mid-turn messages also
  cannot be forked directly; the panel explains the restriction.
- A **pulsing ring** marks the newest displayed leaf in the family, which can
  differ from the vendor's active path. Reduced-motion preferences make it static.
- A fork's first own turn has a **name tag**. An uninformative default title
  such as “Parent (fork)” becomes `fork <short id>`. User labels take its place;
  the tooltip keeps the full member title and inferred-parent wording. A Codex
  edit is in the same thread and gets no separate session-name tag.

Agentree also gathers every fork of a conversation back into one entry, even
though each fork is technically a separate session. You see one tree, not five
unrelated chats.

---

## 3. A quick tour

### The conversation list

The sketch below is illustrative; its counts are not a current store audit.

```
┌─────────────────┬────────────────────────────────────────────────────────────┐
│ Agentree        │  [ Filter by title, directory, or id… ]   158 conversations│
│                 │                                                            │
│ All convers. 158│  claude  66 files · 66 parsed · 61 listed · raw    ← health│
│ RECENT DIRS     │  codex  286 files · 124 parsed · 162 hidden · 87 listed    │
│  Agentree     2 │                                                            │
│  shop-api    48 │ ┌────────────────────────────────────────────────────────┐ │
│  notes        7 │ │ codex  Investigate the flaky checkout test             │ │
│  platform    78 │ │ ~\source\shop-api · 60 turns                           │ │
│  …              │ │ ⑂ 5  (5 sessions)  · 2h ago · 01a1353f                 │ │
│                 │ └────────────────────────────────────────────────────────┘ │
└─────────────────┴────────────────────────────────────────────────────────────┘
```

- **Left rail:** narrow the list to one project folder. A family matches any
  member's directory, so a fork created in another repository is findable there.
  Equivalent drive-letter, slash and Git Bash `/c/…` spellings are compared together.
- **Agent chips in the health rows:** show one provider or all providers.
  They combine with directory/search filters; rail counts follow the provider
  filter. Turning a provider off in settings is a separate scan preference.
- **Search:** root title/directory/id and fork titles/ids. A matching fork name
  is highlighted and brought forward under the family card. Clicking a name,
  or opening a card matched only by a fork, opens the tree **on that fork**:
  its newest turn is selected, and the panel's open/resume act on it.
- **Fork names:** cards show up to three names, more when needed to show search
  matches, then `+N`. Names are ordered by activity after search matches.
- **Sort indicator beside the count:** switches between last activity and last
  file change, also available in settings. Activity includes tools, so a long
  tool loop stays recent. “Last file change” includes bookkeeping record
  timestamps, such as an extension reloading a thread; it is not filesystem mtime.
- **`⑂ 5`:** this conversation branches in 5 places. Those are the
  interesting ones to open.
- **`5 sessions`:** five sessions, including the root, were joined into this tree.
- **The status rows at the top** are a quick health check. "Hidden" files are
  the agent's own bookkeeping (Codex's automatic reviews, for example) and are
  normal. **"Failed"** files are ones that should have been conversations but
  couldn't be read; the row then turns into a warning. If you see that, the
  agent has probably changed how it saves chats. See §6.

The list updates live. Start a chat in VS Code and it appears within a moment.
A quiet Codex fork uses its creation time until it has conversational activity;
reloading it does not by itself move the family to the top. Archived bases can
still supply history to live forks even when all-archived families are hidden.

### The tree

- **Drag** to move around, **scroll** to zoom, and click **fit** to see
  everything.
- **Click a dot** to select that turn. The path from the start to that turn
  lights up.
- **Click a dotted segment** (`⋮ 6`) to unfold the hidden turns. Click it again
  to fold them.
- **Esc** goes back to the list.

### The side panel

The panel always describes **the turn you selected** and **the session
open/resume will act on**:

```
CONVERSATION  codex · 5 sessions
SESSION  [fork]                    ← this turn lives in a forked session
  "…retry the payment step"
  forked from "…flaky checkout test"
  [open in Codex] [resume in terminal] [copy resume command] [copy id]

ASSISTANT · depth 22
  context 175k · 17% of window     ← how full the model's memory is here
  [copy node id] [mark dead end] [star] [label]
  [ ⑂ fork after this turn ]

  …the message itself…
  [view conversation up to here]
```

**"forked from" or "probably forked from"?** Codex records which thread a
fork came from, and so does Agentree when it makes a Claude fork. The Claude
Code panel's own "Fork conversation" records nothing: Agentree can tell the
two chats share history, and works out which came first from when their
files were created. The panel says "probably" when that's how it knows.
That inference can be wrong for copied/restored files with renamed titles;
it is evidence of likely direction rather than a vendor-recorded relationship.

**Which session?** Shared history is drawn once, but it belongs to every
session that copied or inherited it. When you opened the tree on a fork (by
its name in the list), the Session block keeps showing that fork for every
turn in its history, including the part it shares with its parent. A turn
the fork doesn't have shows the session it belongs to. On a shared turn the
session's title becomes a drop-down listing every session holding that
turn; pick one to act on it instead. Opening the tree from the card itself
focuses no fork: each turn shows the session it belongs to, and a shared
turn its original conversation.

A fork that has no turn of its own yet ("quiet") ends exactly where it was
forked: the tree never shows its last turn merged with what the original
said next.

---

## 4. Everyday workflows

### Read a branch from the beginning

Select any turn and click **view conversation up to here**. You get every
message on the path from the start down to that turn, as one readable thread,
with no other branches mixed in. (The agent's actual memory at that point held
more than is drawn: tool output, file contents and its own instructions.)

*Use it to remind yourself what you'd established before a branch went
sideways, or to copy a good explanation out of an old branch.*

### Pick up where you left off

Select a turn on the branch you want, then:

- **open in Claude Code / Codex** to continue in the agent's own chat panel; or
- **resume in terminal** to run `claude --resume …` / `codex resume …` in the
  right folder — pointed at the history location Agentree reads, if you set
  one in its settings (see [data locations](#settings-and-data-locations)).

These act on the **session shown in the panel's Session block** (see "Which
session?" above); check its title and id before handing off. Within one
session, the agent continues from where *it* left
off: the end of the session's current path. A session can hold several
branches (a rewind in Claude, a prompt edit in Codex), and selecting an older
one doesn't change which one the agent continues.

**To continue an older branch, fork it:** select its last turn and use
**⑂ fork after this turn** (next section). You get a new session that ends
exactly there.

### Try a different approach from an earlier point

This is the core move:

1. Find the last turn where things were still going well. It's often the
   agent's answer just *before* the decision you regret.
2. Select it and click **⑂ fork after this turn**. (In Codex, pick the
   agent's *final* reply of a turn: Codex forks whole turns, so a prompt or
   an in-between reply can't be a fork point, and the panel says so.)
3. In VS Code the new session opens in the chat panel by default; on desktop
   use the returned buttons. The automatic-open setting can override either
   default. The fork contains the conversation up to and including the
   selected turn as it was drawn when you clicked, and nothing after it. If
   that turn changed on disk in the meantime (a reply was extended, or a
   fork appearing elsewhere regrouped it), Agentree refuses rather than fork
   a different range: select it again once the tree has refreshed.
4. Type your new direction. The new branch grows in the tree as you go, joined
   by a dashed line.

```
   Agent: "Options A and B"   ← fork here
    │
    ├── You: "Go with A" … (an hour of trouble)
    ╎
    └── You: "Let's do B"      ← fresh start, same context
```

Nothing is deleted or changed: the original branch stays exactly as it was. If
the fork goes nowhere, mark it as a dead end and move on.

> **Fork in Agentree or in the chat panel?** Both work, and both show up in the
> tree. The chat panel is handy mid-conversation. Agentree is better when you
> want to go back *several* turns, because you can see exactly where you're
> landing.

### Keep a busy tree readable

| Action | Use it for |
|---|---|
| **label** | Name a branch ("approach B", "SQLite version"). The name is drawn in the tree. |
| **star** | Mark the answer you'll want to find again. |
| **mark dead end** | Dims the turn **and everything below it**. Click **revive** to undo. |

Annotations are stored only by Agentree, in `~/.agentree`. They never touch
your actual chats.
An annotation is saved with every session of the family, including forks
found later (the next time the tree is opened), so deleting the original
transcript doesn't lose it. Keep Agentree's data directory with your history
backups all the same: the desktop app and the extension writing at the same
moment can lose one change. If an annotation can't be saved (a read-only or
full disk, say), the panel says "Not saved" under the buttons and redraws the
tree from what is actually on disk.

### Context and token numbers

The panel shows **context** (for example "175k · 17% of window"): how much the
agent used at the nearest recorded API call, including prompt and output.
The panel uses the last call in a merged run; “prompt” totals across the run
include repeated history. These are token counts, not dollar charges, and
are not a literal reconstruction of the agent's hidden context.

The window percentage is approximate: Agentree infers a 200k or 1M window from
observed usage, rather than reading the vendor's configured limit. A larger-window
session that has never crossed 200k can therefore show a smaller inferred window.
Copilot CLI records no per-turn usage. Forking at an earlier valid point can
drop later detours, but the displayed percentage is guidance, not a guarantee
about the vendor's next request or performance.

---

## 5. Good to know

- **A brand-new fork appears in the tree after its first message.** Until then
  it's an exact copy, so there's nothing new to draw. It does count towards the
  "N sessions" shown on the conversation.
- **Codex forks take about 10 seconds.** Agentree asks Codex itself to make
  the fork, so it's a genuine Codex thread.
- **Codex prompt edits count as branches.** If you edited and resent a prompt
  in Codex, both versions appear, with a dashed line into the edited one.
- **Some turns can't be forked.** The button is greyed out and the panel
  tells you why:
  - turns from before a `/compact` in Claude;
  - Claude mid-turn messages, including reconstructed hollow dots and current
    attachment-backed messages. Fork from a later valid turn instead; it keeps
    attachment-backed messages. A reconstructed message without a raw record
    cannot itself become an anchor;
  - in Codex, anything but the last reply of a turn;
  - in Codex, a turn that a prompt edit replaced, unless a fork of that
    conversation still contains it. Fork the turn before the edit and resend
    your prompt instead.
- **Moved or deleted project folder?** Existing history stays listed. Agentree
  resolves multiple Claude files with one session id together; divergent
  continuations are retained. If the recorded session directory no longer
  exists, the terminal opens in your home folder instead.
- **Desktop app:** "open in Claude Code / Codex" switches to VS Code to open the
  session there. "Resume in terminal" opens PowerShell on Windows, Terminal.app
  on macOS or an available Linux terminal emulator.

---

## Settings and data locations

The welcome screen's **gear** opens settings shared by the desktop app and
extension in `<Agentree home>/settings.json`. Settings affect what is shown
and where data lives, never parsing/matching rules. Missing or invalid fields
fall back independently; a malformed JSON file falls back to defaults.

| Setting / JSON field | Default | Effect |
|---|---|---|
| Sort / `sortBy` | `"active"` | `"active"` dates/sorts by messages and tools; `"touched"` includes all record timestamps, bookkeeping included. Also switch beside the list count |
| Agents / `providers` | Claude, Codex and Copilot enabled | A disabled agent's history isn't read or watched at all: not listed, opened, forked or health-checked. Chips only filter the current list |
| Archived Codex / `showArchivedCodex` | `false` | Include families whose every thread is archived. Archived bases of live forks are read either way |
| Remember view / `rememberView` | `true` | Save compress-chains, directory and agent filters in `view`. Free-text search is not remembered. Turning it off clears the saved view, and none is saved while it is off |
| Open fresh fork / `openForkInChat` | Unset: on in VS Code, off on desktop | Automatically open a successful Claude/Codex fork in the chat panel. Explicit `true`/`false` overrides the host default; no native panel exists for Copilot CLI |
| Data/binary paths / `paths` | Unset; defaults below | `claudeConfigDir`, `codexHome`, `copilotHome`, `codexBin`; environment values override them |
| Desktop update check / `updateCheck` | `true` | Check at the next desktop launch; the extension uses VS Code's extension-update mechanism |

Checkboxes/radios save immediately. A path saves on blur or Enter; clearing
it removes the override. If a change can't be saved (a read-only or full
disk, say), the dialog says why, the path field shows "Not saved" with the
value still in force, and the message stays on the welcome screen until a
save succeeds. Enter **absolute paths**: `~` is a shorthand in this
guide and the placeholders, not expanded in settings. For example, use
`C:\Users\you\.codex` or `/home/you/.codex`. Invalid relative paths are ignored.
An environment-overridden path is shown read-only with the variable name.

For data/binary paths, precedence is **environment variable → saved setting →
default**. The Agentree home itself is environment-only, because it contains
the settings file.

| Environment variable | Saved path field | Default / purpose |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | `paths.claudeConfigDir` | `~/.claude`; reads `projects/` beneath it |
| `CODEX_HOME` | `paths.codexHome` | `~/.codex`; reads `sessions/`, `archived_sessions/` and `session_index.jsonl` |
| `COPILOT_HOME` | `paths.copilotHome` | `~/.copilot`; reads `session-state/` beneath it |
| `AGENTREE_HOME` | None | `~/.agentree`; settings, annotations and fork lineage |
| `AGENTREE_CODEX_BIN` | `paths.codexBin` | Newest matching Codex VS Code extension's bundled binary, then `codex` on `PATH`; used for forks |
| `AGENTREE_NO_UPDATE_CHECK` | Overrides `updateCheck` | Unset by default; any nonempty value disables the desktop check. Use `1` to disable, unset to re-enable (`0` also disables) |

A Claude, Codex or Copilot location you set applies to the agent too, not
just to what Agentree shows: Codex forks are made in that Codex home, and
**resume in terminal** and the **copy resume command** text set the agent's
variable (`CODEX_HOME` and so on) for the command. In PowerShell the copied
command sets it for the rest of that terminal session. **open in Claude Code /
Codex** can't pass it on: the chat panel uses its own extension's
configuration, and the panel reminds you when the two may differ.

Use full paths in environment overrides too. The VS Code extension inherits
the environment VS Code started with; restart it from the intended environment
after changing those variables. Saving in the panel refreshes the current
list and rebinds watches. Settings files are shared, but an already open second
host is not instantly pushed a new settings UI state; reopen/reload it if needed.
The automatic-open preference applies to the next fork, the update preference
to the next desktop launch.

Agentree's own files are `settings.json`, `lineage.json`, and
`meta/<sessionId>.json` beneath its home. If an old `~/.agentview` exists and
the default new home does not, Agentree attempts a one-time rename. Preserve
the home when backing up annotations and fork lineage. The [design notes](design.md#annotations)
explain formats, migration and durability limits.

## Desktop and updates

The desktop and extension share the same history and renderer. The extension's
Resume opens an integrated terminal; desktop opens an OS terminal. Open-in-chat
requires VS Code and the relevant vendor extension. Windows/Linux use native
window controls; macOS uses inset traffic lights.

The launchers clear `ELECTRON_RUN_AS_NODE`, which VS Code-started shells can
inherit. Start through `npm start` or the `agentree` launcher. The desktop
launch check compares the built revision with its own GitHub origin and branch;
an unpushed/unknown branch produces no update banner. If newer, the banner
offers a shell-appropriate `git pull` and `npm install` command. A source
tarball built without Git falls back to a version comparison on `main`.

The optional [POSIX install script](../scripts/install.sh) installs into
`<Agentree home>/app` and installs the global launcher through npm. It manages
that checkout by resetting it to `origin/main` on an update; use a separate
manual checkout for local development. It does not install a desktop OS package
and is not a Windows installer. The manual README steps work on Windows.

## Limitations

The [round 3](archive/2026-10-modernize/review-findings-round-3.md),
[round 4](archive/2026-10-modernize/review-findings-round-4.md) and
[round 5](archive/2026-10-modernize/review-findings-round-5.md) reviews'
findings are resolved. Supported-scope restrictions and evidence limits:

- Open/Resume continue the panel session's **current vendor path**, which can
  differ from the displayed newest branch. Fork a valid endpoint to continue
  an older branch. Claude pre-compact points, interjection anchors and Codex
  abandoned turns have the restrictions described above; legacy Codex has no
  vendor turn IDs and cannot be forked through this API.
- Agentree-made Claude forks omit file-history snapshots, so **rewind code**
  has no file snapshot to restore. Resuming a compacted fork or one ending in
  `tool_use` has not been verified end to end; ordinary two-prompt fork resume
  has. A parser/format test does not establish vendor resume behavior.
- Claude opening outside the current workspace and the Codex deep link have
  source-based evidence but incomplete native/visual verification. Use terminal
  resume if chat-panel hand-off fails. macOS/Linux terminal launch and some
  VS Code webview interactions also await direct checks.
- With a relocated history location, **open in Claude Code / Codex** works
  only if that extension uses the same location; terminal resume always does.
- A new Claude fork written in an entirely different, previously unwatched
  project directory can wait until another member event or reopen to join an
  already open tree. The welcome list scans all configured project directories.
- Inferred Claude parent direction can be wrong for copied/restored directories
  with renamed titles. The “probably forked from” label is intentional.
- Concurrent desktop/extension sidecar writes can lose changes. An annotation
  whose original transcript is deleted before any tree holding that turn is
  opened again can't be mapped. One saved by an earlier version on a prompt
  that only differs in whitespace from a sibling prompt can't be told apart:
  it is shown on neither, and left as it was. Annotations made now on such
  prompts are independent.
- A session stored in two project folders takes its title from the copy
  written last, by file modification time; copying folders around can change
  that order.
- VS Code Copilot Chat and Copilot CLI history predating `events.jsonl` are
  unsupported. Copilot has no per-turn token counts. Subagent turns have no
  separate lane; Claude sidechains that are drawn are dimmed, while Codex's
  plumbing/subagent sessions are hidden.
- The desktop app has no packaged installer. Detailed future scope and
  verification follow-ups live in the [remaining-work list](roadmap.md).

---

## 6. If something looks off

| You see | Try |
|---|---|
| A conversation is missing | Check the status rows. If a provider shows many files but few parsed, the agent changed its file format. Note the numbers and the agent's version and report it. |
| A list unexpectedly looks empty | Clear search, directory and agent filters; check Agents to scan and archived Codex settings, then confirm the effective paths. Missing/uninstalled roots are different from failed files |
| Two forks show up as separate conversations | Forks are joined by evidence the agent copies into every fork (Claude's reply ids, Codex's fork records). Each conversation's "N sessions" count shows what was joined. If a fork still stands alone, it's worth reporting with the agent's version. |
| "Open" continued a different branch in the same session | Open/Resume continue that session's current path. Fork at the valid end of the desired older branch (§4) |
| Open/resume offers the original conversation instead of a fork | On a shared turn, pick the fork in the Session block's drop-down, or open the tree by the fork's name in the list |
| "open in Claude Code" does nothing | The session may belong to a folder other than the one open in VS Code. Use **resume in terminal** instead. |
| `npm start` fails with `ipcMain` undefined | Use the current `npm start` launcher rather than bare `electron .`; it clears `ELECTRON_RUN_AS_NODE`. Rebuild if running stale output |
| The desktop app has no Electron | Run `npm approve-scripts electron`, then `node node_modules/electron/install.js`. |
| A compressed Codex file fails | Check the health row and runtime: local builds/tests need Node 22.15+, while the extension needs VS Code 1.101+ regardless of system Node |

---

## Cheat sheet

```
Open:            Ctrl/Cmd+Shift+P → "Agentree: Open Conversation Trees"
Find:            agent chip + directory + title/fork-name search
Sort:            click "by last activity / last file change" beside the count
Navigate:        drag · scroll-zoom · fit · Esc = back to list
Unfold turns:    click a dotted ⋮ n segment
Lines:           solid = same session · long dash = fork / edited branch
Read a branch:   select turn → "view conversation up to here"
Continue:        select turn → "open in Claude Code / Codex" (session's current path)
Branch off:      select turn → "⑂ fork after this turn" (also: continue an old branch)
Organise:        label · star · mark dead end (dims the whole subtree)
Configure:       welcome screen gear (environment overrides saved paths)
```
