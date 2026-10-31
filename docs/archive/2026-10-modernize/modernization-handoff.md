# Agentree modernization handoff (2026-10)

> **Historical handoff, 2026-10.** Retained with its assumptions, implementation corrections and evidence labels. It does not override the [current design notes](../../design.md) or [working instructions](../../../AGENTS.md). The [round 3 review](review-findings-round-3.md) has since been resolved; references below to `AGENTS.md` as the engineering manual describe its role at the time.

> **Status (2026-10-27):** P0–P3 are implemented on branch `modernize`, and
> AGENTS.md now describes the result. Copilot Chat (P4) and the canary (P5)
> are still open. Corrections found while implementing, which supersede this
> document:
>
> - **`history_base` is everywhere, not absent.** Every non-root Codex page
>   carries one; the earlier count missed them inside `.jsonl.zst` files.
>   Prompt edits are pages too. Cuts always land on turn boundaries, so the
>   **raw page graph gives an exact tree, including edit branches**, which
>   `thread/turns/list` hides. Decision: read the tree from the files, and use
>   app-server only for `thread/fork` (§2.1 amended).
> - Claude extension forks **do** preserve `message.id`, `promptId` and
>   `requestId`, and append `custom-title "<title> (fork)"`. Families are
>   matched on `message.id`.
> - The Agent SDK wasn't bundled (licence). `claude-fork.ts` writes the
>   extension's own fork format plus `forkedFrom`.
> - Codex bases can live in `archived_sessions/`. Codex item ids (`item-1`, …)
>   aren't unique, so node ids are `<turnId>:<itemId>`.
> - `~/.copilot/session-state` exists on the target machine (5 sessions).
>
> A review of that implementation ([review-findings.md](review-findings.md))
> was resolved the same day; the resolution is recorded at the top of that
> file. **AGENTS.md is now the authoritative description of the formats** —
> where this brief says it overrides AGENTS.md, read it as history.

Context for an agent bringing Agentree up to date with today's Claude Code and
Codex, used **through their VS Code extensions**, with VS Code Copilot Chat as a
later phase. Read [AGENTS.md](../../../AGENTS.md) first for the design history. This
document **overrides AGENTS.md wherever they disagree** about how the harnesses
store data. AGENTS.md describes July 2026, and several of its facts no longer hold.

Every claim below is tagged:

- **[verified]**: observed on the target machine's real data, or by running the
  installed tool, between 2026-10-21 and 2026-10-27;
- **[source]**: read in the vendor's shipped code or type definitions, not
  executed;
- **[unverified]**: inferred or reported elsewhere. Check before relying on it.

---

## 1. Situation

| | |
|---|---|
| Repo state | Last commit `58cf671` (2026-07-31). The whole repo was written in 5 days by its original author, with no upstream activity since. ~4.8k lines. |
| Target user | Windows 11. Their main interface is VS Code chat panels, not terminals. They branch by **forking from a message** in the Claude Code extension, the Codex extension and Copilot Chat. |
| Versions on target machine | VS Code 1.143.1 · Claude Code extension 2.1.310 (CLI 2.1.296) · Codex extension `openai.chatgpt` 26.1021.22027 (codex-cli 0.162.1) · Copilot Chat built in |
| Goal | Agentree's VS Code extension shows Claude and Codex conversations, **including extension-made forks**, as one tree per conversation family. Fork-at-turn uses the vendors' official APIs. Resume and open hand off to the native extensions. Works on Windows. Fails loudly when a format changes. |

### What works today, measured against real data [verified]

| Provider | Data on machine | Agentree result |
|---|---|---|
| Claude Code | 54 transcripts (37k records tagged `entrypoint: "claude-vscode"`, 52 tagged `"cli"`) | Lists 52 sessions and parses them. **Extension forks show as unrelated sessions.** Titles are often the raw `<ide_opened_file>…` wrapper. |
| Codex | 276 rollouts: **232 `.jsonl.zst`** + 44 `.jsonl`, all `history_mode: "paginated"` | **0 sessions listed.** The parser targets the pre-paginated event names and ignores `.zst`. |
| Copilot | No `~/.copilot/session-state` (Copilot CLI unused). VS Code Copilot Chat: 159 workspaces, 1,820 `.jsonl` + 248 legacy `.json` sessions | Not supported (Agentree only reads Copilot **CLI**). |
| Fork / resume commands | n/a | POSIX-only (`cd … && printf … >> … && claude …`). Fails in Windows PowerShell 5.1. |

