import type { AgentreeApi } from "../../shared/types.ts";

/**
 * The webview-side half of the bridge: implements `window.agentree` — the
 * exact surface the Electron preload exposes — over VS Code's postMessage.
 * Loaded as a classic script BEFORE the app bundle, because src/api.ts reads
 * `window.agentree` at module evaluation time.
 */

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

const vscode = acquireVsCodeApi();

let seq = 0;
const pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
const watchers = new Map<string, () => void>();

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as
    | { kind: "result"; id: number; ok: true; value: never }
    | { kind: "result"; id: number; ok: false; error: string }
    | { kind: "changed"; token: string };
  if (m.kind === "result") {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
  } else if (m.kind === "changed") {
    watchers.get(m.token)?.();
  }
});

function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: resolve as (v: never) => void, reject });
    vscode.postMessage({ kind: "invoke", id, method, args });
  });
}

const api: AgentreeApi = {
  listSessions: () => invoke("listSessions"),
  getSession: (id) => invoke("getSession", id),
  patchNode: (sessionId, nodeId, patch) => invoke("patchNode", sessionId, nodeId, patch),
  forkAt: (sessionId, nodeId) => invoke("forkAt", sessionId, nodeId),

  // The launch-time GitHub build check is an Electron-app concern; the
  // extension updates through VS Code itself.
  onUpdateAvailable: () => () => {},

  watch: (sessionId, onChange) => {
    const token = `w${++seq}`;
    watchers.set(token, () => onChange(sessionId));
    vscode.postMessage({ kind: "watchStart", token, sessionId });
    return () => {
      watchers.delete(token);
      vscode.postMessage({ kind: "watchStop", token });
    };
  },
};

(window as unknown as { agentree: AgentreeApi }).agentree = api;
