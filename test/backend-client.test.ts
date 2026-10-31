import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";
import { methods } from "../electron/backend.ts";
import { startBackend } from "../electron/backend-client.ts";

const FAKE = path.join(__dirname, "fake-worker.cjs");

describe("backend worker client", () => {
  it("a dying worker's late exit can't fail a retry already sent to its replacement", async () => {
    const b = startBackend(FAKE);
    try {
      // The worker dies: "error" fails the call, the caller retries at once
      // (a new worker), and only THEN does the old worker's "exit" arrive.
      let retry: Promise<unknown> | undefined;
      await b.getSession("crash").catch(() => {
        retry = b.getSession("after the crash");
      });
      expect(retry).toBeDefined();
      await expect(retry!).resolves.toBe("after the crash");
    } finally {
      b.dispose();
    }
  });

  it("reaches every worker method, resumeLaunch included, through the real built worker", async () => {
    // Built as the hosts ship it: the worker bundle, providers inside.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-worker-"));
    await build({
      entryPoints: [path.join(__dirname, "..", "electron", "worker.ts")],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: path.join(tmp, "worker.cjs"),
      logLevel: "silent",
    });
    // Disposable homes, set before the worker starts (it copies the environment).
    const saved = { ...process.env };
    Object.assign(process.env, {
      AGENTREE_HOME: path.join(tmp, "agentree"),
      CODEX_HOME: path.join(tmp, "codex"),
      CLAUDE_CONFIG_DIR: path.join(tmp, "claude"),
      COPILOT_HOME: path.join(tmp, "copilot"),
    });
    const b = startBackend(path.join(tmp, "worker.cjs"));
    try {
      for (const m of Object.keys(methods)) expect(typeof (b as Record<string, unknown>)[m], m).toBe("function");
      const id = "01900000-0000-7000-8000-000000000001";
      await expect(b.resumeLaunch("codex", id)).resolves.toEqual({
        argv: ["codex", "resume", id],
        env: { CODEX_HOME: path.join(tmp, "codex") },
      });
    } finally {
      b.dispose();
      process.env = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it("is final once disposed", async () => {
    const b = startBackend(FAKE);
    await expect(b.getSession("hello")).resolves.toBe("hello");
    const inFlight = b.getSession("never answered");
    b.dispose();
    await expect(inFlight).rejects.toThrow(/closed/);
    await expect(b.getSession("too late")).rejects.toThrow(/closed/);
  });
});
