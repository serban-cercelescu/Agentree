import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId, Settings, SettingsPatch, SettingsPaths, SettingsState, ViewState } from "../shared/types.ts";

/**
 * Agentree's settings, in `<agentree home>/settings.json`.
 *
 * Read and written by the backend worker only — both hosts run the same
 * worker, so one implementation serves the desktop app and the extension.
 * The file is validated field by field: a hand-edited or older file never
 * breaks the app, an unusable field just falls back to its default.
 *
 * `AGENTREE_HOME` is the one location that is NOT a setting: the settings
 * live there.
 */
export const agentreeHome = () => process.env.AGENTREE_HOME || path.join(os.homedir(), ".agentree");
export const settingsFile = () => path.join(agentreeHome(), "settings.json");

export const DEFAULT_SETTINGS: Settings = {
  sortBy: "active",
  providers: { claude: true, codex: true, copilot: true },
  showArchivedCodex: false,
  rememberView: true,
  paths: {},
  updateCheck: true,
};

/** The environment variable each path setting stands in for; set, it wins. */
export const PATH_ENV: Record<keyof SettingsPaths, string> = {
  claudeConfigDir: "CLAUDE_CONFIG_DIR",
  codexHome: "CODEX_HOME",
  copilotHome: "COPILOT_HOME",
  codexBin: "AGENTREE_CODEX_BIN",
};

const PROVIDERS: ProviderId[] = ["claude", "codex", "copilot"];
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
/** Only absolute paths: a relative one would resolve against the worker's cwd. */
const absPath = (v: unknown) => (typeof v === "string" && v.trim() && path.isAbsolute(v.trim()) ? v.trim() : undefined);

function viewOf(v: unknown): ViewState | undefined {
  if (!isObj(v)) return undefined;
  return {
    compress: bool(v.compress, true),
    cwdFilter: typeof v.cwdFilter === "string" ? v.cwdFilter : "",
    providerFilter: PROVIDERS.includes(v.providerFilter as ProviderId) ? (v.providerFilter as ProviderId) : "",
  };
}

/** Whatever was on disk, as valid settings: each field on its own, defaulting when unusable. */
export function validate(raw: unknown): Settings {
  const r = isObj(raw) ? raw : {};
  const providers = isObj(r.providers) ? r.providers : {};
  const paths = isObj(r.paths) ? r.paths : {};
  const out: Settings = {
    sortBy: r.sortBy === "touched" ? "touched" : "active",
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, bool(providers[p], true)])) as Settings["providers"],
    showArchivedCodex: bool(r.showArchivedCodex, DEFAULT_SETTINGS.showArchivedCodex),
    rememberView: bool(r.rememberView, DEFAULT_SETTINGS.rememberView),
    paths: {},
    updateCheck: bool(r.updateCheck, DEFAULT_SETTINGS.updateCheck),
  };
  // Remembering off means no view is kept — whatever order the renderer's
  // writes arrive in, a late view save can't bring one back.
  const view = viewOf(r.view);
  if (view && out.rememberView) out.view = view;
  if (typeof r.openForkInChat === "boolean") out.openForkInChat = r.openForkInChat;
  for (const k of Object.keys(PATH_ENV) as (keyof SettingsPaths)[]) {
    const p = absPath(paths[k]);
    if (p) out.paths[k] = p;
  }
  return out;
}

/**
 * Cached by the file's identity, so the paths every scan asks for cost one
 * stat — and a write from the other host's worker is picked up.
 */
let cache: { key: string; settings: Settings } | null = null;

export function readSettings(): Settings {
  const file = settingsFile();
  let key = `${file}:none`;
  try {
    const st = fs.statSync(file);
    key = `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    /* no file: defaults */
  }
  if (cache?.key === key) return cache.settings;
  let raw: unknown = {};
  if (!key.endsWith(":none")) {
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      /* torn or hand-broken: defaults, field by field */
    }
  }
  cache = { key, settings: validate(raw) };
  return cache.settings;
}

/** Apply a patch and persist it (write-then-rename). Returns the new settings. */
export function writeSettings(patch: SettingsPatch): Settings {
  const cur = readSettings();
  const next: Record<string, unknown> = {
    ...cur,
    ...patch,
    providers: { ...cur.providers, ...patch.providers },
    paths: { ...cur.paths, ...patch.paths },
  };
  // A cleared field travels as null; drop it rather than store it.
  if (patch.view === null) delete next.view;
  if (patch.openForkInChat === null) delete next.openForkInChat;
  const settings = validate(next);
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  fs.renameSync(tmp, file);
  cache = null;
  return readSettings();
}

/** A path setting, after its environment variable: env > settings > undefined (caller's default). */
export function configuredPath(key: keyof SettingsPaths): string | undefined {
  return process.env[PATH_ENV[key]] || readSettings().paths[key];
}

export function settingsState(): SettingsState {
  const env: SettingsState["env"] = {};
  for (const [k, v] of Object.entries(PATH_ENV) as [keyof SettingsPaths, string][]) {
    if (process.env[v]) env[k] = process.env[v];
  }
  return {
    settings: readSettings(),
    env,
    updateCheckDisabledByEnv: !!process.env.AGENTREE_NO_UPDATE_CHECK,
    file: settingsFile(),
  };
}
