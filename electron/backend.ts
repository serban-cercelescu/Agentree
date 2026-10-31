import type { ForkPoint, NodeMeta, ProviderId, SessionId, SettingsPatch } from "../shared/types.ts";
import { resumeLaunch } from "./launch.ts";
import { allHealth, annotate, forkAnyAt, listAllSessions, loadAnySession, watchTargets } from "./registry.ts";
import { settingsState, writeSettings } from "./settings.ts";

/**
 * Everything that touches the transcript stores, as one table of calls.
 *
 * It runs in a worker thread (`worker.ts`), never on the host's own thread:
 * a cold scan decompresses every Codex page and parses every Claude
 * transcript — ~2.6 s on the target machine — and the host thread is VS Code's
 * extension host (every extension stalls with it) or Electron's main process
 * (the window stops repainting). The worker keeps the parse caches, so a warm
 * call is as cheap as before; only the hop is new.
 *
 * Hosts reach it through `backend-client.ts`, which imports this file's TYPE
 * only — the providers are bundled into the worker, not into the host.
 */
export const methods = {
  listSessions: () => listAllSessions(),
  getSession: (id: SessionId) => loadAnySession(id),
  patchNode: (familyId: SessionId, nodeId: string, patch: NodeMeta) => annotate(familyId, nodeId, patch),
  forkAt: (sessionId: SessionId, point: ForkPoint) => forkAnyAt(sessionId, point),
  providerHealth: () => allHealth(),
  watchTargets: (sessionId: SessionId | null) => watchTargets(sessionId),
  // What a host runs to resume a session: argv plus the store's environment.
  resumeLaunch: (provider: ProviderId, sessionId: SessionId) => resumeLaunch(provider, sessionId),
  getSettings: () => settingsState(),
  setSettings: (patch: SettingsPatch) => {
    writeSettings(patch);
    return settingsState();
  },
};

export type Methods = typeof methods;
export type MethodName = keyof Methods;
