# Working on Agentree

Agentree is a local viewer for branched coding-agent conversations. The primary product is the VS Code extension; Electron uses the same renderer and providers.

Read the [design notes](docs/design.md) before changing parsing, stitching, identity, fork logic or persistence. They retain the provider research and evidence previously kept in this file. The [user guide](docs/user-guide.md) owns workflows, settings and user-facing limitations; [README](README.md) owns installation and quick start.

## Boundaries to preserve

- Never modify original harness transcripts or databases. Writes go to new fork files/directories in the harness's format, the official Codex `thread/fork` API, or Agentree sidecars. Never test forks or resume probes against original stores.
- Read Codex's tree from raw rollout pages, including archived bases and prompt-edit branches. Use app-server for forks only. Claude forks reproduce the extension's format; the Agent SDK is deliberately not bundled. These are owner-confirmed decisions; do not reopen them without the owner's direction.
- All store work runs in the backend worker. Hosts handle IPC, watches, terminals and native hand-offs. Add store-touching methods to `electron/backend.ts` (and its name to `METHOD_NAMES` in `backend-client.ts`; typecheck enforces it); do not import providers into the host or Electron below `main.ts`/`preload.ts`. Hosts never resolve store roots: a launch (argv plus the harness's store variable) comes from the worker (`resumeLaunch`), so forks, terminal resume and copied commands use the store Agentree reads.
- Keep the renderer without Node access and preserve the typed `window.agentree` bridge shared by both hosts.
- Keep semantic message identity, physical occurrence, membership (`heldBy`), vendor turn, display grouping and edge kind distinct. The last part determines a merged node's fork anchor and refusal; grouping must not widen/narrow a cut, and must not fold across a member's endpoint (parts of one node have the same holders). A node id is a group's head, not its end: fork requests carry the drawn endpoint (`ForkPoint`), resolved by `resolveForkPoint` or refused, and a reload carries the selection by it. A node's start (`timestamp`) is not its end (`endedAt`): rank "latest" by `endOf`. Activity recorded under it later (`activeUntil`, per physical copy on `occurrences`) measures only the day view's idle time (`activeEndOf`).
- Adopt an async result only for the intent it was asked about: the tree's `view`, the day's pending target and selected key. When the intent changed meanwhile, ask again from the newer one; never keep a selection by its key across a snapshot it wasn't resolved in.
- Membership is what a session holds, not who draws it: Open/Resume act on the focused member wherever it holds the selected node (`actionTarget`), else on the canonical owner. Don't derive action targets from `sourceSessionId` alone. A family can split: reload asks for the focused member first, never assuming the old root still holds it.
- Do not choose a moved session's copy by size/recency alone: diverged continuations must survive. UUID containment deduplicates conversation records only; UUID-less metadata is reduced across every copy separately.
- Stable IDs are persisted annotation keys (`electron/identity.ts`, scheme 4). Text identity is exact (whitespace included) and weak keys are bounded hashes. A new scheme must give current keys a form no earlier scheme saved with another meaning, and still find every earlier scheme's keys (`legacyIds`). Older keys are used, on read and write, only when one node of the family owns them (`ownership` in `meta.ts`).
- Settings change what is visible or where data lives, never transcript interpretation. Environment overrides win over settings. Every store call, watch discovery included, goes through an enabled `Provider`; a disabled one is never invoked.
- Preserve Windows launch/quoting behavior: PowerShell 5.1, `.cmd` shims, and clearing `ELECTRON_RUN_AS_NODE`. Do not replace the Electron launcher with a bare `electron .` command.

## Code map

| Area | Entry points |
|---|---|
| Hosts and bridge | `electron/main.ts`, `electron/preload.ts`, `vscode-ext/src/{extension,shim}.ts` |
| Worker and providers | `electron/{backend,backend-client,worker,registry}.ts`, `electron/transcripts.ts`, `electron/providers/` |
| Identity | `electron/identity.ts` (persisted semantic keys), `electron/providers/stitch.ts` |
| Settings and sidecars | `electron/{settings,paths,meta,lineage}.ts` |
| Shared model and renderer | `shared/{types,render}.ts`, `src/{store,list,tree-layout}.ts`, `src/components/` |
| Day view | `registry.dayActivity` and `findWant` (worker: the projection, and a selection found again in its family), `src/{day,day-layout}.ts`, `src/components/DayView.tsx` |
| Watches and hand-offs | `electron/{watch,shell,launch,native,terminal,update}.ts` |
| Verification | `test/`, `src/*.test.ts`, `test/fixtures/make-fixtures.mjs` |

The design notes explain [host boundaries](docs/design.md#architecture), [identity](docs/design.md#one-node-several-identities) and its [persisted scheme](docs/design.md#identity-scheme-and-compatibility), [Claude](docs/design.md#claude-code), [Codex forks](docs/design.md#codex-fork), [list/activity rules](docs/design.md#welcome-screen), the [day view](docs/design.md#day-view) and [persistence](docs/design.md#annotations).

## Commands and verification

Use Node 22.15+ for local compressed-Codex fixtures. VS Code 1.101+ is a separate runtime requirement: the extension uses VS Code's bundled Node. Install/launch steps are in [README](README.md#using-it-in-vs-code).

```sh
npm test                 # synthetic fixture and renderer/host tests
npm run typecheck        # renderer, Node code and VS Code extension
npm run build            # Electron renderer, host, preload and worker
npm run build:vscode     # extension, shared webview and worker
npm run fixtures         # regenerate committed fixtures after editing the generator
npm run dev              # Electron hot reload
npm run test:watch       # focused test iteration
node scripts/check-links.mjs          # relative Markdown links and anchors (CI)
node scripts/check-version.mjs        # one version in every place that states it (CI, release)
npm run release:prepare -- X.Y.Z      # open a release pull request (docs/upstream.md)
node scripts/upstream/watch.mjs       # vendor releases since review, and their contracts
```

For extension development, F5 from the root runs the configured build task and launches an Extension Development Host. Rebuild/reload after changes. Package with `npm run package` inside `vscode-ext/`; VS Code installs the resulting `.vsix`. Regenerate icons with `scripts/make-icon.py` when changing the source logo.

To see a renderer change in the running desktop app (screenshots, clicks, keys), use the [run-desktop skill](.claude/skills/run-desktop/SKILL.md): `npm run build`, then pipe commands to its driver. It runs on a temp copy of the fixtures by default; its `real` mode reads your stores with a scratch Agentree home and `AGENTREE_READ_ONLY_STORES=1`, under which the app refuses every fork, chat-panel open and terminal resume. Set that variable for any automated run against real stores. A desktop screenshot is not a VS Code webview check.

For implementation changes, run relevant tests and typecheck; verify both production builds when shared code, runtime boundaries, entry points or bundling change. For documentation-only work, check moved links/anchors and commands against package scripts. A prose edit does not require an unrelated full test/build run.

CI (`.github/workflows/`) runs the checks above on Ubuntu and Windows on Node 22.15.0 (VS Code 1.101's bundled Node, the floor) and 24, and on macOS on 24; a release is a pull request from `npm run release:prepare`, whose merge makes a draft GitHub release only; publishing it creates the tag, which only admins can. The Release workflow run by hand is a dry run. A weekly upstream watch reports vendor releases and contract breaks in one `upstream` issue, and fails on a break or on anything it could not determine. [Upstream compatibility](docs/upstream.md) owns that process, the triage of an upstream change, and the read-only audit of real stores to run around parser changes. Don't publish to the Marketplace or Open VSX without the owner.

When a harness changes format, add a sanitized synthetic fixture before changing the parser. Assert exact ancestry, member endpoints and action targets as well as unique IDs/no dangling parents. Counts and structural validity alone do not prove semantic correctness. Fixture coverage and vendor canaries are described in the [design notes](docs/design.md#tests).

Use disposable homes for writes: set `AGENTREE_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` before importing providers; copy any needed transcript inputs into them. Even loading a family can write lazy annotation migrations. A read-only real-store audit needs a scratch Agentree home, and copied real rollouts are required for native Codex fork canaries because synthetic parser fixtures are not complete vendor rollouts. Do not invoke live model generation for ordinary tests. Keep private transcript text and account paths out of committed fixtures and reports.

Report what was actually checked: fixture tests, shipped-source inspection, visual UI checks and executed native resume behavior separately. Preserve verified/source/unverified labels and associated versions when editing provider research.

## Documentation maintenance

Each subject has one authoritative explanation: README for setup, this file for working instructions, the user guide for tasks/configuration, design notes for engineering reasoning, and [upstream compatibility](docs/upstream.md) for tracking vendor changes, CI and releases. Update the relevant explanation when a behavior or contract changes; routine code movement need not trigger a prose rewrite. Split documents only when navigation or independent maintenance demonstrates a need.

Keep history in the archives under `docs/archive/`, one per effort (the [October 2026 modernization](docs/archive/2026-10-modernize/README.md), the [day view](docs/archive/day-view/README.md), [CI and releases](docs/archive/ci/README.md)), with original evidence, decisions and resolution status. Archived plans do not override current instructions. A review's report keeps its original findings; its resolution is recorded at the top, as for rounds 1–4.
