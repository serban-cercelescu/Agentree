import { useEffect, useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../api.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import type { ProviderId, SettingsPaths } from "../../shared/types.ts";

const AGENTS: { id: ProviderId; name: string }[] = [
  { id: "claude", name: "Claude Code" },
  { id: "codex", name: "Codex" },
  { id: "copilot", name: "Copilot CLI" },
];

const PATHS: { key: keyof SettingsPaths; label: string; env: string; placeholder: string }[] = [
  { key: "claudeConfigDir", label: "Claude Code config", env: "CLAUDE_CONFIG_DIR", placeholder: "~/.claude" },
  { key: "codexHome", label: "Codex home", env: "CODEX_HOME", placeholder: "~/.codex" },
  { key: "copilotHome", label: "Copilot home", env: "COPILOT_HOME", placeholder: "~/.copilot" },
  {
    key: "codexBin",
    label: "codex binary (for forks)",
    env: "AGENTREE_CODEX_BIN",
    placeholder: "found in the Codex VS Code extension, then PATH",
  },
];

/**
 * A path field: saved on blur or Enter, cleared when emptied. A save that
 * fails keeps what was typed, marked as not saved, until a retry succeeds.
 */
function PathField({ k, value, env }: { k: keyof SettingsPaths; value: string; env?: string }) {
  const { saveSettings } = useStore();
  const [draft, setDraft] = useState(value);
  const [unsaved, setUnsaved] = useState(false);
  useEffect(() => {
    setDraft(value);
    setUnsaved(false);
  }, [value]);
  const def = PATHS.find((p) => p.key === k)!;
  const commit = async () => {
    const v = draft.trim();
    if (v === value) return setUnsaved(false);
    setUnsaved(!(await saveSettings({ paths: { [k]: v || null } })));
  };
  return (
    <label className="settings-path">
      <span>{def.label}</span>
      <input
        value={env ?? draft}
        disabled={!!env}
        placeholder={def.placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value);
            setUnsaved(false);
          }
        }}
      />
      {env ? (
        <span className="muted small">Set by {def.env}, which wins over this setting.</span>
      ) : unsaved ? (
        <span className="error-text small">Not saved — still {value || "the default"}. Press Enter to retry.</span>
      ) : (
        draft.trim() && !/^([a-zA-Z]:[\\/]|[\\/])/.test(draft.trim()) && (
          <span className="error-text small">Use an absolute path; a relative one is ignored.</span>
        )
      )}
    </label>
  );
}

/**
 * The settings panel. Every setting changes what you see or where data
 * lives; none changes how a transcript is read. Saved as you change them.
 */
export function Settings() {
  const { settings: state, saveSettings, set, settingsError } = useStore();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && set({ settingsOpen: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [set]);
  if (!state) return null;
  const s = state.settings;
  const openForks = s.openForkInChat ?? api.host === "vscode";

  return (
    <div className="settings-backdrop" onClick={() => set({ settingsOpen: false })}>
      <div className="settings" role="dialog" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="ghost" onClick={() => set({ settingsOpen: false })} aria-label="Close settings">
            ✕
          </button>
        </div>
        <ErrorBanner
          message={settingsError && `Not saved: ${settingsError}`}
          onDismiss={() => set({ settingsError: null })}
        />

        <section>
          <h3>Conversation list</h3>
          <div className="settings-row">
            <span>Sort conversations by</span>
            <label>
              <input type="radio" checked={s.sortBy === "active"} onChange={() => void saveSettings({ sortBy: "active" })} />{" "}
              last message or tool activity
            </label>
            <label>
              <input type="radio" checked={s.sortBy === "touched"} onChange={() => void saveSettings({ sortBy: "touched" })} />{" "}
              last file change
            </label>
          </div>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.showArchivedCodex}
              onChange={(e) => void saveSettings({ showArchivedCodex: e.target.checked })}
            />{" "}
            Show archived Codex conversations
          </label>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={s.rememberView}
              onChange={(e) => {
                const { compress, cwdFilter, providerFilter } = useStore.getState();
                void saveSettings({
                  rememberView: e.target.checked,
                  view: e.target.checked ? { compress, cwdFilter, providerFilter } : null,
                });
              }}
            />{" "}
            Remember compress-chains, the directory and the agent filter between launches
          </label>
        </section>

        <section>
          <h3>Agents to scan</h3>
          <p className="muted small">An agent that's off isn't read at all. The chips above the list only filter.</p>
          {AGENTS.map((a) => (
            <label key={a.id} className="settings-check">
              <input
                type="checkbox"
                checked={s.providers[a.id]}
                onChange={(e) => void saveSettings({ providers: { [a.id]: e.target.checked } })}
              />{" "}
              {a.name}
            </label>
          ))}
        </section>

        <section>
          <h3>Forks</h3>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={openForks}
              onChange={(e) => void saveSettings({ openForkInChat: e.target.checked })}
            />{" "}
            Open a new fork in the agent's chat panel{api.host === "vscode" ? "" : " (in VS Code)"} right away
          </label>
        </section>

        <section>
          <h3>Data locations</h3>
          <p className="muted small">Empty means the default. An environment variable, when set, still wins.</p>
          {PATHS.map((p) => (
            <PathField key={p.key} k={p.key} value={s.paths[p.key] ?? ""} env={state.env[p.key]} />
          ))}
        </section>

        {api.host === "electron" && (
          <section>
            <h3>Updates</h3>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={s.updateCheck && !state.updateCheckDisabledByEnv}
                disabled={state.updateCheckDisabledByEnv}
                onChange={(e) => void saveSettings({ updateCheck: e.target.checked })}
              />{" "}
              Check for a newer build at launch
              {state.updateCheckDisabledByEnv && <span className="muted small"> (off: AGENTREE_NO_UPDATE_CHECK is set)</span>}
            </label>
          </section>
        )}

        <p className="muted small settings-file">
          Saved in <code>{state.file}</code>
        </p>
      </div>
    </div>
  );
}
