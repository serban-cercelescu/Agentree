import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FORK_POINT_GONE, resolveForkPoint } from "../../shared/render.ts";
import type { ForkPoint, ForkResult, SessionId, TurnNode } from "../../shared/types.ts";
import { recordLineage } from "../lineage.ts";
import { resumeCommandFor } from "../launch.ts";
import {
  INJECTED_PREFIX,
  loadSession,
  locate,
  readSourceRecords,
  resolveLineage,
  uuidsOf,
  type RawRecord,
} from "../transcripts.ts";

/**
 * Fork a Claude Code session after a chosen turn, as a NEW transcript.
 *
 * The format is the one the Claude Code VS Code extension writes for its own
 * "Fork conversation" (read from its `forkSession`, extension 2.1.310), so the
 * extension and the CLI resume the result like any fork they made themselves:
 *
 *  - the records on the chain ending at the anchor, in order, minus
 *    `progress` records. The chain follows `logicalParentUuid` across a
 *    `/compact` boundary, as the extension's `getTranscript(…, true)` does, so
 *    a fork of a compacted session carries its whole history;
 *  - every record gets a fresh uuid; parentUuid points at the previous copied
 *    record — except where the source's was null (a compact boundary), which
 *    stays null, so the CLI still resumes from the compaction summary. Its
 *    `logicalParentUuid` points at the copy of the pre-compact tip (the
 *    extension leaves it pointing into the source; the parser copes with
 *    both, by `resolveLineage`, the rule this walk shares);
 *  - a queued_command attachment's `source_uuid` is remapped onto the copy,
 *    and a `model_refusal_fallback` record is marked `neutralizedByFork`;
 *  - `sessionId` is the new id; timestamps are kept, except the last
 *    record's, which becomes "now";
 *  - the source's `summary` for the anchor, if it has one, re-pointed at the
 *    copy's leaf;
 *  - a trailing `custom-title` "<title> (fork)".
 *
 * Plus one field the extension doesn't write but the Agent SDK's
 * `forkSession` does: `forkedFrom: {sessionId, messageUuid}` on every copied
 * record — explicit lineage, so the family stitches without inference. The
 * lineage sidecar gets the same link, belt and braces.
 *
 * Non-destructive: the parent transcript is never touched, and the new file
 * is created with `wx` so nothing can be overwritten. File-history snapshots
 * (the extension's code-rewind state) are deliberately not copied: they are
 * rebuilt from deltas Agentree doesn't model, and a stale snapshot would make
 * "rewind code" in the fork restore the wrong files.
 *
 * Why not the earlier designs — an appended `last-prompt` pin plus
 * `--resume-session-at`: it wrote into the user's real transcript, relied on
 * undocumented reducer behaviour, needed a POSIX shell, and couldn't be
 * driven from the VS Code chat panel at all.
 */
