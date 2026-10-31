import type { ProviderId, SessionId } from "../shared/types.ts";
import { harnessEnv } from "./paths.ts";
import { RESUME_ARGV, resumeCommand, type Env } from "./shell.ts";

/**
 * How to resume a session in its harness's CLI, as the worker resolves it:
 * the argv, plus the environment that points the harness at the store
 * Agentree read the session from (`harnessEnv`). Hosts start terminals with
 * it; they never resolve store roots themselves.
 */
export interface ResumeLaunch {
  argv: string[];
  env: Env;
}

export function resumeLaunch(provider: ProviderId, sessionId: SessionId): ResumeLaunch | null {
  const argv = RESUME_ARGV[provider];
  if (!argv || !/^[a-zA-Z0-9-]{8,64}$/.test(sessionId)) return null;
  return { argv: argv(sessionId), env: harnessEnv(provider) };
}

/** The ready-to-paste command that resumes a session from its cwd, in the host shell's syntax. */
export function resumeCommandFor(provider: ProviderId, sessionId: SessionId, cwd: string): string {
  const launch = resumeLaunch(provider, sessionId);
  return launch ? resumeCommand(cwd, launch.argv, { env: launch.env }) : "";
}
