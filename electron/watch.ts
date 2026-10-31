import fs from "node:fs";
import path from "node:path";

/** Files any provider reads: .jsonl, Codex's compressed pages, Copilot's yaml. */
const TRANSCRIPT = /\.(jsonl|jsonl\.zst|yaml)$/;

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

/**
 * Something on disk a view depends on. Resolved by the providers (in the
 * backend worker — finding a session's files can mean a scan), watched here
 * on the host, which only stats.
 *
 * - `dir`: watched recursively for transcript files, and stat-polled if `poll`.
 * - `file`: a single file outside those trees (Codex's thread-name index),
 *   stat-polled only.
 */
export type WatchTarget = { kind: "dir"; path: string; poll: boolean } | { kind: "file"; path: string };

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
    } else if (TRANSCRIPT.test(e.name)) {
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

function fileSignature(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "missing";
  }
}

/**
 * Watch `targets` and call `onChange` once per burst of writes.
 *
 * Directories, never single transcripts: editors and the CLI both replace
 * files, a watch on an inode goes deaf the moment the file is rewritten — and
 * a tree is a FAMILY of sessions that can grow through any member, or through
 * a brand-new fork file next to them.
 */
export function watchTranscripts(targets: WatchTarget[], onChange: () => void): Watcher {
  let timer: NodeJS.Timeout | null = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, QUIET_MS);
  };

  const polls: NodeJS.Timeout[] = [];
  const poll = (sign: () => string) => {
    let sig = sign();
    polls.push(
      setInterval(() => {
        const next = sign();
        if (next !== sig) {
          sig = next;
          fire();
        }
      }, POLL_MS),
    );
  };

  const watchers: fs.FSWatcher[] = [];
  const attach = (t: Extract<WatchTarget, { kind: "dir" }>) => {
    if (t.poll) poll(() => treeSignature(t.path));
    try {
      // The long, real path: on Windows a recursive watch on an 8.3 short
      // path (C:\Users\JOHNSM~1\…, as os.tmpdir() can return) gets event
      // names in long form, and libuv aborts the whole process on them.
      const w = fs.watch(fs.realpathSync.native(t.path), { recursive: true }, (_event, filename) => {
        // Claude/Codex append .jsonl; Codex rotates pages to .jsonl.zst;
        // Copilot appends events.jsonl inside a session dir, and yaml changes
        // ride along on the same debounce as their neighbouring events write.
        if (filename && !TRANSCRIPT.test(filename)) return;
        fire();
      });
      // A watcher on a directory the user may delete shouldn't take the app down.
      w.on("error", () => w.close());
      watchers.push(w);
    } catch {
      // Gone again between the check and the watch; the poll (if any) still runs.
    }
  };

  // A root that doesn't exist yet (the harness isn't installed, or a new
  // home was just configured) is waited for: a stat per second, and once it
  // appears it gets the normal watch, plus one change to read what's there.
  for (const t of targets) {
    if (t.kind === "file") {
      poll(() => fileSignature(t.path));
    } else if (fs.existsSync(t.path)) {
      attach(t);
    } else {
      const wait = setInterval(() => {
        if (!fs.existsSync(t.path)) return;
        clearInterval(wait);
        attach(t);
        fire();
      }, POLL_MS);
      polls.push(wait);
    }
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const w of watchers) w.close();
      for (const p of polls) clearInterval(p);
    },
  };
}

/** Waits between attempts to resolve watch targets that failed (worker restarting, say). */
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

/**
 * A watcher whose targets come from the backend worker. Closing it before
 * they arrive is fine: nothing is ever started.
 *
 * Two gaps it closes. Resolution can fail (the worker crashed and is being
 * restarted), and the UI has no refresh button to fall back on — so it
 * retries, backing off, until it gets targets or is closed. And the view
 * read the store BEFORE the watch existed, so anything written in between
 * would be missed: once installed, it fires `onChange` once to reconcile.
 */
export function watchLater(resolve: () => Promise<WatchTarget[]>, onChange: () => void): Watcher {
  let inner: Watcher | null = null;
  let closed = false;
  let retry: NodeJS.Timeout | null = null;
  const attempt = (n: number) => {
    resolve().then(
      (t) => {
        if (closed) return;
        inner = watchTranscripts(t, onChange);
        onChange();
      },
      () => {
        if (!closed) retry = setTimeout(() => attempt(n + 1), RETRY_MS[Math.min(n, RETRY_MS.length - 1)]);
      },
    );
  };
  attempt(0);
  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      inner?.close();
    },
  };
}
