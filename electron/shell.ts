/**
 * Ready-to-paste resume commands, spelled for the shell the user actually has.
 *
 * Sessions are stored per working directory, so a resume has to run from the
 * session's cwd — the change of directory is part of the command. POSIX shells
 * get `cd '…' && …`; Windows gets PowerShell 5.1 syntax, which is what a stock
 * Windows terminal (and VS Code's default Windows terminal) runs: 5.1 has no
 * `&&`, and `cd "…"` mangles paths with `[` `]` unless given -LiteralPath.
 */
import type { ProviderId } from "../shared/types.ts";

export type Platform = "win32" | "posix";

/**
 * The argv that resumes a session in each harness's CLI. Here rather than in
 * the providers so a host can build a terminal command without loading them.
 */
export const RESUME_ARGV: Record<ProviderId, (id: string) => string[]> = {
  claude: (id) => ["claude", "--resume", id],
  codex: (id) => ["codex", "resume", id],
  copilot: (id) => ["copilot", `--resume=${id}`],
};

export const hostPlatform = (): Platform => (process.platform === "win32" ? "win32" : "posix");

/** Single-quote a word for the target shell; ids and flags pass through bare. */
export function quote(word: string, platform: Platform = hostPlatform()): string {
  if (/^[A-Za-z0-9_\-=.:/@]+$/.test(word)) return word;
  return literal(word, platform);
}

/** Always single-quoted: a value assigned to a variable is never a bare word in PowerShell. */
function literal(word: string, platform: Platform): string {
  return platform === "win32" ? `'${word.replace(/'/g, "''")}'` : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Environment a command needs, variable → value. */
export type Env = Record<string, string>;

/**
 * `argv` as one command, preceded by the variables it needs. POSIX scopes them
 * to the command (`X='…' cmd`); PowerShell 5.1 has no such prefix, so they are
 * set for the rest of that shell session (`$env:X = '…'; cmd`).
 */
export function commandLine(argv: string[], env: Env = {}, platform: Platform = hostPlatform()): string {
  const cmd = argv.map((a) => quote(a, platform)).join(" ");
  const vars = Object.entries(env);
  if (!vars.length) return cmd;
  return platform === "win32"
    ? `${vars.map(([k, v]) => `$env:${k} = ${literal(v, platform)}`).join("; ")}; ${cmd}`
    : `${vars.map(([k, v]) => `${k}=${literal(v, platform)}`).join(" ")} ${cmd}`;
}

export function resumeCommand(
  cwd: string,
  argv: string[],
  { env = {}, platform = hostPlatform() }: { env?: Env; platform?: Platform } = {},
): string {
  const cmd = commandLine(argv, env, platform);
  if (!cwd) return cmd;
  return platform === "win32"
    ? `Set-Location -LiteralPath ${quote(cwd, platform)}; ${cmd}`
    : `cd ${quote(cwd, platform)} && ${cmd}`;
}
