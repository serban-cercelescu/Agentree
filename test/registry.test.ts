import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "../shared/types.ts";

// Disposable homes before any provider is imported: the fixtures, read-only.
vi.hoisted(() => {
  const p = require("node:path") as typeof import("node:path");
  const tmp = (require("node:fs") as typeof import("node:fs")).mkdtempSync(
    p.join((require("node:os") as typeof import("node:os")).tmpdir(), "agentree-registry-"),
  );
  process.env.AGENTREE_HOME = p.join(tmp, "agentree");
  process.env.CLAUDE_CONFIG_DIR = p.join(__dirname, "fixtures", "claude", "2.1");
  process.env.CODEX_HOME = p.join(__dirname, "fixtures", "codex", "0.162", "home");
  process.env.COPILOT_HOME = p.join(tmp, "no-copilot");
});

const entry = (activeAt: number, title: string): SessionMeta => ({
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  provider: "claude",
  cwd: "",
  project: "",
  title,
  activeAt,
  touchedAt: activeAt,
  nodeCount: 1,
  branchPoints: 0,
  resumeCommand: "",
});

// A provider that regressed: the same session twice. Claude's discovery
// functions are spied on, to show a disabled provider is never asked.
vi.mock("../electron/transcripts.ts", async (orig) => {
  const real = await orig<typeof import("../electron/transcripts.ts")>();
  return {
    ...real,
    listSessions: () => [entry(1, "older"), entry(2, "newer")],
    locate: vi.fn(real.locate),
    claudeWatchDirs: vi.fn(real.claudeWatchDirs),
  };
});
vi.mock("../electron/providers/codex.ts", async (orig) => ({
  ...(await orig<typeof import("../electron/providers/codex.ts")>()),
  listCodexSessions: () => [],
}));
vi.mock("../electron/providers/copilot.ts", async (orig) => ({
  ...(await orig<typeof import("../electron/providers/copilot.ts")>()),
  listCopilotSessions: () => [],
}));

const { listAllSessions, watchTargets } = await import("../electron/registry.ts");
const { writeSettings } = await import("../electron/settings.ts");
const claude = await import("../electron/transcripts.ts");

describe("registry list", () => {
  it("never lists one provider:id twice, and keeps the newer entry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = listAllSessions();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("newer");
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("watch targets", () => {
  const P = "11111111-1111-4111-8111-111111111111";
  const T1 = "01900000-0000-7000-8000-000000000001";

  it("watches a session's own provider, and never asks a disabled one", () => {
    expect(watchTargets(P).map((t) => path.basename(t.path))).toEqual(["c--work-demo"]);
    writeSettings({ providers: { claude: false } });
    vi.mocked(claude.locate).mockClear();
    vi.mocked(claude.claudeWatchDirs).mockClear();

    expect(watchTargets(P)).toEqual([]);
    expect(watchTargets(T1).map((t) => t.kind)).toEqual(["dir", "dir", "file"]);
    expect(watchTargets(null).some((t) => t.path.includes(`${path.sep}projects`))).toBe(false);
    expect(claude.locate).not.toHaveBeenCalled();
    expect(claude.claudeWatchDirs).not.toHaveBeenCalled();
    writeSettings({ providers: { claude: true } });
  });
});