---

## 2. Strategy (decided; don't relitigate)

1. **Read through official APIs where they exist; parse raw files only where
   no API exists.** The raw formats are undocumented internals that change
   without notice. Codex changed the record layout, compression and fork
   encoding between July and October 2026. Official APIs move together with the
   vendors' own extensions.
   - Codex → `codex app-server` (JSON-RPC over stdio).
   - Claude → `@anthropic-ai/claude-agent-sdk` session functions for list,
     metadata and fork. Raw transcript parsing stays **only** for building the
     tree, because the SDK returns just the active chain.
   - Copilot Chat → no API exists. Parse raw files, gated on the format's
     `version` field.
2. **A conversation family across session files is the primary tree model.**
   All three extensions fork by *copying* into a new session. Branches inside
   one Claude transcript (rewind) still exist, but they're secondary.
   Generalise `electron/providers/stitch.ts` to every provider, and attach
   evidence and confidence to each link (§5.2).
3. **Hand off to the native extensions** for resume and open, instead of
   emitting shell commands. Keep a shell command as a fallback, and make it
   Windows-correct.
4. **Fail loudly.** A provider that finds N files and parses 0 must say so in
   the UI.
5. **The VS Code extension is the primary product.** Keep the Electron app
   building, but don't spend effort on it.

---

## 3. Ground truth per harness

### 3.1 Claude Code

