import os from "node:os";
import path from "node:path";
import type { ProviderId, SettingsPaths } from "../shared/types.ts";
import { configuredPath, PATH_ENV } from "./settings.ts";

/**
 * Every on-disk root Agentree reads or writes, resolved lazily.
 *
 * Each harness honours its own override variable (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `COPILOT_HOME`), so following them is simply correct for
 * users who relocate their config. It also lets the test suite point every
 * provider at fixtures without touching the real home directory. After the
 * environment come Agentree's own settings (`configuredPath`), then the
 * default. Functions rather than constants: a value captured at module load
 * would ignore an override set, or a setting changed, afterwards.
 */
const home = () => os.homedir();

export const claudeHome = () => configuredPath("claudeConfigDir") || path.join(home(), ".claude");
export const claudeProjects = () => path.join(claudeHome(), "projects");

export const codexHome = () => configuredPath("codexHome") || path.join(home(), ".codex");
export const codexSessions = () => path.join(codexHome(), "sessions");
export const codexArchived = () => path.join(codexHome(), "archived_sessions");
export const codexIndex = () => path.join(codexHome(), "session_index.jsonl");

export const copilotState = () => path.join(configuredPath("copilotHome") || path.join(home(), ".copilot"), "session-state");

/** The setting (and, through `PATH_ENV`, the variable) that relocates each harness's store. */
export const HOME_SETTING: Record<ProviderId, keyof SettingsPaths> = {
  claude: "claudeConfigDir",
  codex: "codexHome",
  copilot: "copilotHome",
};

/**
 * What a harness's own process — a fork subprocess, a resumed CLI — needs in
 * its environment to use the store Agentree reads: the harness's variable,
 * whenever Agentree's root for it isn't the default. A root set by a saved
 * setting is invisible to the harness otherwise; one set by the variable is
 * restated, so a command pasted into another shell still finds it.
 */
export function harnessEnv(provider: ProviderId): Record<string, string> {
  const key = HOME_SETTING[provider];
  const dir = configuredPath(key);
  return dir ? { [PATH_ENV[key]]: dir } : {};
}

/** Agentree's own sidecars: annotations, fork lineage, settings. Environment only. */
export { agentreeHome } from "./settings.ts";