export function forkClaudeAt(familyId: SessionId, point: ForkPoint): ForkResult {
  const family = loadSession(familyId);
  // The node that still ends where the user's selection did when drawn.
  const node = family && resolveForkPoint(family.nodes, point);
  if (!family || !node) return { ok: false, error: FORK_POINT_GONE };

  // The provider decided at parse time which turns can anchor a fork; the
  // panel showed the same reason.
  if (node.forkBlocked) return { ok: false, error: node.forkBlocked };
  if ((node.lastRawId ?? node.id).startsWith(INJECTED_PREFIX)) {
    return { ok: false, error: "This turn has no transcript record to fork at." };
  }

  const sourceId = node.sourceSessionId ?? familyId;
  const loc = locate(sourceId);
  if (!loc) return { ok: false, error: "That turn's transcript is no longer on disk." };
  const anchor = node.lastRawId ?? node.id;

  // Every copy of the session, as the parser read it: a session that lives in
  // two project folders forks from whichever copy holds the turn.
  const records = readSourceRecords(loc.source);
  if (!records) return { ok: false, error: "Could not read the transcript." };

  // Later records with the same uuid win (the CLI rewrites a few in place).
  const byUuid = new Map<string, RawRecord>();
  for (const r of records) if (r.uuid) byUuid.set(r.uuid, r);
  if (!byUuid.has(anchor)) return { ok: false, error: "The fork point's record is missing from the transcript." };

  // The logical chain — the extension's getTranscript(anchor, true) — by the
  // SAME ancestry rule the parser draws with: across a compact boundary
  // through logicalParentUuid, and when that reference is stale (this file is
  // itself a fork) through the record written before the boundary. Walking
  // raw fields instead stopped at a stale reference and dropped the whole
  // pre-compact history from a fork of a fork.
  const lineage = resolveLineage(records);
  const chain: RawRecord[] = [];
  const seen = new Set<string>();
  for (let cur = byUuid.get(anchor); cur && !seen.has(cur.uuid!); ) {
    seen.add(cur.uuid!);
    chain.push(cur);
    const up = lineage.get(cur.uuid!);
    cur = up ? byUuid.get(up) : undefined;
  }
  chain.reverse();
  const copied = chain.filter((r) => r.type !== "progress");
  if (!copied.some((r) => r.type === "user" || r.type === "assistant")) {
    return { ok: false, error: "There is nothing to fork before this turn." };
  }

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();
  const forkedFrom = { sessionId: sourceId, messageUuid: anchor };
  const fresh = new Map(copied.map((r) => [r.uuid!, crypto.randomUUID()]));
  let prev: string | null = null;
  const lines: string[] = [];
  copied.forEach((r, i) => {
    const uuid = fresh.get(r.uuid!)!;
    const att = r.attachment as (RawRecord["attachment"] & { source_uuid?: string }) | undefined;
    const out: Record<string, unknown> = {
      ...r,
      ...(r.type === "system" && r.subtype === "model_refusal_fallback" ? { neutralizedByFork: true } : {}),
      ...(att?.type === "queued_command" && att.source_uuid && fresh.has(att.source_uuid)
        ? { attachment: { ...att, source_uuid: fresh.get(att.source_uuid) } }
        : {}),
      uuid,
      parentUuid: r.parentUuid ? prev : null,
      // The boundary keeps its null parentUuid (so the CLI still resumes from
      // the summary), and its logical link points at the COPY of the
      // pre-compact tip. The extension leaves it pointing into the source
      // file; repointing it keeps the copy self-contained for the next fork.
      ...(r.logicalParentUuid && !r.parentUuid ? { logicalParentUuid: prev } : {}),
      sessionId: newId,
      timestamp: i === copied.length - 1 ? now : r.timestamp,
      forkedFrom,
    };
    delete out.sessionKind;
    lines.push(JSON.stringify(out));
    prev = uuid;
  });
  const summary = [...records].reverse().find(
    (r) => r.type === "summary" && (r as { leafUuid?: string }).leafUuid === copied[copied.length - 1].uuid,
  ) as { summary?: string } | undefined;
  if (summary?.summary) lines.push(JSON.stringify({ type: "summary", leafUuid: prev, summary: summary.summary }));
  const title = `${loc.source.title || "Forked session"} (fork)`;
  lines.push(JSON.stringify({ type: "custom-title", sessionId: newId, customTitle: title }));

  // Next to the newest copy that holds the turn: where the session lives now.
  const holder = [...loc.source.parse].reverse().find((c) => uuidsOf(c).has(anchor)) ?? loc.source;
  const file = path.join(path.dirname(holder.file), `${newId}.jsonl`);
  try {
    fs.writeFileSync(file, lines.join("\n") + "\n", { flag: "wx" });
  } catch (e) {
    return { ok: false, error: `Could not write the fork: ${String(e)}` };
  }
  try {
    recordLineage(newId, sourceId);
  } catch {
    /* the copied records carry forkedFrom; the sidecar is only a backup */
  }

  return {
    ok: true,
    id: newId,
    cwd: loc.cwd,
    command: resumeCommandFor("claude", newId, loc.cwd),
    open: { provider: "claude", sessionId: newId, cwd: loc.cwd },
    note: crossesInjected(node, family.nodes)
      ? "Heads up: this prefix includes a message delivered mid-turn (hollow node). Claude Code wrote no record for it, so the fork does NOT contain that instruction."
      : undefined,
  };
}

/**
 * A queue-op-reconstructed interjection (old transcripts; hollow nodes with
 * synthetic "queued:" ids) reached the model but was written to no record, so
 * a fork whose prefix crosses one silently loses that instruction. Nothing can
 * restore it; the honest fix is to say so. Attachment-backed mid-turn messages
 * ARE copied, so they aren't warned about.
 */
function crossesInjected(node: TurnNode, nodes: TurnNode[]): boolean {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  for (let cur: TurnNode | undefined = node; cur && !seen.has(cur.id); ) {
    seen.add(cur.id);
    if (
      cur.injected ||
      cur.id.startsWith(INJECTED_PREFIX) ||
      cur.absorbedIds?.some((id) => id.startsWith(INJECTED_PREFIX))
    ) {
      return true;
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}
