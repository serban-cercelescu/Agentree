import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionId } from "../shared/types.ts";

/**
 * Fork lineage sidecar: child session id -> parent session id.
 *
 * Codex records lineage itself (`forked_from_id` in an append-only rollout the
 * CLI never rewrites), but Copilot REGENERATES workspace.yaml on every resume
 * and silently drops unknown keys — verified by forking, resuming, and finding
 * the `forked_from` key gone. So the durable copy of "which session this fork
 * came from" has to live in a file only Agentree writes.
 */
const FILE = path.join(os.homedir(), ".agentree", "lineage.json");

export function readLineage(): Record<SessionId, SessionId> {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<SessionId, SessionId>;
  } catch {
    return {};
  }
}

export function recordLineage(child: SessionId, parent: SessionId): void {
  const all = readLineage();
  all[child] = parent;
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1), "utf8");
  fs.renameSync(tmp, FILE);
}
