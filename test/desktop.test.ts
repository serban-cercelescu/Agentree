import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeLink } from "../electron/native.ts";
import { terminalLaunch, usableCwd } from "../electron/terminal.ts";

const ID = "01a17c6d-c757-7562-9886-3e9876e35c5f";

describe("deep links into the harness extensions", () => {
  it("uses each extension's own URI handler", () => {
    expect(nativeLink({ provider: "claude", sessionId: ID, cwd: "" })).toBe(
      `vscode://anthropic.claude-code/open?session=${ID}`,
    );
    expect(nativeLink({ provider: "codex", sessionId: ID, cwd: "" }, "vscode-insiders")).toBe(
      `vscode-insiders://openai.chatgpt/local/${ID}`,
    );
  });

  it("refuses harnesses without an extension and anything that isn't an id", () => {
    expect(nativeLink({ provider: "copilot", sessionId: ID, cwd: "" })).toBeNull();
    expect(nativeLink({ provider: "claude", sessionId: "x&prompt=rm -rf", cwd: "" })).toBeNull();
  });
});

describe("OS terminal launch", () => {
  const argv = ["claude", "--resume", ID];
  /** The PowerShell script a Windows launch carries, decoded. */
  const script = (cmdLine: string) =>
    Buffer.from(/ -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmdLine)![1], "base64").toString("utf16le");

  it("Windows: a NEW console via `start`, with nothing of the path for cmd.exe to parse", () => {
    const l = terminalLaunch(argv, "C:\\a b & c\\%USERNAME%", "win32")!;
    expect(l).toMatchObject({ cmd: "cmd.exe", verbatim: true });
    expect(l.args.slice(0, 2)).toEqual(["/d", "/c"]);
    expect(l.args[2]).toMatch(/^start "" powershell\.exe -NoExit -EncodedCommand [A-Za-z0-9+/=]+$/);
    expect(script(l.args[2])).toBe(`Set-Location -LiteralPath 'C:\\a b & c\\%USERNAME%'; claude --resume ${ID}`);
  });

  // Executes the launcher's own cmd → PowerShell boundary (without `start`,
  // so no window opens and no agent runs): a literal %NAME% in the directory
  // and in the store path must arrive unexpanded.
  it.runIf(process.platform === "win32")("Windows: cmd expands nothing on the way to PowerShell", () => {
    // Long form: `cd` prints it so, where the temp dir may be an 8.3 short name.
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentree-%AGENTREE_PROBE%-")));
    try {
      const l = terminalLaunch(["cmd", "/c", "cd & set CODEX_HOME"], dir, "win32", undefined, {
        CODEX_HOME: "C:\\stores\\%AGENTREE_PROBE%",
      })!;
      const once = l.args[2].replace(/^start "" /, "").replace("-NoExit", "-NoProfile -NonInteractive");
      const r = spawnSync(l.cmd, [...l.args.slice(0, 2), once], {
        windowsVerbatimArguments: true,
        env: { ...process.env, AGENTREE_PROBE: "expanded" },
        encoding: "utf8",
      });
      expect(r.stdout.trim().split(/\r?\n/)).toEqual([dir, "CODEX_HOME=C:\\stores\\%AGENTREE_PROBE%"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("macOS: Terminal.app with an escaped AppleScript string", () => {
    const l = terminalLaunch(argv, '/Users/me/say "hi"', "darwin")!;
    expect(l.cmd).toBe("osascript");
    expect(l.args[1]).toBe(
      `tell application "Terminal" to do script "cd '/Users/me/say \\"hi\\"' && claude --resume ${ID}"`,
    );
  });

  it("Linux: the first emulator on PATH, kept open afterwards", () => {
    const l = terminalLaunch(argv, "/home/me", "linux", (exe) => exe === "gnome-terminal")!;
    expect(l).toEqual({
      cmd: "gnome-terminal",
      args: ["--", "bash", "-lc", `cd /home/me && claude --resume ${ID}; exec bash`],
    });
    expect(terminalLaunch(argv, "/home/me", "linux", () => false)).toBeNull();
  });

  it("writes the harness's store into the command, which the window's shell may not inherit", () => {
    const env = { CLAUDE_CONFIG_DIR: "/srv/claude" };
    expect(script(terminalLaunch(argv, "C:\\w", "win32", undefined, { CLAUDE_CONFIG_DIR: "C:\\claude" })!.args[2])).toBe(
      `Set-Location -LiteralPath 'C:\\w'; $env:CLAUDE_CONFIG_DIR = 'C:\\claude'; claude --resume ${ID}`,
    );
    expect(terminalLaunch(argv, "/home/me", "darwin", undefined, env)!.args[1]).toBe(
      `tell application "Terminal" to do script "cd /home/me && CLAUDE_CONFIG_DIR='/srv/claude' claude --resume ${ID}"`,
    );
  });

  it("falls back to home when the session's folder is gone", () => {
    expect(usableCwd("Z:\\definitely\\not\\here")).toBe(os.homedir());
    expect(usableCwd(os.tmpdir())).toBe(os.tmpdir());
  });
});
