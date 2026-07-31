<p align="center">
  <img src="https://raw.githubusercontent.com/serban-cercelescu/Agentree/main/assets/logo-256.png" alt="Agentree" width="96" height="96">
</p>

<h1 align="center">Agentree</h1>

<p align="center">
  See your coding-agent conversations as trees. Fork them anywhere.
</p>

---

<p align="center">
  <img src="https://raw.githubusercontent.com/serban-cercelescu/Agentree/main/assets/screenshot.png" alt="Agentree showing a branched Claude Code session: the conversation tree on the left, the selected turn's details and fork command on the right" width="900">
</p>

**Agentree** reads the session files your coding agents already keep on disk
and draws each conversation as an interactive tree — every prompt, reply, and
branch, across all your projects, in one place. Run **Agentree: Open
Conversation Trees** from the command palette and it finds your sessions
automatically; harnesses that aren't installed are simply skipped.

Select any turn and Agentree hands you a ready-to-paste command that resumes
the conversation **from that exact point**, as a new branch. Explore an idea,
rewind, try another path — without losing anything.

Supported harnesses:

| Agent | Session store | Resume / fork |
|-------|---------------|----------------|
| **Claude Code** | `~/.claude/projects` | branches natively inside one session |
| **OpenAI Codex CLI** | `~/.codex/sessions` | fork becomes a new session, drawn as one tree |
| **GitHub Copilot CLI** | `~/.copilot/session-state` | fork becomes a new session, drawn as one tree |

## Features

- **One list, three harnesses** — every conversation on your machine, newest
  first, filterable by project directory, with live updates as agents run.
- **Tree view** — branches are first-class: long linear runs collapse into
  compact chains, branch points stay visible, and the current tip is
  highlighted.
- **Fork after any turn** — one click produces the exact CLI command that
  continues the conversation from that turn as a new branch. Nothing is
  modified or deleted; forks are strictly additive.
- **Read the conversation** — full Markdown rendering of any turn, its
  thinking and tool calls, plus a "view conversation up to here" reader for
  the whole prefix.
- **Annotate** — star turns, label branches, and mark dead ends (dimming the
  whole abandoned subtree). Annotations live in a sidecar, never in your
  transcripts.
- **Token overlays** — per-turn context size, prompt cost, and cache-hit
  rates, straight from the transcripts.

## Privacy

Agentree runs entirely on your machine. No API keys, no accounts, no
telemetry, no network requests. Your transcripts are never modified:
annotations go to `~/.agentree/`, and forking (for harnesses that need it)
only ever *creates* a new session file.

## Also available as a desktop app

The same app ships as a standalone Electron build — see the
[Agentree repository](https://github.com/serban-cercelescu/Agentree) for
installation. This extension is built from the same sources: from the repo
root, `npm run build:vscode`, then `npm run package` in `vscode-ext/`.