**Storage** [verified]: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`. Subagent
transcripts live under `<sessionId>/subagents/`. The slug keeps the drive letter's
case as written, e.g. `c--Users-…` and `C--Users-…` can both occur.

**Record types seen** [verified] (counts across 54 files): `assistant`,
`attachment`, `user`, `last-prompt`, `bridge-session`, `atis-latch`, `ai-title`,
`api-request-blob`, `queue-operation`, `api-request`, `mode`,
`file-history-delta`, `file-history-snapshot`, `custom-title`, `cost-state`,
`system`, `api-request-shape`, `permission-mode`, `pr-link`, `agent-name`, and
others. Agentree's two-pass parent re-linking already tolerates unknown
types. Keep that property.

- `ai-title` `{aiTitle, sessionId}`: the CLI's auto-generated title. **Use it**
  (precedence: last `custom-title` > last `ai-title` > first prompt).
- `api-request-blob` records carry `message` with content blocks. **They are not
  conversation turns.** Exclude them explicitly; don't let them reach the turn
  builder.
- `last-prompt` `{leafUuid, lastPrompt, sessionId}`. Of 3,011 such records, 0
  had `explicit: true`, so Agentree's fork pin has never been used here.
- User turns from the VS Code extension wrap context in `<ide_opened_file>…</ide_opened_file>`
  and `<ide_selection>…</ide_selection>`. Add both to the **drop** list in
  `transcripts.ts` (they're plumbing, like `system-reminder`), or titles become
  "The user opened the file…".
- `entrypoint` on every turn record: `"claude-vscode"` or `"cli"`. Use it as a
  badge and to choose the default resume target.

**Extension "Fork conversation"** [verified on 2 pairs: `792729c5` ⟵ `311498fc`
after 6 prompts; `e612787f` ⟵ `1ad678f4` after 4]:

- writes a **new session file** in the same project dir with a new `sessionId`;
- copied records get **new `uuid`s** but **keep their original `timestamp`s**
  (first-record timestamps identical across each pair);
- writes **no lineage field** (no `forkedFrom`, nothing pointing at the parent);
- whether `promptId` / `requestId` / `message.id` survive the copy is
  **[unverified]**. Check, because these are strong match evidence.

So extension forks must be found by matching (§5.2). Prior art: Codex History
Viewer `src/analysis/claudeBranchAnalysisService.ts` unions records across
files on evidence keys `record uuid | promptId | requestId | timestamp`, each
paired with a text fingerprint, then confirms structural prefixes [source].

**Agent SDK** `@anthropic-ai/claude-agent-sdk` 0.3.311 (published
2026-10-26) [source, `sdk.d.ts`]:

```ts
listSessions({ dir?, limit?, offset?, includeWorktrees?, includeProgrammatic? }): Promise<SDKSessionInfo[]>
//   SDKSessionInfo = { sessionId, summary, lastModified, fileSize?, customTitle?, firstPrompt?, gitBranch?, cwd?, tag?, createdAt? }
getSessionInfo(sessionId, { dir? }): Promise<SDKSessionInfo | undefined>
getSessionMessages(sessionId, { dir?, limit?, offset?, includeSystemMessages? }): Promise<SessionMessage[]>
//   active chain only (follows parentUuid from the leaf), NOT the full tree
forkSession(sessionId, { dir?, upToMessageId?, title? }): Promise<{ sessionId }>
renameSession(sessionId, title), tagSession(sessionId, tag | null)
```

- `forkSession` copies messages into a new session file with fresh UUIDs, slices
  at `upToMessageId` (inclusive), and stamps every copied record with
  `forkedFrom: { sessionId, messageUuid }` [source, `sdk.mjs`]. **Forks Agentree
  makes this way carry explicit lineage**, unlike extension forks.
- The session functions are plain file operations in JS and don't spawn the
  CLI [source]. `query()` does spawn the CLI; Agentree doesn't need it.
- **Licence:** "© Anthropic PBC. All rights reserved", not MIT. Bundling it
  into an MIT-licensed extension is a decision for the human owner (§8). The
  fallback is to reimplement `forkSession`'s output format: copy the prefix,
  remap uuids, keep the parent chain, add `forkedFrom`.
- Running the SDK against the user's data was **not** done (blocked by the
  sandbox). First task: confirm `listSessions` returns the 52 sessions and
  `forkSession` output resumes in the extension.

**Opening a session in the Claude extension** [source, extension 2.1.310]:

- URI: `vscode://anthropic.claude-code/open?session=<sessionId>[&prompt=<text>]`
- From inside a VS Code extension, the same handler calls
  `vscode.commands.executeCommand("claude-vscode.primaryEditor.open", sessionId, prompt?)`.
  `claude-vscode.editor.open` is the variant that opens a new tab.
- **[unverified]** whether the extension's session picker shows a session written
  by `forkSession` without a reload.

**Superseded: AGENTS.md "Fork after a turn"** (the appended `last-prompt` pin
with `explicit: true`, plus `--resume-session-at`). It writes into the user's
real transcript and depends on undocumented reducer behaviour. Replace it with
`forkSession(upToMessageId = node.lastRawId)` and then open the new session.
Keep the pin path only behind a flag, if at all.

**Unchanged and still valid from AGENTS.md** [verified that the parser still
produces them]: per-`message.id` block merge, the tool-result filter, same-role
run folding, two-pass parent re-linking, `compact_boundary.logicalParentUuid`,
`queued_command` attachments, the interjection reconstruction.

### 3.2 Codex

**Storage** [verified]:
`~/.codex/sessions/YYYY/MM/DD/rollout-<localStamp>-<threadId>.jsonl[.zst]`.
Older rollouts are **zstd-compressed** (`.jsonl.zst`, 232 of 276). There are also
files named `rollout-…-<threadId>_<otherId>.jsonl.zst`, which are
**revision/page files of a paginated thread** (prompt edits). Archived threads
live in `~/.codex/archived_sessions/`. State lives in SQLite (`state_5.sqlite`,
`thread_history_1.sqlite`, …), which Codex owns; never write to it.

**Record shape, paginated rollout** [verified; every record has `timestamp`,
`ordinal`, `type`, `payload`]:

