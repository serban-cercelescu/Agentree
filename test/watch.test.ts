import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { watchTranscripts } from "../electron/watch.ts";

describe("live view of a root that doesn't exist yet", () => {
  it("starts watching once it appears, and reports what was written there", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-watch-"));
    const polled = path.join(tmp, "copilot", "session-state");
    const watched = path.join(tmp, "claude", "projects");
    const changes = { polled: 0, watched: 0 };
    const a = watchTranscripts([{ kind: "dir", path: polled, poll: true }], () => changes.polled++);
    const b = watchTranscripts([{ kind: "dir", path: watched, poll: false }], () => changes.watched++);
    try {
      fs.mkdirSync(path.join(polled, "s1"), { recursive: true });
      fs.writeFileSync(path.join(polled, "s1", "events.jsonl"), "{}\n");
      fs.mkdirSync(path.join(watched, "c--work"), { recursive: true });
      fs.writeFileSync(path.join(watched, "c--work", "s.jsonl"), "{}\n");
      await vi.waitFor(
        () => {
          expect(changes.polled).toBeGreaterThan(0);
          expect(changes.watched).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 100 },
      );

      // And it is a normal watch from then on.
      const seen = changes.polled;
      fs.writeFileSync(path.join(polled, "s1", "events.jsonl"), "{}\n{}\n");
      await vi.waitFor(() => expect(changes.polled).toBeGreaterThan(seen), { timeout: 5000, interval: 100 });
    } finally {
      a.close();
      b.close();
    }
  }, 15_000);
});
