import fs from "node:fs";
import type { ProviderHealth, ProviderId } from "../shared/types.ts";

/**
 * Accumulates what one provider scan saw, for the welcome screen's status row.
 *
 * Built fresh on every scan and published when the scan finishes, so the row
 * always describes the list it sits above. Counting unknown record types is the
 * early-warning half: when a harness adds or renames a record kind, the count
 * shows up here the same day instead of as quietly missing turns.
 */
export class HealthScan {
  private h: ProviderHealth;

  constructor(provider: ProviderId, root: string, backend: ProviderHealth["backend"] = "raw") {
    this.h = {
      provider,
      root,
      present: fs.existsSync(root),
      filesSeen: 0,
      skipped: 0,
      sessionsParsed: 0,
      failed: 0,
      listed: 0,
      formatVersions: {},
      unknownRecordTypes: {},
      backend,
      warnings: [],
    };
  }

  file(): void {
    this.h.filesSeen++;
  }
  skipped(): void {
    this.h.skipped++;
  }
  parsed(): void {
    this.h.sessionsParsed++;
  }
  /**
   * A file that should have been a session and wasn't. Never fold this into
   * `skipped`: "nothing to show" and "couldn't understand it" look identical
   * in the list, and only the second one means the format moved.
   */
  failed(): void {
    this.h.failed++;
  }
  listed(n: number): void {
    this.h.listed = n;
  }
  version(v: string | undefined): void {
    if (!v) return;
    this.h.formatVersions[v] = (this.h.formatVersions[v] ?? 0) + 1;
  }
  unknown(types: Record<string, number>): void {
    for (const [t, n] of Object.entries(types)) {
      this.h.unknownRecordTypes[t] = (this.h.unknownRecordTypes[t] ?? 0) + n;
    }
  }
  warn(w: string): void {
    if (!this.h.warnings.includes(w)) this.h.warnings.push(w);
  }
  error(e: string): void {
    this.h.error = e;
  }

  done(): ProviderHealth {
    const h = this.h;
    // Every file lands in exactly one of skipped / parsed / failed, so the
    // candidates are the ones that were meant to be sessions.
    const candidates = h.sessionsParsed + h.failed;
    if (h.present && candidates > 0 && h.sessionsParsed / candidates < 0.5) {
      h.warnings.push(
        `Only ${h.sessionsParsed} of ${candidates} transcripts parsed — the on-disk format may have changed.`,
      );
    } else if (h.failed > 0) {
      h.warnings.push(
        `${h.failed} transcript${h.failed === 1 ? "" : "s"} couldn't be read or understood and ${h.failed === 1 ? "is" : "are"} not listed.`,
      );
    }
    return h;
  }
}

/** "0.162.0-alpha.17.2" → "0.162"; "2.1.296" → "2.1". Keeps the row short. */
export const minorVersion = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const m = /^(\d+)\.(\d+)/.exec(v);
  return m ? `${m[1]}.${m[2]}` : v.slice(0, 16);
};