| `type` / `payload.type` / `payload.item.type` | Meaning |
|---|---|
| `session_meta` | `id`, `session_id`, `cwd`, `originator` (`codex_vscode`), `cli_version`, `source` (`vscode`), `thread_source` (`user` \| `guardian_review` \| `{subagent:…}`), `history_mode: "paginated"`, optional `forked_from_id`, huge `base_instructions` |
| `event_msg/task_started` | turn start: `turn_id`, `root_turn_id`, `turn_attribution` |
| `event_msg/item_completed/UserMessage` | **user turn**: `item.content[].text` |
| `event_msg/item_completed/AgentMessage` | **assistant prose**: `item.content[].text`, `item.phase` = `commentary` \| `final` |
| `event_msg/item_completed/FileChange`, `…/CommandExecution`, `…/Reasoning`, … | tool activity (use for `toolUses`) |
| `event_msg/task_complete` | turn end: `last_agent_message`, `duration_ms` |
| `event_msg/token_count` | `info.last_token_usage` / `total_token_usage` (`input_tokens` includes cached) |
| `token_usage_record` | per-response usage keyed by `turn_id` |
| `response_item/message` (`role`: user/assistant/developer) | raw API items; **developer/user ones carry harness plumbing** |
| `response_item/custom_tool_call(_output)`, `reasoning` (encrypted) | raw tool calls |
| `turn_context`, `world_state`, `thread_settings_applied`, `compacted` | settings and context snapshots |

The old `event_msg/user_message` and `event_msg/agent_message` that
`electron/providers/codex.ts` reads **no longer occur** in paginated rollouts.
That's why it lists 0 sessions.

**`history_base`** [source, Codex History Viewer `codexHistoryBase.ts`; 0
occurrences on this machine]: a paginated record payload may carry
`history_base: { thread_id, end_ordinal_exclusive, end_byte_offset }`. The
thread's history then *starts with another rollout's prefix by reference*,
not by copy. This **breaks stitch.ts's assumption** that a fork contains a
byte copy of the parent's prefix. app-server resolves it for you.

**Guardian threads**: `thread_source: "guardian_review"` (session_meta `source`
is `{"subagent":{"other":"guardian"}}`). These are auto-review threads (18 of the
first 47 seen). Hide them as you would subagents.

**app-server API** (`codex app-server`, marked *experimental*):

- Generate exact TypeScript types from the installed binary. **Do this
  rather than hand-writing them**, and commit the output under a
  version-stamped dir:
  `codex app-server generate-ts --out <dir>` (also `generate-json-schema`).
- Handshake [verified]: send `{"id":1,"method":"initialize","params":{"clientInfo":{"name":"agentree","version":"…"}}}`,
  then the notification `{"method":"initialized"}`. Messages are newline-delimited JSON.
- `thread/list {limit≤100, cursor, sortKey?, cwd?, archived?, sourceKinds?}` → `{data, nextCursor}`
  [verified: 115 interactive threads across 2 pages, compressed files included;
  `historyMode` all `"paginated"`]. **`forkedFromId` is NOT populated by
  `thread/list`** [verified: 0 of 115].
- `thread/read {threadId, includeTurns?}` → `{thread}`. Populates `forkedFromId`
  (fork lineage) and `parentThreadId` (subagent parent) [verified: `01a1396e…`
  → `forkedFromId 01a13945…`; `01a11108-8f7e…` → `parentThreadId 01a11108-8c98…`].
  `Thread.sessionId` is documented as "shared by threads that belong to the same
  session tree" [source]. On the forks read, each thread's sessionId equalled
  its own id, so **don't** rely on it for family grouping; use `forkedFromId`.
- `thread/turns/list {threadId, cursor, limit, sortDirection, itemsView}` and
  `thread/items/list` to page turns and items. Full-history `includeTurns` is
  deprecated for paginated threads [source].
