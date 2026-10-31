# Modernization history — October 2026

These records preserve the original brief, decisions, experiments, review findings and resolution writeups. Their implementation descriptions and source line numbers refer to the revisions they discuss. Older references to `AGENTS.md` as the engineering manual refer to material now consolidated in [design.md](../../design.md). The [working instructions](../../../AGENTS.md), [user guide](../../user-guide.md) and [current roadmap](../../roadmap.md) own current guidance.

**Round 3 is resolved:** all eight findings were fixed on 2026-10-27, with the [resolution](review-findings-round-3.md#resolution) recorded at the top of its report.

**Round 4 is resolved:** its seven findings — five correctness/integration findings, one inherited live-discovery limitation and stale extension documentation — were fixed on 2026-10-28, with the [resolution](review-findings-round-4.md#resolution) recorded at the top of its report.

**Round 5 is resolved:** its six findings — an observed Codex format failure, a missing terminal-resume proxy method, fork endpoints changing across live regrouping, a member choice lost to an in-flight reload, unreported annotation write failures and Windows percent expansion — were fixed on 2026-10-28, with the [resolution](review-findings-round-5.md#resolution) recorded at the top of its report.

**Round 6 merge assessment:** the [full review of `58cf671..732b90e`](review-findings-round-6.md) found no new merge blocker and recommends merging within the documented local-viewer scope, with one non-blocking test-isolation note and finite distribution smoke checks.

| Record | Scope and status |
|---|---|
| [Modernization brief](modernization-handoff.md) | Started from `58cf671`; retain its assumptions, vendor-format research (including prospective Copilot Chat), and implementation correction banner |
| [Review handoff](review-handoff.md) | Explains the first modernization implementation and desktop parity, owner decisions, evidence strength, probes and review questions |
| [First review](review-findings.md) | `58cf671..91185af`; resolution recorded at the top, with partial fixes revisited in round 2 |
| [Round 2 review](review-findings-round-2.md) | `58cf671..0bb38ae`; eight findings and their resolution, identity-model correction and roadmap cautions |
| [Completed roadmap](roadmap-completed.md) | Original A/B/C brief, departures and owner answers through `b400dbd`; A1–A4, B1–B4 and C1 implemented, B5 deferred. Later review findings still apply |
| [Round 3 review](review-findings-round-3.md) | Full `58cf671..b400dbd` diff; eight findings, reproductions, architecture assessment and verification limits; resolution recorded at the top |
| [Round 4 review](review-findings-round-4.md) | Full `58cf671..fc0ccc2` diff; annotation compatibility, configured launch roots, tip/family selection, settings feedback, missing-root watches and stale extension docs; resolution recorded at the top |
| [Round 5 review](review-findings-round-5.md) | Full `58cf671..1b4e0e5` diff; six findings with reproductions, real-rollout copy check, architecture assessment and verification limits; resolution recorded at the top |
| [Round 6 review / merge assessment](review-findings-round-6.md) | Full `58cf671..732b90e` diff; no new merge blocker, proportionality assessment, current verification and distribution follow-ups |
| [Documentation proposal](documentation-plan.md) | Four-document consolidation and maintenance rationale; implemented as documentation, with archive grouping subsequently authorized by the owner |

Banners and repaired relative links distinguish historical context from current guidance; the underlying findings, evidence and original resolution claims are retained. To inspect the engineering notes exactly as they were before consolidation, use `git show b400dbd:AGENTS.md`.
