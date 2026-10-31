import { parentPort } from "node:worker_threads";
import { methods, type MethodName } from "./backend.ts";

/**
 * Worker-thread entry for the backend (see backend.ts). One request at a time
 * per message; calls are independent, so they simply run as they arrive.
 */
parentPort!.on("message", async (m: { id: number; method: MethodName; args: unknown[] }) => {
  try {
    const fn = methods[m.method] as (...a: unknown[]) => unknown;
    if (!fn) throw new Error(`Unknown method: ${String(m.method)}`);
    const value = await fn(...m.args);
    parentPort!.postMessage({ id: m.id, ok: true, value });
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