- `thread/fork {threadId, lastTurnId?, excludeTurns?, cwd?, …}`: **fork through
  any completed turn (inclusive)** [source; not executed because it creates a
  thread]. This replaces `forkCodexAt`'s hand-written copy-truncate.
- `Turn = {id, rootTurnId, items, itemsView, status, error, startedAt, completedAt, durationMs}` [source].
- Startup logs an `ERROR` line about an unrecognised `config.toml` key on this
  machine. That's harmless; don't treat stderr as fatal.
- **[unverified]** whether a thread created by a separately spawned
  `codex app-server` shows up live in the VS Code extension. The extension runs
  its own daemon (`~/.codex/app-server-daemon`), and `codex app-server proxy`
  attaches to it over stdio. Prefer `proxy` if it works, so forks land in the
  extension's own process.

A working read-only probe (Node ≥ 18, Windows-safe):

```js
import { spawn } from "node:child_process";
const p = spawn("codex", ["app-server"], { shell: true, stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0; const waiters = {};
p.stdout.on("data", (d) => { buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(l); if (m.id != null) waiters[m.id]?.(m); } catch {} } });
const call = (method, params) => new Promise((r) => { const n = ++id; waiters[n] = r;
  p.stdin.write(JSON.stringify({ id: n, method, params }) + "\n"); });
await call("initialize", { clientInfo: { name: "agentree-probe", version: "0" } });
p.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
const page = await call("thread/list", { limit: 100 });          // → result.data, result.nextCursor
const one = await call("thread/read", { threadId: page.result.data[0].id }); // → result.thread.forkedFromId
console.log(page.result.data.length, one.result.thread);
p.kill();
```

**Opening a thread in the Codex extension** [source, `openai.chatgpt`
26.1021.22027]: its URI handler forwards the path to its webview router, and
threads are routed at `/local/<threadId>`. So
`vscode://openai.chatgpt/local/<threadId>` **should** open a thread
**[unverified]**. Test it before shipping, and fall back to
`codex resume <id>` in a terminal.

**Fallback raw parser** (if app-server is unavailable): read `.jsonl` and
`.jsonl.zst`. Node ≥ 22.15 has `zlib.zstdDecompressSync`; VS Code 1.143's
extension host Node version is **[unverified]**, so feature-detect. Take user
turns from `item_completed/UserMessage` and assistant turns from
`AgentMessage` (join the `commentary` and `final` phases of one turn into one
node). Group by `turn_id`, and take usage from `token_usage_record`. Resolve
`history_base` and revision files the way Codex History Viewer does, or report
the session as unsupported.

### 3.3 VS Code Copilot Chat (phase 4, read-only)

**Storage** [verified]: `%APPDATA%/Code/User/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl`
(current) and `<sessionId>.json` (legacy, a whole object with `version: 3`).
`<hash>/workspace.json` → `{ "folder": "file:///c%3A/…" }` maps a hash to a
folder. Chats opened with no folder live in
`%APPDATA%/Code/User/globalStorage/emptyWindowChatSessions/` (10 here). The same
session file can appear under several workspace hashes, so **dedupe by
`sessionId`**. `<hash>/state.vscdb` key `chat.ChatSessionStore.index` holds
VS Code's own index; read it, never write it. Insiders uses `Code - Insiders`.

