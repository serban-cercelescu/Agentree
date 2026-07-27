import type { AgentreeApi } from "../shared/types.ts";

declare global {
  interface Window {
    agentree: AgentreeApi;
  }
}

/**
 * Everything crosses the Electron contextBridge — there is no HTTP server and
 * no localhost port, and the renderer has no Node access of its own.
 */
export const api: AgentreeApi = window.agentree;
