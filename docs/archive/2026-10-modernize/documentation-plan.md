# Documentation approach after modernization

> **Implemented as a documentation structure, 2026-10-27.** The four current documents are linked from the [repository README](../../../README.md). This proposal is retained as the rationale for consolidation. The owner subsequently authorized grouping historical documents in this folder. The [round 3 findings](review-findings-round-3.md) were resolved separately; see its resolution.

Proposal based on `58cf671..b400dbd`, 2026-10-27. This is an information-architecture and maintenance proposal; existing files have not been moved or rewritten by this review.

Agentree needs four current documents, each with a clear audience and ownership of its subject. The goal is to reduce the number of places a change must touch. The research in `AGENTS.md` is valuable and should be preserved, while its working instructions become easier to find.

The earlier version of this proposal split configuration, architecture, the tree model, persistence, providers and decisions into separate references. That would introduce too many synchronization points for the current project. Keep those technical subjects together initially. Split them only when maintaining or navigating them becomes a demonstrated problem.

## Four current documents

`docs/design.md` is proposed; the other three files already exist.

| Document | Reader and purpose | Owns these facts |
|---|---|---|
| `README.md` | New user deciding whether and how to use Agentree | Purpose, supported products, installation, quick start, concise privacy statement and important limitations; links to the guide and design notes |
| `AGENTS.md` | Agent or developer starting work | Short working instructions: repository commands, code map, ownership boundaries, required checks and temporary-fixture-home rules; links to relevant design sections |
| `docs/user-guide.md` | User performing a task | Find and read families/forks, annotate, open/resume/fork, configure settings and environment overrides, understand host differences and troubleshoot health warnings |
| `docs/design.md` | Contributor understanding or changing behavior | Architecture, identity and membership contracts, grouping/fork rules, provider peculiarities, persistence/migrations, consequential decisions and their evidence |

Use sections and a contents list within `docs/design.md`. A long, coherent document is acceptable. Preserve useful provider research there without expanding it into an inventory of every record type, function or test.

The existing `CLAUDE.md` stays a simple `@AGENTS.md` import. The extension README remains a short marketplace entry with the necessary extension-specific quick start and links to the canonical guide. These entry points should require little independent maintenance.

Keep `docs/roadmap.md` as a small list of open/deferred work. Handoffs, reviews and completed plans are historical evidence, with dated status/resolution banners and commit ranges. They do not belong in the mandatory reading sequence for current architecture. They can remain at their existing paths initially; moving them into an archive is optional housekeeping, with old links preserved if they move.

## Keep one authoritative explanation

Each subject has one authoritative home. Other documents may summarize it briefly and link to the explanation. A typical behavior change should require updating one owned explanation and the relevant test, rather than a checklist of documents.

- **User behavior and configuration:** the guide owns workflows and the settings/environment table, including defaults, precedence and when changes take effect. README owns the quick start. Do not repeat the full settings manual in README or `AGENTS.md`.
- **Engineering reasoning:** design notes own the explanation of architecture, model invariants, provider behavior and saved-data compatibility. Source comments explain local constraints; tests establish executable behavior. Link to them instead of maintaining a parallel API or test catalog.
- **Working instructions:** `AGENTS.md` keeps the commands and hard boundaries needed to work safely, including the prohibition on modifying original harness stores. Detailed rationale belongs in the design notes.
- **Limitations:** the guide owns the user-facing consequence; design notes explain the technical reason when needed. README carries only the important summary and a link.
- **History:** old reviews and handoffs retain their original conclusions, with resolution links. They do not receive routine updates as implementation changes.

## Spend detail where correctness depends on it

The identity and membership contract deserves careful explanation in `docs/design.md`: ambiguity here directly affects what history is shown and which session an action targets. Settle these questions alongside the current review fixes:

1. What proves two nodes are the same message? Explain meaningful whitespace, strong/text-only evidence, bounded parent qualification and compatibility with saved annotation keys.
2. What proves a member holds a whole display group? Distinguish an occurrence of one part from complete membership and preserve exact endpoints during compression.
3. Which session do Open, Resume and Fork target on shared history? Separate canonical display ownership, the user's focused member and a valid provider fork holder.
4. How are multiple physical copies of one session combined? Explain conversation deduplication and metadata ordering, including UUID-less records and conflicts.
5. What survives membership changes or root removal? Cover selection, focused member, annotations and cleared fields, including any limits on recovery.

Use a small example or a link to an invariant test where it makes a rule clearer. Describe implemented guarantees accurately; label unresolved designs as proposals. Changing stable-key normalization or construction is a persisted-data change even when its TypeScript type remains `string[]`.

Keep the reasons for consequential choices nearby: raw Codex graph reads, official Codex writes, Claude's fork format/no SDK, and worker placement. Short explanations with consequences and evidence are sufficient; separate ADR files are unnecessary at this stage.

Retain the useful verified/source/tested/unverified distinctions in the existing provider research. When a format claim depends on a vendor version, keep its version/date and evidence next to that claim. Refresh affected claims when investigating a format change. There is no need for a separately maintained compatibility matrix or a mandatory evidence record for every change.

Keep committed examples sanitized. Preserve the distinction between a fixture passing, vendor code being inspected and a native workflow actually being executed; it prevents unsupported confidence without adding a new documentation process.

## Incremental migration

1. Extract the engineering research and rationale from `AGENTS.md` into `docs/design.md`, preserving evidence labels and useful links. Leave short working instructions and links in `AGENTS.md`; keep `CLAUDE.md` importing it.
2. Consolidate settings and user workflows in the existing guide. Trim overlapping explanations in README and the extension README, keeping their quick starts usable. Link the four documents directly; a separate documentation landing page is unnecessary.
3. Mark historical material clearly and remove it from the current reading path. Preserve links, and keep the roadmap focused on remaining work. Archive moves can wait until they make navigation easier.

Move existing material before rewriting it. Improve unclear sections as the related code changes; a comprehensive prose rewrite is unnecessary. Do not create empty reference documents in anticipation of future growth.

## Maintenance and acceptance

Update documentation when a user-visible behavior, important contract or consequential decision changes. Routine refactoring should not require a documentation edit merely because implementation details moved. Keep executable detail in types, validation and tests, and reasoning in the design notes.

Check links when moving material and commands when editing setup instructions. No new documentation framework, generator or CI gate is required for this migration. Add tooling if recurring drift justifies its cost.

As Agentree grows, split a section only when it has a distinct audience and is frequently maintained independently, or when navigation has become difficult despite clear sections. File length and application growth alone do not require more documents. Add a new document only when its boundary reduces maintenance or makes information materially easier to find.

The migration is done when a new user can launch the primary VS Code product from README, a contributor can find the identity/fork contract without reading review history, settings have one current explanation, and a typical change has an obvious documentation home. Preserve existing research and old links while reducing the number of places that need updating.
