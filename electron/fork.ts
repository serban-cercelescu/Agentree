import { loadSession, locate } from "./transcripts.ts";
import type { ForkResult, SessionId } from "../shared/types.ts";

/**
 * Build the command that resumes a session just after a chosen turn.
 *
 * The command does two things, belt and braces, because the two mechanisms
 * cover different CLI entrypoints:
 *
 *  1. Appends `/rewind`'s explicit pointer record to the transcript:
 *     `{"type":"last-prompt","leafUuid":<uuid>,"explicit":true,...}`.
 *     Interactive resume honours exactly this pin — verified on CLI 2.1.220:
 *     the TUI hydrates the chain ending at the pinned uuid and the next
 *     exchange lands as a second child of it. Without `"explicit":true` the
 *     pointer is ignored (also verified; a bare leafUuid resumed at the tip).
 *  2. Passes `--resume-session-at <uuid>` — which the CLI's own option table
 *     declares print-mode-only ("use with --resume in print mode"), and which
 *     interactive mode silently ignores. Kept because it makes the same
 *     command correct under `-p`, and costs nothing interactively.
 *
 * Why not the flag alone (the previous design): it looked correct because it
 * WAS verified — in print mode. Interactively the hydration path never reads
 * it, so every fork quietly continued from the tip.
 *
 * Why the pointer append is safe here when it wasn't as a fork-time write:
 * the append is part of the emitted command, executed by the user immediately
 * before the resume (`printf … >> transcript && claude --resume …`). The
 * historical failure mode — a still-open CLI appending its own non-explicit
 * pointer after ours and clearing the pin — needs a writer to land in that
 * millisecond gap. Agentree itself still writes nothing at fork-click time;
 * nothing happens until the user runs the command.
 */
export function forkAt(sessionId: SessionId, nodeId: string): ForkResult {
  const loc = locate(sessionId);
  if (!loc) return { ok: false, error: "That session's transcript is no longer on disk." };

  const session = loadSession(sessionId);
  const node = session?.nodes.find((n) => n.id === nodeId);
  if (!session || !node) return { ok: false, error: "That turn is not in this transcript." };
  if (node.injected) {
    // Reconstructed from the message queue — there is no record to resume at.
    return { ok: false, error: "This turn was delivered mid-turn and has no transcript record." };
  }
  if (node.midTurn) {
    // A queued_command attachment is a real record, but the resume loader
    // indexes only messages — anchoring here gets "No message found". The
    // message is not lost: any fork below this point carries it.
    return {
      ok: false,
      error:
        "This mid-turn message can't anchor a resume itself. Fork the turn after it — resumes that pass this point retain the message.",
    };
  }
  if (node.preCompact) {
    return {
      ok: false,
      error:
        "This turn predates the session's last /compact. Claude Code only indexes messages after the compaction, so it cannot resume here.",
    };
  }

  // Anchor on the turn's LAST record. Anchoring on `node.id` would cut inside a
  // reply — mid-way through its thinking/text/tool_use blocks.
  const leafUuid = node.lastRawId ?? node.id;
  if (leafUuid.startsWith("queued:")) {
    // Belt and braces: a synthetic interjection id must never reach the
    // command line — the CLI has no record to resume at.
    return { ok: false, error: "This turn was delivered mid-turn and has no transcript record." };
  }

  // A queue-op-reconstructed interjection (old transcripts, hollow nodes with
  // synthetic "queued:" ids) reaches the model but is written to no transcript
  // record — a resume whose prefix crosses one silently loses that
  // instruction, which reads as the fork "behaving weirdly". Nothing
  // read-only can restore it; the honest fix is to say so up front.
  // Attachment-backed mid-turn messages (`midTurn`) are NOT warned about:
  // verified against the live CLI, resumes that pass them retain them.
  let crossesInjected = false;
  {
    const byId = new Map(session.nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    let cur: typeof node | undefined = node;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      // A merged run that swallowed an interjection keeps its synthetic
      // "queued:" id in absorbedIds without being marked injected itself.
      if (
        cur.injected ||
        cur.id.startsWith("queued:") ||
        cur.absorbedIds?.some((id) => id.startsWith("queued:"))
      ) {
        crossesInjected = true;
        break;
      }
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
  }

  // The explicit pin is what interactive resume actually obeys; the flag
  // covers print mode. Uuids and session ids are plain hex-and-dashes, so the
  // single-quoted JSON needs no escaping.
  const pin = JSON.stringify({
    type: "last-prompt",
    leafUuid,
    explicit: true,
    sessionId,
  });
  const resume =
    `printf '%s\\n' '${pin}' >> ${JSON.stringify(loc.file)} && ` +
    `claude --resume ${sessionId} --resume-session-at ${leafUuid}`;
  const cwd = loc.cwd;
  return {
    ok: true,
    id: sessionId,
    cwd,
    // Sessions are per-directory, so the cd is part of the command.
    command: cwd ? `cd ${JSON.stringify(cwd)} && ${resume}` : resume,
    note: crossesInjected
      ? "Heads up: this prefix includes a message delivered mid-turn (hollow node). Claude Code wrote no record for it, so the resumed conversation will NOT contain that instruction."
      : undefined,
  };
}
