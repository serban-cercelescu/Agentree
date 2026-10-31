// Lives in src/ (not test/) so it type-checks with the renderer's DOM config.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StateCreator } from "zustand";
import type { SettingsState } from "../shared/types.ts";

const api = vi.hoisted(() => ({
  host: "vscode",
  listSessions: vi.fn(async () => []),
  providerHealth: vi.fn(async () => []),
  setSettings: vi.fn(),
}));
vi.mock("./api.ts", () => ({ api }));
// A server render reads a zustand store's INITIAL state; this hook renders
// the live one, so markup can be checked without a DOM.
vi.mock("zustand", async () => {
  const { createStore } = await import("zustand/vanilla");
  const { useSyncExternalStore } = await import("react");
  return {
    create: <T,>(init: StateCreator<T>) => {
      const store = createStore<T>(init);
      const read = () => store.getState();
      return Object.assign(() => useSyncExternalStore(store.subscribe, read, read), store);
    },
  };
});

const { useStore } = await import("./store.ts");
const { Welcome } = await import("./components/Welcome.tsx");

const state: SettingsState = {
  settings: {
    sortBy: "active",
    providers: { claude: true, codex: true, copilot: true },
    showArchivedCodex: false,
    rememberView: false,
    paths: {},
    updateCheck: true,
  },
  env: {},
  updateCheckDisabledByEnv: false,
  file: "settings.json",
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ settings: state, settingsError: null, error: null, settingsOpen: true });
});

describe("welcome screen and settings", () => {
  it("say a settings change wasn't saved, and stop saying so once a retry is", async () => {
    api.setSettings.mockRejectedValueOnce(new Error("EACCES: settings.json is read-only"));
    expect(await useStore.getState().saveSettings({ sortBy: "touched" })).toBe(false);
    expect(renderToStaticMarkup(<Welcome />)).toContain("Not saved: EACCES: settings.json is read-only");
    // The dialog closed, the welcome screen still says so.
    useStore.setState({ settingsOpen: false });
    expect(renderToStaticMarkup(<Welcome />)).toContain("Settings not saved: EACCES");

    api.setSettings.mockResolvedValueOnce(state);
    expect(await useStore.getState().saveSettings({ sortBy: "touched" })).toBe(true);
    expect(renderToStaticMarkup(<Welcome />)).not.toContain("not saved");
  });

  it("shows the list's own failures", () => {
    useStore.setState({ settingsOpen: false, error: "Error: worker exited" });
    expect(renderToStaticMarkup(<Welcome />)).toContain("Error: worker exited");
  });
});
