/// <reference lib="dom" />
import { contextBridge, ipcRenderer } from "electron";
import { CH } from "./ipc.ts";
import type { AgentreeApi, NodeMeta, SettingsPatch } from "../shared/types.ts";

/**
 * The entire renderer→main surface. Nothing else crosses: no `require`, no
 * `fs`, no arbitrary channel names.
 */
const api: AgentreeApi = {
  listSessions: () => ipcRenderer.invoke(CH.listSessions),
  getSession: (id) => ipcRenderer.invoke(CH.getSession, id),
  patchNode: (sessionId, nodeId, patch: NodeMeta) =>
    ipcRenderer.invoke(CH.patchNode, sessionId, nodeId, patch),
  forkAt: (sessionId, point) => ipcRenderer.invoke(CH.forkAt, sessionId, point),
  providerHealth: () => ipcRenderer.invoke(CH.providerHealth),
  getSettings: () => ipcRenderer.invoke(CH.getSettings),
  setSettings: (patch: SettingsPatch) => ipcRenderer.invoke(CH.setSettings, patch),

  host: "electron",
  openNative: (ref) => ipcRenderer.invoke(CH.openNative, ref),
  resumeInTerminal: (ref) => ipcRenderer.invoke(CH.resumeInTerminal, ref),

  onUpdateAvailable: (cb) => {
    const listener = (_e: unknown, info: Parameters<typeof cb>[0]) => cb(info);
    ipcRenderer.on(CH.updateAvailable, listener);
    return () => ipcRenderer.off(CH.updateAvailable, listener);
  },

  watch: (sessionId, onChange) => {
    // A token, not the session id: `null` (watch everything) is a legitimate
    // subscription too, and two views of the same session must unsubscribe
    // independently.
    const token = `w${++watchSeq}`;
    const listener = (_e: unknown, t: string) => {
      if (t === token) onChange(sessionId);
    };
    ipcRenderer.on(CH.changed, listener);
    void ipcRenderer.invoke(CH.watchStart, token, sessionId);
    return () => {
      ipcRenderer.off(CH.changed, listener);
      void ipcRenderer.invoke(CH.watchStop, token);
    };
  },
};

let watchSeq = 0;

// The page styles for the OS it runs on — macOS reserves room for the inset
// traffic lights, which other platforms don't have.
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.dataset.platform = process.platform;
});

contextBridge.exposeInMainWorld("agentree", api);
