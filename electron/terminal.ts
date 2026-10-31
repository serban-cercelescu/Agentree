import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActionResult } from "../shared/types.ts";
import { resumeCommand, type Env } from "./shell.ts";

/**
 * Open a NEW OS terminal window running a resume command — the desktop app's
 * counterpart to VS Code's integrated terminal.
 *
 * - Windows: PowerShell in a new console window via `cmd /c start`
 *   (`-NoExit` keeps it open after the agent quits), running the same
 *   `Set-Location …; <argv>` script as the copied command, encoded.
 * - macOS: Terminal.app via `osascript … do script`.
 * - Linux: the first terminal emulator on PATH, running a login bash that
 *   stays open afterwards.
 *
 * Pure Node (no Electron import): the extension never needs it, but the main
 * process does, and keeping it Electron-free keeps it testable.
 */
export interface Launch {
  cmd: string;
  args: string[];
  cwd?: string;
  /** Pass `args` to the process exactly as written (Windows cmd.exe quoting). */
  verbatim?: boolean;
}

const onPath = (exe: string): boolean =>
  (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((d) => d && fs.existsSync(path.join(d, exe)));

/** A session's cwd can be gone (repo moved or deleted); the agent CLI still finds the session. */
export const usableCwd = (cwd: string): string =>
  cwd && fs.existsSync(cwd) ? cwd : os.homedir();

/**
 * `env` is written into the command itself, not passed to the launcher: on
 * macOS and many Linux emulators the window's shell isn't a child of the
 * launcher and wouldn't inherit it.
 */
export function terminalLaunch(
  argv: string[],
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  has: (exe: string) => boolean = onPath,
  env: Env = {},
): Launch | null {
  if (platform === "win32") {
    // `start` is what gives the shell a NEW console window: Node's `detached`
    // maps to DETACHED_PROCESS on Windows, i.e. no console at all, and a
    // console program spawned that way never shows up (verified). But cmd
    // expands `%NAME%` anywhere in its command line, quotes or not, so no
    // path may pass through it: the directory change and the command travel
    // as one PowerShell script, base64 (`-EncodedCommand`, UTF-16LE), which
    // has nothing for cmd to expand or split.
    const ps = resumeCommand(cwd, argv, { env, platform: "win32" });
    const encoded = Buffer.from(ps, "utf16le").toString("base64");
    return {
      cmd: "cmd.exe",
      args: ["/d", "/c", `start "" powershell.exe -NoExit -EncodedCommand ${encoded}`],
      verbatim: true,
    };
  }
  const posix = resumeCommand(cwd, argv, { env, platform: "posix" });
  if (platform === "darwin") {
    // AppleScript string literal: escape backslashes and double quotes.
    const script = posix.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      cmd: "osascript",
      args: ["-e", `tell application "Terminal" to do script "${script}"`, "-e", 'tell application "Terminal" to activate'],
    };
  }
  const keepOpen = `${posix}; exec bash`;
  const candidates: [string, string[]][] = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", keepOpen]],
    ["gnome-terminal", ["--", "bash", "-lc", keepOpen]],
    ["konsole", ["-e", "bash", "-lc", keepOpen]],
    ["xfce4-terminal", ["-x", "bash", "-lc", keepOpen]],
    ["xterm", ["-e", "bash", "-lc", keepOpen]],
  ];
  const hit = candidates.find(([exe]) => has(exe));
  return hit ? { cmd: hit[0], args: hit[1] } : null;
}

/**
 * Resolves once the launcher process has actually started (or failed to):
 * spawn reports a missing binary asynchronously, and answering `ok` before
 * that would tell the user a window is opening when nothing will.
 */
export function openTerminal(argv: string[], cwd: string, env: Env = {}): Promise<ActionResult> {
  const launch = terminalLaunch(argv, usableCwd(cwd), process.platform, onPath, env);
  if (!launch) return Promise.resolve({ ok: false, error: "No terminal emulator found on PATH." });
  const failed = (e: unknown): ActionResult => ({
    ok: false,
    error: `Couldn't open a terminal: ${e instanceof Error ? e.message : String(e)}`,
  });
  return new Promise((resolve) => {
    try {
      const child = spawn(launch.cmd, launch.args, {
        cwd: launch.cwd,
        // POSIX: outlive the app. Windows: cmd.exe exits as soon as `start`
        // has opened the new console, so it needs neither.
        detached: process.platform !== "win32",
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
      child.once("error", (e) => resolve(failed(e)));
    } catch (e) {
      resolve(failed(e));
    }
  });
}
