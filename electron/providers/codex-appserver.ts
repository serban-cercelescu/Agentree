import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { harnessEnv } from "../paths.ts";
import { configuredPath } from "../settings.ts";

/**
 * Minimal client for `codex app-server` — newline-delimited JSON-RPC over
 * stdio, the protocol the Codex VS Code extension itself speaks.
 *
 * Used only for writes (`thread/fork`): the tree is read from the rollout
 * files, which show prompt-edit branches the API hides. One short-lived
 * process per call — forks are rare and a resident server would be one more
 * thing to supervise.
 *
 * Protocol facts (verified on codex-cli 0.162 and 0.164 against real rollouts
 * in a scratch CODEX_HOME): `initialize` → result, then the `initialized`
 * notification, then requests. No experimental capability is needed for what
 * Agentree sends. stderr carries log lines,
 * including an ERROR for unrecognised config keys that is harmless, so stderr
 * is never treated as failure. Exact types for the installed version:
 * `codex app-server generate-ts --out <dir>`.
 */

/**
 * Locate a codex binary without a shell. The Codex VS Code extension bundles
 * one (newest installed version first), which is the build the user's chat
 * panel actually runs; otherwise PATH. `AGENTREE_CODEX_BIN`, or the codex
 * binary setting, overrides both.
 */
export function findCodex(): { cmd: string; shell: boolean } | null {
  const override = configuredPath("codexBin");
  // A .cmd/.bat (npm's Windows shim) only starts through cmd.exe.
  if (override) return { cmd: override, shell: /\.(cmd|bat)$/i.test(override) };
  const exe = process.platform === "win32" ? "codex.exe" : "codex";
  const plat = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

  for (const extRoot of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const dir = path.join(os.homedir(), extRoot, "extensions");
    let exts: string[];
    try {
      exts = fs.readdirSync(dir).filter((d) => d.startsWith("openai.chatgpt-"));
    } catch {
      continue;
    }
    exts.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const ext of exts) {
      const bin = path.join(dir, ext, "bin");
      let plats: string[];
      try {
        plats = fs.readdirSync(bin).filter((p) => p.startsWith(plat));
      } catch {
        continue;
      }
      for (const p of plats) {
        const cand = path.join(bin, p, exe);
        if (fs.existsSync(cand)) return { cmd: cand, shell: false };
      }
    }
  }

  // PATH. On Windows an npm-installed codex is a .cmd shim, which can only be
  // started through cmd.exe — safe here because every argument is a constant.
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const e of exts) {
      const cand = path.join(d, `codex${e}`);
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return { cmd: cand, shell: /\.(cmd|bat)$/i.test(e) };
      }
    }
  }
  return null;
}

class RpcClient {
  private buf = "";
  private seq = 0;
  private waiting = new Map<
    number,
    { settle: (m: { result?: unknown; error?: { message?: string } }) => void; fail: (e: Error) => void }
  >();
  private dead: Error | null = null;

  constructor(private proc: ChildProcess) {
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      this.buf += d;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        let m: { id?: number; method?: string; result?: unknown; error?: { message?: string } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        // Responses carry our id; server→client notifications are ignored.
        if (typeof m.id === "number" && !m.method) this.waiting.get(m.id)?.settle(m);
      }
    });
    // A server that dies mid-request must fail what's outstanding at once —
    // not leave each caller to its timeout. EPIPE on stdin is the same event
    // seen from the writing side.
    proc.stdin!.on("error", (e) => this.failAll(new Error(`codex app-server: ${e.message}`)));
    proc.once("error", (e) => this.failAll(new Error(`Couldn't start codex app-server: ${e.message}`)));
    proc.once("exit", (code) => this.failAll(new Error(`codex app-server exited (${code}) before answering`)));
  }

  private failAll(e: Error): void {
    this.dead ??= e;
    for (const w of [...this.waiting.values()]) w.fail(e);
  }

  request<T>(method: string, params: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`codex app-server: ${method} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        settle: (m) => {
          done();
          if (m.error) reject(new Error(m.error.message ?? `${method} failed`));
          else resolve(m.result as T);
        },
        fail: (e) => {
          done();
          reject(e);
        },
      });
      this.proc.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  notify(method: string): void {
    if (!this.dead) this.proc.stdin!.write(JSON.stringify({ method }) + "\n");
  }
}

/** Run `fn` against a fresh app-server, always tearing the process down. */
async function withAppServer<T>(fn: (c: RpcClient) => Promise<T>): Promise<T> {
  const bin = findCodex();
  if (!bin) {
    throw new Error(
      "Couldn't find a codex binary (looked in the Codex VS Code extension and on PATH). Set its path in Agentree's settings, or in AGENTREE_CODEX_BIN.",
    );
  }
  // Through cmd.exe the command line is re-parsed, so a path with spaces
  // (C:\Program Files\…) must arrive quoted; the argument is a constant.
  const proc = spawn(bin.shell ? `"${bin.cmd}"` : bin.cmd, ["app-server"], {
    // The Codex home Agentree reads, also when only a saved setting names
    // it: a fork must go to the store the tree came from.
    env: { ...process.env, ...harnessEnv("codex") },
    stdio: ["pipe", "pipe", "ignore"],
    shell: bin.shell,
    windowsHide: true,
  });
  const client = new RpcClient(proc);
  try {
    await client.request("initialize", { clientInfo: { name: "agentree", version: "0.2.0" } });
    client.notify("initialized");
    return await fn(client);
  } finally {
    proc.kill();
  }
}

export type ForkThreadResult = { ok: true; threadId: string; cwd: string } | { ok: false; error: string };

/**
 * `thread/fork` through `lastTurnId` (inclusive), on a thread whose current
 * history holds that turn. Deliberately no `path`: on codex-cli 0.164 it needs
 * the experimentalApi capability and then refuses any page that isn't the
 * thread's head ("stale path") — it can't reach an abandoned edit branch.
 */
export async function forkThread(opts: { threadId: string; lastTurnId: string }): Promise<ForkThreadResult> {
  try {
    const res = await withAppServer((c) =>
      c.request<{ thread?: { id?: string; cwd?: string }; cwd?: string }>("thread/fork", {
        threadId: opts.threadId,
        lastTurnId: opts.lastTurnId,
        excludeTurns: true,
      }),
    );
    const id = res.thread?.id;
    if (!id) return { ok: false, error: "codex app-server returned no thread for the fork." };
    return { ok: true, threadId: id, cwd: res.cwd ?? res.thread?.cwd ?? "" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
