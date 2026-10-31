<p align="center">
  <img src="assets/logo-256.png" alt="Agentree" width="96" height="96">
</p>

<h1 align="center">Agentree</h1>

<p align="center">See your coding-agent conversations as trees.</p>

<p align="center">
  <img src="assets/screenshot.png" alt="Agentree showing a branched Claude Code session: the conversation tree on the left, the selected turn's details and fork actions on the right" width="900">
</p>

**Agentree** reads the session history your coding agents keep on disk and
draws conversations as interactive trees, across your projects. It runs as a
**VS Code extension** (the primary product) or a standalone Electron desktop app.

Forks made in the agents' chat panels become separate sessions. Agentree uses
shared-history evidence to join each family into one tree, alongside Claude
rewinds and Codex prompt-edit branches. Search fork names, read a path, annotate
useful turns, and hand a session back to its agent. Where supported, fork after
a selected turn to continue a different path.

| Agent | History and branches | Fork support |
|---|---|---|
| **Claude Code**, extension or CLI | JSONL transcripts, rewinds, copied “Fork conversation” sessions | New transcript in the extension's fork format |
| **OpenAI Codex**, extension or CLI | Plain/compressed rollout pages, forks and prompt edits, archived bases | Official `codex app-server` whole-turn fork |
| **GitHub Copilot CLI** | Event logs and copy-truncated forks | Copied session directory; resume command |

VS Code Copilot Chat is not supported. The [guide](docs/user-guide.md) covers
navigation, fork names/tags, settings, health warnings, host differences and
[limitations](docs/user-guide.md#limitations).

## Using it in VS Code

Requirements: **VS Code 1.101+**, plus **Node.js 22.15+** and git to build.
The extension uses VS Code's bundled Node; a newer system Node cannot add
compressed-Codex support to an older VS Code. Windows, macOS and Linux are
supported targets; native hand-off verification varies by platform.

Build the revision you intend to run. These commands package the current checkout:

```sh
git clone https://github.com/Sadeeptha-B/Agentree.git
cd Agentree
npm install
npm run build:vscode
cd vscode-ext
npm run package
code --install-extension agentree-0.2.0.vsix
```

Use the `.vsix` filename produced by packaging if the version changes. Reload
VS Code if prompted, then run **Agentree: Open Conversation Trees** from the
Command Palette (Ctrl/Cmd+Shift+P). Existing histories are discovered from
their default locations; [configuration](docs/user-guide.md#settings-and-data-locations)
covers custom roots.

1. Search a title or fork name; combine the agent chips and project-directory rail.
   Switch **List | Day** to see one day's turns across every chat on a single timeline.
2. Open a family, drag to pan, scroll to zoom, and click dotted chains to expand.
3. Select a turn to read its path. Check the panel's **Session** before Open/Resume:
   those actions continue that session's current path. To continue an older
   branch, use **fork after this turn**, subject to the displayed restrictions.

The [user guide](docs/user-guide.md) explains the complete workflows and
limitations, including shared nodes and quiet forks.

## Desktop app

From the repository root:

```sh
npm install       # prepare also builds the Electron app
npm start
```

Optionally run `npm link` to install the `agentree` launcher for this checkout.
Electron uses the same list, tree and providers. Open-in-chat hands off to
VS Code; Resume opens an OS terminal. Automatic opening of new forks defaults
off on desktop and on in VS Code, and can be changed in settings.

The desktop launch update check is optional. See the guide for
[desktop/update behavior](docs/user-guide.md#desktop-and-updates), the POSIX
installer, and [Electron startup troubleshooting](docs/user-guide.md#6-if-something-looks-off).
There is no packaged desktop installer yet.

## Privacy and data ownership

Agentree itself needs no API keys/accounts and sends no telemetry or
conversation content. Original harness transcripts and databases are never
edited: annotations/settings/lineage live in Agentree's own home; Claude and
Copilot forks create new files/directories; Codex creates its forks through
its own API. Continuing in a vendor agent uses that agent's own runtime and account.

The VS Code extension makes no network requests. The desktop app's optional
launch update check contacts the GitHub repository it was built from. Its
switch and environment override are documented in the
[settings guide](docs/user-guide.md#settings-and-data-locations).

## Working on Agentree

- [AGENTS.md](AGENTS.md): commands, code map, safe fixture homes and required checks.
- [Design notes](docs/design.md): architecture, identities, provider research,
  persistence and the reasons behind consequential decisions.
- [Upstream compatibility](docs/upstream.md): keeping up with the agents' formats, CI and releases.
- [Remaining work](docs/roadmap.md): verification gaps, durability follow-ups and deferred features.
- [Historical record](docs/archive/2026-10-modernize/README.md): retained handoffs,
  reviews/resolutions, completed roadmap and documentation proposal.

`CLAUDE.md` imports `AGENTS.md`; both hosts share the same implementation.

## Credits

Agentree was created by [Serban Cercelescu](https://github.com/serban-cercelescu/Agentree).
This fork modernizes it for Claude Code and Codex extension histories.
MIT licensed; see [LICENSE](LICENSE).