**Format: an operation log** [verified by replaying samples; semantics should
be confirmed against microsoft/vscode's chat serializer]:

- line 1 `{kind: 0, v: <full session snapshot>}`;
- `{kind: 1, k: [path…], v}`: set the value at the path;
- `{kind: 2, k: [path…], v: [items], i?}`: array append, or splice from index `i` when present;
- `{kind: 3, k: [path…]}`: delete.

Replayed session: `version` (3 on all 400 recent files), `sessionId`,
`creationDate`, `customTitle`, `initialLocation`, `responderUsername`,
`requests[]`, `inputState`, `pendingRequests`. Each request has `requestId`,
`timestamp`, `message.text`, `modelId` (e.g. `copilot/claude-opus-4.6`),
`agent.id`, `response[]`, `result` (`timings`, `metadata.promptTokens` /
`outputTokens` / `toolCallRounds` …). `response[]` parts have a `kind`:
`thinking`, `toolInvocationSerialized`, `inlineReference`, `textEditGroup`,
`codeblockUri`, `undoStop`, `mcpServersStarting`. Parts with **no `kind`** are
markdown `{value}`; those make up the assistant prose.

**"Fork Conversation"** (VS Code ≥ 1.110) [verified on `60d59581` ⟵ `e611da7e`]:

- new session, `customTitle` prefixed **`"Forked: "`**;
- copied requests get **new `requestId`s** (uuid style instead of `request_…`)
  and **timestamps reset to fork time**;
- no lineage field.

Matching must therefore use the user **and** assistant text of the shared
prefix, plus the title hint. Matching on user prompts alone is wrong: on this
machine 13 sessions share one opening prompt because the user re-pasted it,
and only one of those is a fork.

**Resume / open**: no public command to open a specific chat session is known
**[unverified]**. Phase 4 is read-only.

Reference implementation for the op-log reader (MIT, Rust):
`src-tauri/src/providers/vscode.rs` in jhlee0409/claude-code-history-viewer.

---

## 4. Current code map and what changes

| File | Today | Change |
|---|---|---|
| `electron/registry.ts` | routes by "whoever has the id" | provider list + per-provider health (§5.4) |
| `electron/transcripts.ts` (863 lines) | Claude DAG parser | add `ide_*` wrappers to the drop list; exclude `api-request-blob`; titles from `ai-title`; expose `entrypoint`; feed cross-file family detection |
| `electron/fork.ts` | builds the pin + `--resume-session-at` shell command | replace with SDK `forkSession` (or a reimplementation), then open in the extension |
| `electron/providers/codex.ts` (505) | raw parser of the old format; copy-truncate fork | rewrite on top of app-server; keep a raw fallback (§3.2) |
| `electron/providers/stitch.ts` (90) | prefix match on (role, gist(text)) | generalise: evidence-based links, confidence, timestamp-aware for Claude |
| `electron/providers/copilot.ts` (405) | Copilot **CLI** | keep as is (untested here); add a new `copilot-chat.ts` provider |
| `electron/lineage.ts` | Agentree's sidecar for Copilot CLI forks | also record links for forks Agentree creates (belt and braces with SDK `forkedFrom`) |
| `electron/watch.ts` | fs.watch + 1 s stat poll for codex/copilot | also watch `.jsonl.zst` and the workspaceStorage `chatSessions` dirs; or subscribe to app-server notifications |
| `shared/types.ts` | `ProviderId = claude \| codex \| copilot` | add `copilot-chat`; `ForkResult` gains an open action (§5.3); `TurnNode` gains `sourceSessionId`, `linkConfidence` |
| `vscode-ext/src/extension.ts` | webview bridge | runs providers in the extension host; executes open/resume commands directly via `vscode.commands` |
| `package.json` `dev:app` | `AGENTVIEW_DEV_URL=… electron .` (POSIX env syntax) | use `cross-env` or a Node launcher |

Keep the constraint in AGENTS.md: nothing under `electron/registry.ts` may
import Electron, because the extension bundles it.

---

## 5. Target design

### 5.1 Provider interface

```ts
interface Provider {
  id: ProviderId;
  /** Cheap: metadata only. Must never throw; report problems via health(). */
  list(): Promise<SessionMeta[]>;
  /** One family, stitched. */
  load(sessionId: string): Promise<SessionDetail | null>;
  fork?(sessionId: string, nodeId: string): Promise<ForkResult>;
  health(): ProviderHealth;
}
interface ProviderHealth {
  filesSeen: number; sessionsParsed: number;
  formatVersions: Record<string, number>;   // e.g. {"codex-cli 0.162.0": 44, "claude 2.1.29x": …, "chat v3": 400}
  unknownRecordTypes: Record<string, number>;
  backend: "api" | "raw";                   // app-server/SDK vs raw fallback
  error?: string;
}
```

### 5.2 Family / lineage model

A family is a set of sessions plus links `child → (parent, divergence turn)`.
Each link carries the strongest evidence found:

| Rank | Evidence | Providers | Confidence |
|---|---|---|---|
| 1 | explicit field: `forkedFromId` (app-server), `forked_from_id` (rollout), `forkedFrom` (SDK fork) | Codex, Claude via SDK | certain |
| 2 | Agentree's own sidecar (`~/.agentree/lineage.json`), written when Agentree creates a fork | all | certain |
| 3 | shared prefix with identical **timestamps** + text fingerprints | Claude extension forks | high |
| 4 | shared prefix of user **and** assistant text + `"Forked: "` title | Copilot Chat | high |
| 5 | shared prefix of text only | any | low: draw it, labelled "inferred" |

Rules:

- The divergence point is the last shared turn. The child's suffix hangs there.
- The parent may have grown after the fork. Compare only up to the child's
  first mismatch.
- Never merge two sessions just because they share an *opening prompt*. Require
  at least one shared assistant turn.
- Show inferred links differently in the canvas (e.g. a dashed edge) and say so
  in the legend.
- Node ids stay `<sessionId>#…` or a raw uuid, so sidecar annotations keep
  resolving. A stitched node records `sourceSessionId` so a fork action targets
  the right file.

### 5.3 Fork and open

```ts
type ForkResult =
  | { ok: true; id: SessionId; cwd: string;
      open?: { command: string; args: unknown[] } | { uri: string };  // preferred inside VS Code
      command?: string;                                               // shell fallback, per-OS
      note?: string }
  | { ok: false; error: string };
```

- **Claude**: `forkSession(sid, { upToMessageId: node.lastRawId, dir: cwd })`,
  then write the sidecar link, then open with
  `claude-vscode.primaryEditor.open(newId)`. Keep AGENTS.md's refusals:
  pre-compact turns, `injected` turns, and `midTurn` attachment nodes can't be
  fork anchors. Re-check the pre-compact refusal against `forkSession`
  **[unverified]** whether it slices across a compact boundary.
- **Codex**: `thread/fork { threadId, lastTurnId }`, then open
  `vscode://openai.chatgpt/local/<newId>`, falling back to `codex resume <newId>`.
- **Shell fallback**: generate for the host shell. On Windows PowerShell 5.1,
  use `Set-Location '<cwd>'; claude --resume <id>` (no `&&`, no `printf`). With
  the SDK fork, no transcript append is needed, so the command is just a resume.

### 5.4 Fail loudly

On the welcome screen, show one status row per provider:
`Codex · 276 files · 0 parsed · backend raw · unknown types: item_completed ×1288`.
Show a warning when `sessionsParsed / filesSeen` drops below a threshold or
when the unknown-type counts grow. This one row would have flagged the Codex
break on day one.

---

## 6. Work plan

Each phase ends green on `npm run typecheck` and its own fixture tests.

**P0 · Safety net**
- Add `test/fixtures/<provider>/<format-version>/…`: small **anonymised**
  transcripts. Include a Claude extension fork pair, a Codex paginated rollout,
  a `.jsonl.zst` file, a revision file, and a Copilot fork pair. Add golden
  outputs: node count, branch points, link evidence.
- Add a test runner (vitest; none exists today) and the health surface (§5.4).
- Done when: the tests run on Windows, and the health row shows on the welcome screen.

**P1 · Codex on app-server**
- Generate and commit the types; add a small JSON-RPC client in the extension host.
- List with `thread/list`, then fork lineage with `thread/read` (cache by
  `updatedAt`). Load turns with `thread/turns/list`; fork with `thread/fork`.
- Keep the raw fallback (§3.2), including `.zst`. Hide guardian and subagent threads.
- Done when: all interactive threads list (115 on the target machine), the
  known fork pair `01a1396e ⟵ 01a13945` draws as one tree, and fork-at-turn
  produces a thread that opens in the Codex extension.

**P2 · Claude for extension users**
- Titles (`ai-title`), the `ide_*` wrapper drop, the `api-request-blob` exclusion,
  and an `entrypoint` badge.
- Cross-file family detection per project dir (evidence rank 3).
- SDK-based list and fork (pending the licence decision); open via the extension command.
- Done when: `311498fc` + `792729c5` and `1ad678f4` + `e612787f` each draw as
  one tree with the divergence at the right turn, and fork-at-turn opens a new
  session in the Claude extension that knows only the prefix.

**P3 · VS Code integration and Windows**
- Open/resume via the extensions' commands and URIs, with per-OS shell fallbacks.
- Fix the `dev:app` script; check `bin/agentree.cjs` and `scripts/install.sh`
  (POSIX-only) or document that they're POSIX-only.
- Done when: every action in the panel works from a Windows VS Code with no
  terminal open.

**P4 · Copilot Chat (read-only)**
- Op-log replay plus legacy `.json`; workspace mapping; dedupe; family
  detection (evidence rank 4).
- Done when: `e611da7e` + `60d59581` draw as one tree, and the 13 sessions that
  share an opening prompt aren't merged into one family.

**P5 · Canary**
- A weekly CI job (pattern: claude-code-history-viewer's
  `.github/workflows/pricing-watch.yml`) that installs the latest `claude` and
  `codex`, runs a 2-turn scripted session plus one fork in each (`claude -p`,
  `codex exec`), and runs the providers over the output. On failure it opens
  or updates one tracking issue.
- Also regenerate the `codex app-server` types and diff them against the
  committed copy.
- It needs API credentials and costs real money per run. That's the owner's call (§8).

---

## 7. Invariants (unchanged from AGENTS.md; don't break them)

- Never modify a harness's transcripts or databases directly. Writes go only
  through official APIs (`forkSession`, `thread/fork`) or Agentree's own
  `~/.agentree/` sidecars.
- The renderer has no Node access. Everything crosses the typed bridge
  (`window.agentree`), and `vscode-ext/src/shim.ts` must keep implementing the
  same surface.
- Selection is styling, never geometry; auto-fit runs once per session; a
  live reload never moves the viewport.
- Summary cache keyed by (mtime, size); one in-flight refresh per kind (`gate()`).
- Markdown renders to React elements, never `innerHTML`.

---

## 8. Decisions for the human owner

1. **Agent SDK licence.** Bundle the proprietary SDK into an MIT extension,
   declare it as a peer dependency the user installs, or reimplement its fork
   format (~100 lines, but it can drift)?
2. **Canary cost.** Is a weekly CI job with real API keys acceptable?
3. **Upstream or fork?** The original repo is
   `serban-cercelescu/Agentree`. Ask whether it's maintained before diverging
   heavily.
4. **Copilot Chat fork-at-turn.** There's no known API; staying read-only is
   the default.

---

## 9. Prior art to borrow from (read, don't vendor without checking licences)

| Project | Use it for |
|---|---|
| [HizTam/codex-history-viewer](https://github.com/hiztam/codex-history-viewer) (VS Code extension, Codex + Claude, single maintainer) | `src/analysis/claudeBranchAnalysisService.ts` (cross-file Claude fork matching), `src/sessions/codexHistoryBase.ts` (`history_base`), `src/sessions/codexRolloutRevisions.ts` (revision files), `src/branchMap/*` (route-tree UI) |
| [jhlee0409/claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) (Tauri, MIT, many contributors) | `src-tauri/src/providers/vscode.rs` (Copilot Chat op-log), `src-tauri/src/commands/session/chain.rs` (Claude `logicalParentUuid` chains across files), `.github/workflows/pricing-watch.yml` (canary pattern) |
| `codex app-server generate-ts` | authoritative Codex protocol types for the installed version |
| `@anthropic-ai/claude-agent-sdk` `sdk.d.ts` | authoritative Claude session API |
| microsoft/vscode (chat contrib) | Copilot Chat serialization and op-log semantics |

Neither viewer detects format changes automatically; both react to bug
reports. That's the gap P0's health row and P5's canary close.
