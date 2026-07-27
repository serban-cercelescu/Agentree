import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NodeId, NodeMeta, SessionId } from "../shared/types.ts";

/**
 * Agentree's sidecar metadata: labels, dead-end marks, notes.
 *
 * Kept strictly separate from Claude Code's transcripts. Those files are the
 * user's real work and are owned by the CLI — writing our annotations into
 * them would risk corrupting a session the CLI is mid-append on, and would
 * make our UI state indistinguishable from real conversation content.
 */
const DIR = path.join(os.homedir(), ".agentree", "meta");

// The app used to be called AgentView and kept its sidecar in ~/.agentview.
// Carry existing annotations across once; a failed rename (permissions, race)
// just leaves the old dir in place for a later attempt.
const OLD_ROOT = path.join(os.homedir(), ".agentview");
try {
  if (fs.existsSync(OLD_ROOT) && !fs.existsSync(path.dirname(DIR))) {
    fs.renameSync(OLD_ROOT, path.dirname(DIR));
  }
} catch {
  /* keep reading/writing the new location; old annotations stay recoverable */
}

function fileFor(sessionId: SessionId): string | null {
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  return path.join(DIR, `${sessionId}.json`);
}

export function readMeta(sessionId: SessionId): Record<NodeId, NodeMeta> {
  const file = fileFor(sessionId);
  if (!file || !fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<NodeId, NodeMeta>;
  } catch {
    return {};
  }
}

export function writeMeta(sessionId: SessionId, nodeId: NodeId, patch: NodeMeta): void {
  const file = fileFor(sessionId);
  if (!file) return;
  fs.mkdirSync(DIR, { recursive: true });

  const all = readMeta(sessionId);
  const next: NodeMeta = { ...all[nodeId], ...patch };

  // Drop keys that were cleared so the file doesn't accrete nulls.
  for (const k of Object.keys(next) as (keyof NodeMeta)[]) {
    if (next[k] === undefined || next[k] === null || next[k] === "") delete next[k];
  }

  if (Object.keys(next).length === 0) delete all[nodeId];
  else all[nodeId] = next;

  // Write-then-rename so a crash can't leave a half-written JSON file.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), "utf8");
  fs.renameSync(tmp, file);
}
