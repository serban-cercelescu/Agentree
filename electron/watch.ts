import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { locate } from "./transcripts.ts";
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
  let dir = PROJECTS;
  let only: string | null = null;

  if (sessionId) {
    const loc = locate(sessionId);
    if (!loc) return { close() {} };
    dir = path.dirname(loc.file);
    only = path.basename(loc.file);
  }

  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, QUIET_MS);
  };

  let w: fs.FSWatcher;
  try {
    w = fs.watch(dir, { recursive: !sessionId }, (_event, filename) => {
      if (only && filename && path.basename(filename) !== only) return;
      if (!only && filename && !filename.endsWith(".jsonl")) return;
      fire();
    });
  } catch {
    // No watch (missing directory, or a platform without recursive watch).
    // The view simply stays static rather than the app failing to open.
    return { close() {} };
  }

  // A watcher on a directory the user may delete shouldn't take the app down.
  w.on("error", () => w.close());

  return {
    close() {
      if (timer) clearTimeout(timer);
      w.close();
    },
  };
}
