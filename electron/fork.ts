import { loadSession, locate } from "./transcripts.ts";
import type { ForkResult, SessionId } from "../shared/types.ts";

/**
 * Build the command that resumes a session just after a chosen turn.
 *
 * The CLI has an undocumented flag for exactly this — the Agent SDK's
 * `resumeSessionAt`, exposed as:
 *
 *     claude --resume <sessionId> --resume-session-at <messageUuid>
 *
 * It loads the conversation as the chain ending at that uuid (inclusive), and
 * the new exchange branches off it in the same transcript — same session id,
 * same tree.
 *
 * This is the third design, and the first correct one:
 *
 *  1. Copying the transcript under a new id made every fork list as an
 *     unrelated conversation.
 *  2. Appending `/rewind`'s explicit `last-prompt` pointer worked — but only
 *     if nothing wrote after it. A session open in a CLI appends its own
 *     non-explicit pointer on exit, and the loader's reducer lets any later
 *     record clear the pin. Users fork while the session is open, then exit to
 *     go resume: the pin died in exactly that gap, every time.
 *
 * The flag has neither problem: nothing is written until the user actually
 * resumes, and the target travels on the command line, so no interleaved
 * writer can stomp it. Agentree is back to strictly read-only over
 * `~/.claude/projects`.
 *
 * Caveat worth keeping in mind: hidden flags aren't a stable interface. If a
 * future CLI drops `--resume-session-at`, the fallback is the pointer append
 * (design 2) issued immediately before the resume.
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

  const resume = `claude --resume ${sessionId} --resume-session-at ${leafUuid}`;
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
