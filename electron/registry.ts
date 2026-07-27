import type { ForkResult, SessionDetail, SessionId, SessionMeta } from "../shared/types.ts";
import { listSessions as listClaude, loadSession as loadClaude, locate as locateClaude } from "./transcripts.ts";
import { forkAt as forkClaudeAt } from "./fork.ts";
import { listCodexSessions, loadCodexSession, forkCodexAt } from "./providers/codex.ts";
import { listCopilotSessions, loadCopilotSession, locateCopilot, forkCopilotAt } from "./providers/copilot.ts";

/**
 * One surface over the three harnesses. Session ids are uuids in all three
 * stores, so collisions are not a practical concern — routing is "whoever has
 * the id", tried in order of lookup cost.
 */

export function listAllSessions(): SessionMeta[] {
  const out = [...listClaude(), ...listCodexSessions(), ...listCopilotSessions()];
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export function loadAnySession(id: SessionId): SessionDetail | null {
  if (locateClaude(id)) return loadClaude(id);
  if (locateCopilot(id)) return loadCopilotSession(id);
  const codex = loadCodexSession(id);
  if (codex) return codex;
  // A copilot child fork id resolves through its family even though the
  // locate() above only checks the dir name.
  return loadCopilotSession(id);
}

export function forkAnyAt(sessionId: SessionId, nodeId: string): ForkResult {
  if (locateClaude(sessionId)) return forkClaudeAt(sessionId, nodeId);

  // Codex/Copilot trees are stitched from linear sessions, and a merged turn
  // spans several raw records — the fork must anchor on the LAST one, exactly
  // like Claude's lastRawId.
  const detail = loadAnySession(sessionId);
  if (!detail) return { ok: false, error: "That session is no longer on disk." };
  const node = detail.nodes.find((n) => n.id === nodeId);
  if (!node) return { ok: false, error: "That turn is not in this session." };
  const anchor = node.lastRawId ?? node.id;

  if (detail.meta.provider === "codex") return forkCodexAt(anchor);
  if (detail.meta.provider === "copilot") return forkCopilotAt(detail.meta.id, anchor);
  return { ok: false, error: "Forking is not supported for this session." };
}
