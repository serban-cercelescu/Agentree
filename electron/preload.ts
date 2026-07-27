import { contextBridge, ipcRenderer } from "electron";
import { CH } from "./ipc.ts";
import type { AgentreeApi, NodeMeta } from "../shared/types.ts";

/**
 * The entire renderer→main surface. Nothing else crosses: no `require`, no
 * `fs`, no arbitrary channel names.
 */
const api: AgentreeApi = {
  listSessions: () => ipcRenderer.invoke(CH.listSessions),
  getSession: (id) => ipcRenderer.invoke(CH.getSession, id),
  patchNode: (sessionId, nodeId, patch: NodeMeta) =>
    ipcRenderer.invoke(CH.patchNode, sessionId, nodeId, patch),
  forkAt: (sessionId, nodeId) => ipcRenderer.invoke(CH.forkAt, sessionId, nodeId),

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

contextBridge.exposeInMainWorld("agentree", api);
