import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { locate } from "./transcripts.ts";
import { SESSIONS as CODEX_SESSIONS, locateCodex } from "./providers/codex.ts";
import { STATE as COPILOT_STATE, locateCopilot } from "./providers/copilot.ts";
import type { SessionId } from "../shared/types.ts";

const PROJECTS = path.join(os.homedir(), ".claude", "projects");

/**
 * Debounce window for disk events.
 *
 * The CLI appends a transcript one record per content block, so a single reply
 * arrives as a burst of writes. Re-parsing on each one would reparse the file
 * dozens of times per turn; a short quiet period coalesces the burst into one
 * refresh while still feeling immediate.
 */
const QUIET_MS = 250;

export interface Watcher {
  close(): void;
}

/**
 * Watch a session's transcript, or — with `sessionId: null` — the whole
 * projects tree, and call `onChange` once per burst of writes.
 *
 * Watching a single session still means watching its *directory* rather than
 * the file: editors and the CLI both replace files, and a watch on an inode
 * goes deaf the moment the file is rewritten.
 */
export function watchTranscripts(
  sessionId: SessionId | null,
  onChange: () => void,
): Watcher {
  // Targets: (dir, only-this-file filter). For a session, watch the directory
  // owning its transcript in whichever harness has it. For the welcome screen,
  // watch all three roots.
  const targets: { dir: string; only: string | null }[] = [];

  if (sessionId) {
    const loc = locate(sessionId);
    if (loc) {
      targets.push({ dir: path.dirname(loc.file), only: path.basename(loc.file) });
    } else {
      const codex = locateCodex(sessionId);
      // A stitched tree can grow through ANY family member (or a brand-new
      // fork), so a session watch covers the provider's whole root — the
      // parse cache keeps the rescan cheap.
      if (codex) targets.push({ dir: CODEX_SESSIONS, only: null });
      else if (locateCopilot(sessionId)) targets.push({ dir: COPILOT_STATE, only: null });
      else return { close() {} };
    }
  } else {
    targets.push({ dir: PROJECTS, only: null });
    targets.push({ dir: CODEX_SESSIONS, only: null });
    targets.push({ dir: COPILOT_STATE, only: null });
  }

  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, QUIET_MS);
  };

  const watchers: fs.FSWatcher[] = [];
  for (const { dir, only } of targets) {
    try {
      const w = fs.watch(dir, { recursive: !only }, (_event, filename) => {
        if (only && filename && path.basename(filename) !== only) return;
        // Claude/Codex append .jsonl; Copilot appends events.jsonl inside a
        // session dir — both end in .jsonl, and yaml changes ride along on the
        // same debounce as their neighbouring events write.
        if (!only && filename && !/\.(jsonl|yaml)$/.test(filename)) return;
        fire();
      });
      // A watcher on a directory the user may delete shouldn't take the app down.
      w.on("error", () => w.close());
      watchers.push(w);
    } catch {
      // Missing directory (harness not installed) — the others still watch.
    }
  }
  if (watchers.length === 0) return { close() {} };

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
