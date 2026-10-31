# CI, releases and the upstream watch — October 2026

These records keep the handover of the work that added CI, the release pull request flow, the weekly upstream watch and the upstream-compatibility research (branch `ci`, PR #3). [Upstream compatibility](../../upstream.md) explains the current process; [AGENTS.md](../../../AGENTS.md) has the working rules.

The branch was squashed before merging (2026-10-31), so the commit ids these records cite are no longer in its history. Read them as the state of the branch at that point.

| Record | Scope and status |
|---|---|
| [Handover](handoff.md) | State on 2026-10-29: what exists, owner decisions, the rules the workflows and scripts keep, what was and wasn't verified, known issues (macOS CI, issues turned off, Copilot drift) and the next steps. Start here when continuing this track |
| [First review](review-findings-ci.md) | The `ci` branch at `0700bd3`: one P1 (macOS CI), six P2 (release concurrency, failed lookups reading as green, the Codex contract accepting incompatible requests, the packager outside the lockfile, the Codex install path's scripts, untracked fixtures) and one P3 (`release:prepare` stranded on its branch), plus two process suggestions. Resolved 2026-10-30, with what was deliberately left out |
| [Second review](review-findings-ci-round-2.md) | `67932d1`: four watch findings (a failed SDK lookup bypassing "incomplete", the fork response's blind spots, explicitly open schemas, Marketplace prereleases reported as stable) and a stale note on the `main` ruleset. Resolved 2026-10-30; the prerelease finding also corrected a wrong `reviewed` version in the baseline |
| [Third review](review-findings-ci-round-3.md) | Three short passes: what a fork's response guarantees rather than what it can carry, one value not standing for a type, and the fixture check accepting a changed compressed transcript, which became a test. Resolved 2026-10-31. Strict status checks were recommended against, then adopted by the owner |
