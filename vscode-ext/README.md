<p align="center">
  <img src="https://raw.githubusercontent.com/Sadeeptha-B/Agentree/main/assets/logo-256.png" alt="Agentree" width="96" height="96">
</p>

<h1 align="center">Agentree</h1>

<p align="center">
  See your coding-agent conversations as trees.
</p>

---

**Agentree** reads the session files your coding agents already keep on disk
and draws each conversation as an interactive tree: every prompt, reply and
branch, across all your projects. Run **Agentree: Open Conversation Trees**
from the Command Palette.

Forked sessions are joined by shared-history evidence into a family tree.
Claude rewinds and Codex prompt edits also appear as branches. Search fork
names, inspect a path, annotate turns and hand a session back to its agent.

Requires VS Code 1.101 or newer (for the zstd support Codex's compressed
history needs).

| Agent | History | Fork after a turn |
|-------|-------|-------------------|
| **Claude Code** (extension or CLI) | JSONL conversations and copied forks | new session in Claude Code's fork format |
| **OpenAI Codex** (extension or CLI) | Plain/compressed rollout pages, forks and prompt edits | official `thread/fork`, whole turns only |
| **GitHub Copilot CLI** | Session event logs | copy-truncated session; resume command |

VS Code Copilot Chat is not supported. See the
[guide's limitations](https://github.com/Sadeeptha-B/Agentree/blob/main/docs/user-guide.md#limitations).

## Use

Install a built `.vsix` with **Extensions: Install from VSIX**, reload if
prompted, then run **Agentree: Open Conversation Trees** from the Command Palette.

- **Welcome screen:** agent/directory filters, fork-name search, activity sort
  and health rows. The gear opens settings shared with the desktop app; a
  history location set there is also used for forks and terminal resume.
- **Tree:** drag to pan, wheel to zoom, click a dotted `n` chain to expand it.
  Long-dashed edges enter a fork or an edited branch.
- **Panel:** for the session shown in its Session block you get **open in
  Claude Code / Codex** and **resume in terminal** (both continue the
  session's current path), **⑂ fork after this turn** (opens the fork in the
  chat panel; the way to continue any other branch), and star / label /
  dead-end annotations. A turn that can't be forked says why.

Shared history belongs to every session that copied it. Open a fork by its
name in the list and the panel acts on that fork across all of its history,
shared turns included; on a shared turn, a drop-down picks which session to
act on. Resume in terminal uses the history location set in Agentree's
settings; the chat panel uses its own extension's. Native opening after a
fork is configurable. The
[user guide](https://github.com/Sadeeptha-B/Agentree/blob/main/docs/user-guide.md)
owns workflows, settings, paths and troubleshooting.

## Privacy

Everything runs locally, with no network requests. Your transcripts are never
modified: annotations go to `~/.agentree/`, a Claude fork creates a new file,
Codex makes Codex forks itself, and Copilot forks copy a new session directory.
Agentree sends no telemetry and needs no API keys of its own; the vendor agent
you resume uses its own runtime/account.

## Build

The [repository README](https://github.com/Sadeeptha-B/Agentree#using-it-in-vs-code)
owns source installation. [AGENTS.md](https://github.com/Sadeeptha-B/Agentree/blob/main/AGENTS.md)
has build/package and development-host instructions; the
[design notes](https://github.com/Sadeeptha-B/Agentree/blob/main/docs/design.md)
explain the shared renderer/providers and runtime requirements.
