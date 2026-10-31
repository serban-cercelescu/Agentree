# Working on Agentree

Agentree is a local viewer for branched coding-agent conversations. The primary product is the VS Code extension; Electron uses the same renderer and providers.

Read the [design notes](docs/design.md) before changing parsing, stitching, identity, fork logic or persistence. They retain the provider research and evidence previously kept in this file. The [user guide](docs/user-guide.md) owns workflows, settings and user-facing limitations; [README](README.md) owns installation and quick start.

## Boundaries to preserve

- Never modify original harness transcripts or databases. Writes go to new fork files/directories in the harness's format, the official Codex `thread/fork` API, or Agentree sidecars. Never test forks or resume probes against original stores.
- Read Codex's tree from raw rollout pages, including archived bases and prompt-edit branches. Use app-server for forks only. Claude forks reproduce the extension's format; the Agent SDK is deliberately not bundled. These are owner-confirmed decisions; do not reopen them without the owner's direction.
- All store work runs in the backend worker. Hosts handle IPC, watches, terminals and native hand-offs. Add store-touching methods to `electron/backend.ts` (and its name to `METHOD_NAMES` in `backend-client.ts`; typecheck enforces it); do not import providers into the host or Electron below `main.ts`/`preload.ts`. Hosts never resolve store roots: a launch (argv plus the harness's store variable) comes from the worker (`resumeLaunch`), so forks, terminal resume and copied commands use the store Agentree reads.
- Keep the renderer without Node access and preserve the typed `window.agentree` bridge shared by both hosts.
- Keep semantic message identity, physical occurrence, membership (`heldBy`), vendor turn, display grouping and edge kind distinct. The last part determines a merged node's fork anchor and refusal; grouping must not widen/narrow a cut, and must not fold across a member's endpoint (parts of one node have the same holders). A node id is a group's head, not its end: fork requests carry the drawn endpoint (`ForkPoint`), resolved by `resolveForkPoint` or refused, and a reload carries the selection by it. A node's start (`timestamp`) is not its end (`endedAt`): rank "latest" by `endOf`.
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
| Watches and hand-offs | `electron/{watch,shell,launch,native,terminal,update}.ts` |
| Verification | `test/`, `src/*.test.ts`, `test/fixtures/make-fixtures.mjs` |

The design notes explain [host boundaries](docs/design.md#architecture), [identity](docs/design.md#one-node-several-identities) and its [persisted scheme](docs/design.md#identity-scheme-and-compatibility), [Claude](docs/design.md#claude-code), [Codex forks](docs/design.md#codex-fork), [list/activity rules](docs/design.md#welcome-screen) and [persistence](docs/design.md#annotations).

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
```

For extension development, F5 from the root runs the configured build task and launches an Extension Development Host. Rebuild/reload after changes. Package with `npm run package` inside `vscode-ext/`; VS Code installs the resulting `.vsix`. Regenerate icons with `scripts/make-icon.py` when changing the source logo.

For implementation changes, run relevant tests and typecheck; verify both production builds when shared code, runtime boundaries, entry points or bundling change. For documentation-only work, check moved links/anchors and commands against package scripts. A prose edit does not require an unrelated full test/build run.

When a harness changes format, add a sanitized synthetic fixture before changing the parser. Assert exact ancestry, member endpoints and action targets as well as unique IDs/no dangling parents. Counts and structural validity alone do not prove semantic correctness. Fixture coverage and vendor canaries are described in the [design notes](docs/design.md#tests).

Use disposable homes for writes: set `AGENTREE_HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `COPILOT_HOME` before importing providers; copy any needed transcript inputs into them. Even loading a family can write lazy annotation migrations. A read-only real-store audit needs a scratch Agentree home, and copied real rollouts are required for native Codex fork canaries because synthetic parser fixtures are not complete vendor rollouts. Do not invoke live model generation for ordinary tests. Keep private transcript text and account paths out of committed fixtures and reports.

Report what was actually checked: fixture tests, shipped-source inspection, visual UI checks and executed native resume behavior separately. Preserve verified/source/unverified labels and associated versions when editing provider research.

## Documentation maintenance

Each subject has one authoritative explanation: README for setup, this file for working instructions, the user guide for tasks/configuration, and design notes for engineering reasoning. Update the relevant explanation when a behavior or contract changes; routine code movement need not trigger a prose rewrite. Split documents only when navigation or independent maintenance demonstrates a need.

Keep history in the [dated archive](docs/archive/2026-10-modernize/README.md), with original evidence, decisions and resolution status. Archived plans do not override current instructions. A review's report keeps its original findings; its resolution is recorded at the top, as for rounds 1–4.
