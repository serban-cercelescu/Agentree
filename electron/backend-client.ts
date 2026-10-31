import { Worker } from "node:worker_threads";
import type { MethodName, Methods } from "./backend.ts";

/** Each backend call, as the host sees it: same arguments, always async. */
export type Backend = {
  [K in MethodName]: (...args: Parameters<Methods[K]>) => Promise<Awaited<ReturnType<Methods[K]>>>;
} & { dispose(): void };

/**
 * The worker's method names, for building the proxy. The host may import
 * `backend.ts` for its types only (a runtime import would bundle the
 * providers into the host), so the names are restated here — as a record
 * over `MethodName`, which the compiler checks for completeness: a method
 * added to the worker and not here is a type error, not a missing function.
 */
const METHOD_NAMES = {
  listSessions: true,
  getSession: true,
  patchNode: true,
  forkAt: true,
  providerHealth: true,
  watchTargets: true,
  resumeLaunch: true,
  getSettings: true,
  setSettings: true,
} satisfies Record<MethodName, true>;

type Pending = Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;

/**
 * The host's handle on the backend worker (`worker.cjs`, built next to the
 * host bundle). The worker is started on first use and restarted on the next
 * call if it ever dies; a crash fails the calls in flight with its error
 * instead of leaving them hanging.
 *
 * Calls belong to the worker GENERATION they were sent to. A dying worker
 * emits `error` and then `exit`; a caller that retries on the first event
 * lands on a new worker, and the old one's late `exit` must not fail that
 * retry. So each worker fails only its own pending calls. `dispose` is final.
 */
export function startBackend(workerFile: string): Backend {
  let current: { worker: Worker; pending: Pending } | null = null;
  let disposed = false;
  let seq = 0;

  const failAll = (pending: Pending, e: Error) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };

  const get = () => {
    if (current) return current;
    const gen = { worker: new Worker(workerFile), pending: new Map() as Pending };
    gen.worker.on("message", (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = gen.pending.get(m.id);
      if (!p) return;
      gen.pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    });
    const die = (e: Error) => {
      if (current === gen) current = null;
      failAll(gen.pending, e);
    };
    gen.worker.on("error", (e) => die(e instanceof Error ? e : new Error(String(e))));
    gen.worker.on("exit", (code) => die(new Error(`Agentree's backend stopped (exit ${code}).`)));
    current = gen;
    return gen;
  };

  const call = (method: MethodName, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      if (disposed) {
        reject(new Error("Agentree's backend was closed."));
        return;
      }
      const id = ++seq;
      let gen: ReturnType<typeof get> | undefined;
      try {
        gen = get();
        gen.pending.set(id, { resolve, reject });
        gen.worker.postMessage({ id, method, args });
      } catch (e) {
        // A worker that can't start, or a message that can't be cloned.
        gen?.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

  const proxy = {} as Record<MethodName, (...a: unknown[]) => Promise<unknown>>;
  for (const m of Object.keys(METHOD_NAMES) as MethodName[]) {
    proxy[m] = (...args) => call(m, args);
  }

  return {
    ...(proxy as unknown as Omit<Backend, "dispose">),
    dispose() {
      disposed = true;
      const gen = current;
      current = null;
      if (gen) {
        failAll(gen.pending, new Error("Agentree's backend was closed."));
        void gen.worker.terminate();
      }
    },
  };
}
