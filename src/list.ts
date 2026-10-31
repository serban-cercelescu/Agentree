import { cwdKey } from "../shared/render.ts";
import type { ForkSummary, ProviderId, SessionMeta } from "../shared/types.ts";

/**
 * The welcome list's filtering and directory rail, kept apart from the
 * component so the rules can be tested without a DOM.
 */

/**
 * The directories a family belongs to, as recorded, one per distinct
 * `cwdKey`: its root's and every fork's. A fork made in another repo shows
 * the family under that repo too.
 */
export function dirsOf(s: SessionMeta): string[] {
  const out = new Map<string, string>();
  for (const d of [s.cwd, ...(s.forks ?? []).map((f) => f.cwd)]) {
    if (d && !out.has(cwdKey(d))) out.set(cwdKey(d), d);
  }
  return [...out.values()];
}

const matchesRoot = (s: SessionMeta, q: string) =>
  s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.startsWith(q);
const matchesFork = (f: ForkSummary, q: string) => f.title.toLowerCase().includes(q) || f.id.startsWith(q);

/** The forks of `s` the search matched (none for an empty search). */
export function forkMatches(s: SessionMeta, query: string): ForkSummary[] {
  const q = query.trim().toLowerCase();
  return q ? (s.forks ?? []).filter((f) => matchesFork(f, q)) : [];
}

/**
 * Which session to open a card on: the family's own tip, unless the search
 * matched only a fork — then that fork, so the tree lands on what was found.
 */
export function focusFor(s: SessionMeta, query: string): string | undefined {
  const q = query.trim().toLowerCase();
  if (!q || matchesRoot(s, q)) return undefined;
  return forkMatches(s, query)[0]?.id;
}

/** How many fork names a card shows before "+N". */
export const FORKS_SHOWN = 3;

/** The fork names a card shows, matches first, then newest activity. */
export function shownForks(s: SessionMeta, query: string): { shown: ForkSummary[]; more: number; matched: Set<string> } {
  const forks = s.forks ?? [];
  const matched = new Set(forkMatches(s, query).map((f) => f.id));
  const ordered = [...forks.filter((f) => matched.has(f.id)), ...forks.filter((f) => !matched.has(f.id))];
  const shown = ordered.slice(0, Math.max(FORKS_SHOWN, matched.size));
  return { shown, more: forks.length - shown.length, matched };
}

export interface RailDir {
  /** `cwdKey` — what the filter stores and compares. */
  key: string;
  /** Shown as recorded, in the spelling of the directory's most recent session. */
  path: string;
  n: number;
}

/** Which time the list sorts and dates by (the "sort conversations by" setting). */
export type SortBy = "active" | "touched";
export const timeOf = (s: { activeAt: number; touchedAt: number }, by: SortBy = "active") =>
  by === "touched" ? s.touchedAt : s.activeAt;

/** Directories ranked by their most recent conversation, so the rail reads in the list's order. */
export function railDirs(sessions: SessionMeta[], by: SortBy = "active"): RailDir[] {
  const dirs = new Map<string, RailDir & { latest: number }>();
  for (const s of sessions) {
    for (const path of dirsOf(s)) {
      const key = cwdKey(path);
      const d = dirs.get(key);
      const t = timeOf(s, by);
      if (!d) dirs.set(key, { key, path, n: 1, latest: t });
      else {
        d.n++;
        if (t > d.latest) {
          d.latest = t;
          d.path = path;
        }
      }
    }
  }
  return [...dirs.values()].sort((a, b) => b.latest - a.latest).map(({ key, path, n }) => ({ key, path, n }));
}

export interface ListFilter {
  query: string;
  /** A `cwdKey`, or "" for every directory. */
  cwd: string;
  /** One agent, or "" for all of them. */
  provider: ProviderId | "";
  /** Newest first by this time; activity unless the settings say otherwise. */
  sortBy?: SortBy;
}

/** The sessions of the selected agent — what the rail counts and the list draws from. */
export const ofProvider = (sessions: SessionMeta[], provider: ProviderId | "") =>
  provider ? sessions.filter((s) => s.provider === provider) : sessions;

/** The list as shown: filtered, newest activity first. */
export function filterSessions(sessions: SessionMeta[], f: ListFilter): SessionMeta[] {
  const q = f.query.trim().toLowerCase();
  const list = ofProvider(sessions, f.provider).filter((s) => {
    if (f.cwd && !dirsOf(s).some((d) => cwdKey(d) === f.cwd)) return false;
    if (!q) return true;
    // Every chat in the family is searchable: a fork's own title is often
    // the more descriptive one.
    return matchesRoot(s, q) || (s.forks ?? []).some((f) => matchesFork(f, q));
  });
  // `listSessions` already sorts this way, but the ordering is the point of
  // the screen, so don't rely on it holding.
  return [...list].sort((a, b) => timeOf(b, f.sortBy) - timeOf(a, f.sortBy));
}
