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

/**
 * Codex needs POLLING, not just fs.watch: its rollout appends are invisible to
 * macOS FSEvents. Verified empirically (v0.145.0) — with a recursive AND a flat
 * watch on the rollout's own directory, a live codex turn grew the file by
 * kilobytes (stat saw it within 200 ms) and neither watcher fired once in 60 s;
 * an append to the SAME file from another process fired immediately. Codex's
 * events surface only when it closes the file (exec mode delivers everything in
 * one burst at process exit). So fs.watch stays — it covers Claude, Copilot,
 * and codex fork/file creation on close — and a cheap stat sweep of the
 * codex/copilot roots catches the writes FSEvents never reports.
 */
const POLL_MS = 1000;

export interface Watcher {
  close(): void;
}

/**
 * Fingerprint every transcript under `dir`: path + size + mtime. A change in
 * any of them changes the string. Bounded depth (codex is Y/M/D + file = 3,
 * copilot is <id>/events.jsonl = 2); only transcript extensions are statted,
 * so a sweep is a few hundred stats — well under a millisecond of syscalls.
 */
function treeSignature(dir: string, depth = 0): string {
  let out = "";
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 3) out += treeSignature(p, depth + 1);
    } else if (/\.(jsonl|yaml)$/.test(e.name)) {
      try {
        const s = fs.statSync(p);
        out += `${p}:${s.size}:${s.mtimeMs}\n`;
      } catch {
        // deleted mid-sweep; the disappearance shows up as a shorter signature
      }
    }
  }
  return out;
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
  // Targets: (dir, only-this-file filter, poll). For a session, watch the
  // directory owning its transcript in whichever harness has it. For the
  // welcome screen, watch all three roots. Codex/Copilot roots are ALSO
  // stat-polled — see POLL_MS for why fs.watch alone goes deaf there.
  const targets: { dir: string; only: string | null; poll: boolean }[] = [];

  if (sessionId) {
    const loc = locate(sessionId);
    if (loc) {
      targets.push({ dir: path.dirname(loc.file), only: path.basename(loc.file), poll: false });
    } else {
      const codex = locateCodex(sessionId);
      // A stitched tree can grow through ANY family member (or a brand-new
      // fork), so a session watch covers the provider's whole root — the
      // parse cache keeps the rescan cheap.
      if (codex) targets.push({ dir: CODEX_SESSIONS, only: null, poll: true });
      else if (locateCopilot(sessionId)) targets.push({ dir: COPILOT_STATE, only: null, poll: true });
      else return { close() {} };
    }
  } else {
    targets.push({ dir: PROJECTS, only: null, poll: false });
    targets.push({ dir: CODEX_SESSIONS, only: null, poll: true });
    targets.push({ dir: COPILOT_STATE, only: null, poll: true });
  }

  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, QUIET_MS);
  };

  const polls: NodeJS.Timeout[] = [];
  for (const { dir, poll } of targets) {
    if (!poll || !fs.existsSync(dir)) continue;
    let sig = treeSignature(dir);
    polls.push(
      setInterval(() => {
        const next = treeSignature(dir);
        if (next !== sig) {
          sig = next;
          fire();
        }
      }, POLL_MS),
    );
  }

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
  if (watchers.length === 0 && polls.length === 0) return { close() {} };

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const p of polls) clearInterval(p);
    },
  };
}
