import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import { forkThread } from "../electron/providers/codex-appserver.ts";
import { writeSettings } from "../electron/settings.ts";
import { AGENTREE_VERSION } from "../electron/version.ts";
import baseline from "../scripts/upstream/baseline.json";

/**
 * The real client against a fake `codex app-server` (test/fake-codex): the
 * spawn, the initialize handshake, the request, and the ways a server process
 * goes wrong. The fork's request shape against the REAL server was verified
 * by hand on codex-cli 0.164 (see docs/design.md, "Codex fork"); this keeps the
 * client's own behaviour from regressing.
 */
const dir = path.join(__dirname, "fake-codex");
const run = (mode: string) => {
  process.env.FAKE_CODEX_MODE = mode;
  return forkThread({ threadId: "t-1", lastTurnId: "turn-1" });
};

beforeAll(() => {
  // Settings are read for the binary and the Codex home; keep them disposable.
  process.env.AGENTREE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-appserver-"));
  // Windows reaches the script through a .cmd shim (as npm installs codex)
  // whose path has a space, so cmd.exe's quoting is exercised too.
  if (process.platform === "win32") {
    process.env.AGENTREE_CODEX_BIN = path.join(dir, "fake codex.cmd");
  } else {
    const bin = path.join(dir, "fake-codex.mjs");
    fs.chmodSync(bin, 0o755);
    process.env.AGENTREE_CODEX_BIN = bin;
  }
});

describe("codex app-server client", () => {
  it("initializes, then sends thread/fork with exactly threadId, lastTurnId, excludeTurns", async () => {
    const res = await run("ok");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.threadId).toBe("fake-thread");
    // The fake echoes the params back as the cwd.
    expect(JSON.parse(res.cwd)).toEqual({ threadId: "t-1", lastTurnId: "turn-1", excludeTurns: true });
  });

  it("sends exactly the messages the upstream watch validates against Codex's schema", async () => {
    process.env.FAKE_CODEX_MODE = "wire";
    const fork = baseline.codex.requests["thread/fork"];
    const res = await forkThread({ threadId: fork.threadId, lastTurnId: fork.lastTurnId });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { initialize } = baseline.codex.requests;
    // The version is the build's; baseline.json can't state it.
    const sent = { ...initialize, clientInfo: { ...initialize.clientInfo, version: AGENTREE_VERSION } };
    expect(JSON.parse(res.cwd)).toEqual([
      { method: "initialize", params: sent },
      ...baseline.codex.notifications.map((method) => ({ method })),
      { method: "thread/fork", params: fork },
    ]);
  });

  const replied = (reply: unknown) => {
    process.env.FAKE_CODEX_REPLY = JSON.stringify(reply);
    return run("reply");
  };

  it("works with the smallest answer the upstream watch holds Codex to", async () => {
    const { least } = baseline.codex.forkResponse;
    expect(await replied(least)).toEqual({ ok: true, threadId: least.thread.id, cwd: "" });
  });

  it("takes the first usable cwd, as the watch allows", async () => {
    const thread = { id: "t", cwd: "/thread" };
    expect(await replied({ thread, cwd: "/top" })).toMatchObject({ cwd: "/top" });
    expect(await replied({ thread, cwd: null })).toMatchObject({ cwd: "/thread" });
    expect(await replied({ thread, cwd: 7 })).toMatchObject({ cwd: "/thread" });
    expect(await replied({ thread: { id: "t", cwd: {} } })).toMatchObject({ ok: true, cwd: "" });
  });

  it("refuses an answer that doesn't identify the fork, whatever it holds instead", async () => {
    for (const thread of [null, undefined, "t", {}, { id: "" }, { id: 7 }, { id: null }, { id: {} }]) {
      expect(await replied({ thread })).toEqual({ ok: false, error: "codex app-server returned no thread for the fork." });
    }
  });

  it("starts the server on the Codex home Agentree reads, even when only a setting names it", async () => {
    const env = process.env.CODEX_HOME;
    delete process.env.CODEX_HOME;
    const saved = path.join(os.tmpdir(), "a saved codex home");
    try {
      expect(await run("env")).toMatchObject({ ok: true, cwd: "(unset)" });
      writeSettings({ paths: { codexHome: saved } });
      expect(await run("env")).toMatchObject({ ok: true, cwd: saved });
      // The variable still wins over the setting, for Agentree and the server alike.
      process.env.CODEX_HOME = path.join(os.tmpdir(), "from env");
      expect(await run("env")).toMatchObject({ ok: true, cwd: process.env.CODEX_HOME });
    } finally {
      writeSettings({ paths: { codexHome: null } });
      if (env === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = env;
    }
  });

  it("surfaces a JSON-RPC error as the fork's error", async () => {
    expect(await run("error")).toEqual({ ok: false, error: "fork refused" });
  });

  it("fails at once when the server exits with a request outstanding", async () => {
    const t0 = Date.now();
    const res = await run("exit");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatch(/exited/);
    expect(Date.now() - t0).toBeLessThan(10_000); // not the 60 s request timeout
  });
});
