import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readSettings, settingsFile, settingsState, writeSettings } from "../electron/settings.ts";
import { claudeProjects, codexHome } from "../electron/paths.ts";
import { allHealth, listAllSessions } from "../electron/registry.ts";

const T13 = "01900000-0000-7000-8000-00000000000d";
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-settings-"));
  process.env.AGENTREE_HOME = path.join(tmp, "agentree");
  // The fixtures, read-only: listing never writes to a harness store.
  process.env.CLAUDE_CONFIG_DIR = path.join(__dirname, "fixtures", "claude", "2.1");
  process.env.CODEX_HOME = path.join(__dirname, "fixtures", "codex", "0.162", "home");
  process.env.COPILOT_HOME = path.join(tmp, "no-copilot");
});

describe("settings store", () => {
  it("defaults without a file, and round-trips a change", () => {
    expect(readSettings()).toMatchObject({ sortBy: "active", rememberView: true, providers: { claude: true, codex: true } });
    writeSettings({ sortBy: "touched", providers: { copilot: false }, view: { compress: false, cwdFilter: "c:/x", providerFilter: "codex" } });
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8"))).toMatchObject({
      sortBy: "touched",
      providers: { claude: true, codex: true, copilot: false },
      view: { compress: false, cwdFilter: "c:/x", providerFilter: "codex" },
    });
    // null clears an optional field.
    expect(writeSettings({ view: null }).view).toBeUndefined();
  });

  it("keeps no remembered view while remembering is off, whichever write lands last", () => {
    const view = { compress: false, cwdFilter: "", providerFilter: "claude" as const };
    writeSettings({ rememberView: false, view: null });
    // A view save that was already on its way.
    expect(writeSettings({ view }).view).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(settingsFile(), "utf8")).view).toBeUndefined();
    expect(writeSettings({ rememberView: true, view }).view).toEqual(view);
  });

  it("falls back field by field on a broken or hand-edited file", () => {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), "{not json");
    expect(readSettings().sortBy).toBe("active");
    fs.writeFileSync(
      settingsFile(),
      JSON.stringify({ sortBy: "sideways", providers: { codex: "no" }, showArchivedCodex: true, paths: { codexHome: "relative/dir" } }),
    );
    const s = readSettings();
    expect(s).toMatchObject({ sortBy: "active", showArchivedCodex: true, providers: { codex: true } });
    expect(s.paths.codexHome).toBeUndefined();
  });

  it("uses a path setting only when its environment variable isn't set", () => {
    const dir = path.join(tmp, "elsewhere");
    writeSettings({ paths: { claudeConfigDir: dir, codexHome: dir } });
    // CLAUDE_CONFIG_DIR is set: it wins, and the panel is told so.
    expect(claudeProjects()).toBe(path.join(process.env.CLAUDE_CONFIG_DIR!, "projects"));
    expect(settingsState().env.claudeConfigDir).toBe(process.env.CLAUDE_CONFIG_DIR);
    delete process.env.CODEX_HOME;
    expect(codexHome()).toBe(dir);
    expect(settingsState().env.codexHome).toBeUndefined();
  });
});

describe("settings applied to the scan", () => {
  it("skips an agent that is turned off: not listed, no health row", () => {
    expect(listAllSessions().some((s) => s.provider === "codex")).toBe(true);
    writeSettings({ providers: { codex: false } });
    expect(listAllSessions().some((s) => s.provider === "codex")).toBe(false);
    expect(allHealth().map((h) => h.provider)).not.toContain("codex");
  });

  it("lists an all-archived Codex family only when asked to", () => {
    expect(listAllSessions().some((s) => s.id === T13)).toBe(false);
    writeSettings({ showArchivedCodex: true });
    expect(listAllSessions().find((s) => s.id === T13)).toMatchObject({ archived: true });
  });
});
