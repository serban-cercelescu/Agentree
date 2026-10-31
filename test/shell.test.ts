import { describe, expect, it } from "vitest";
import { commandLine, quote, resumeCommand } from "../electron/shell.ts";

describe("resume commands", () => {
  it("emits PowerShell 5.1 syntax on Windows (no &&, literal path)", () => {
    expect(resumeCommand("C:\\Users\\me\\it's [x]", ["claude", "--resume", "abc-123"], { platform: "win32" })).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\me\\it''s [x]'; claude --resume abc-123",
    );
  });

  it("emits POSIX syntax elsewhere", () => {
    expect(resumeCommand("/home/me/it's", ["codex", "resume", "abc"], { platform: "posix" })).toBe(
      "cd '/home/me/it'\\''s' && codex resume abc",
    );
  });

  it("leaves plain words bare and omits the cd without a cwd", () => {
    expect(quote("--resume=abc-1", "posix")).toBe("--resume=abc-1");
    expect(resumeCommand("", ["copilot", "--resume=x"], { platform: "win32" })).toBe("copilot --resume=x");
  });

  it("carries the harness's store into the command, always quoted", () => {
    const env = { CODEX_HOME: "C:\\Codex homes\\it's" };
    expect(resumeCommand("C:\\w", ["codex", "resume", "abc"], { env, platform: "win32" })).toBe(
      "Set-Location -LiteralPath 'C:\\w'; $env:CODEX_HOME = 'C:\\Codex homes\\it''s'; codex resume abc",
    );
    expect(commandLine(["codex", "resume", "abc"], { CODEX_HOME: "/srv/codex" }, "posix")).toBe(
      "CODEX_HOME='/srv/codex' codex resume abc",
    );
  });
});
