import { useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { when } from "../format.ts";
import logoUrl from "../../assets/logo.png";

/** `/Users/me/Personal/Agentree` → `~/Personal/Agentree`. */
function tilde(p: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p);
  return m ? "~" + (m[1] ?? "") : p;
}

/**
 * The welcome screen is a picker, not a landing page: a directory rail on the
 * left, one flat list of conversations on the right, newest interaction first.
 *
 * No refresh button — the main process watches ~/.claude/projects and pushes
 * changes, so the list is already live. No "only branched" filter — the ⑂
 * badge on each row carries that signal without hiding anything.
 */
/** Rail rows shown before the rest collapses behind "more". */
const RAIL_DIRS = 10;

export function Welcome() {
  const { sessions, filter, cwdFilter, loading, openSession, set } = useStore();
  const [moreOpen, setMoreOpen] = useState(false);

  // Directories ranked by their most recent conversation, so the rail reads in
  // the same order as the list: what you touched last is on top.
  const dirs = useMemo(() => {
    const latest = new Map<string, number>();
    const count = new Map<string, number>();
    for (const s of sessions) {
      if (!s.cwd) continue;
      latest.set(s.cwd, Math.max(latest.get(s.cwd) ?? 0, s.updatedAt));
      count.set(s.cwd, (count.get(s.cwd) ?? 0) + 1);
    }
    return [...latest.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cwd]) => ({ cwd, n: count.get(cwd) ?? 0 }));
  }, [sessions]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = sessions.filter((s) => {
      if (cwdFilter && s.cwd !== cwdFilter) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.cwd.toLowerCase().includes(q) ||
        s.id.startsWith(q)
      );
    });
    // Newest interaction first. `listSessions` already sorts this way, but the
    // ordering is the point of this screen, so don't rely on it holding.
    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions, filter, cwdFilter]);

  return (
    <div className="welcome">
      <aside className="dir-rail">
        <div className="rail-brand">
          <img className="logo" src={logoUrl} alt="" width={40} height={40} />
          <div>
            <h1>Agentree</h1>
            <p className="muted small">conversation trees</p>
          </div>
        </div>

        <nav className="dir-list">
          <button
            className={`dir-row ${cwdFilter === "" ? "active" : ""}`}
            onClick={() => set({ cwdFilter: "" })}
          >
            <span className="dir-name">All conversations</span>
            <span className="dir-count">{sessions.length}</span>
          </button>

          <div className="rail-label muted small">recent directories</div>

          {(() => {
            const recent = dirs.slice(0, RAIL_DIRS);
            const rest = dirs.slice(RAIL_DIRS);
            // A selection from inside the collapsed set stays visible even
            // when the menu is shut — hiding the active filter would leave the
            // list narrowed with nothing in the rail saying why.
            const pinned =
              !moreOpen && cwdFilter && rest.some((d) => d.cwd === cwdFilter)
                ? rest.filter((d) => d.cwd === cwdFilter)
                : [];

            const row = ({ cwd, n }: { cwd: string; n: number }) => (
              <button
                key={cwd}
                className={`dir-row ${cwdFilter === cwd ? "active" : ""}`}
                title={tilde(cwd)}
                onClick={() => set({ cwdFilter: cwd })}
              >
                <span className="dir-name">{cwd.split("/").pop() || cwd}</span>
                <span className="dir-count">{n}</span>
              </button>
            );

            return (
              <>
                {recent.map(row)}
                {pinned.map(row)}
                {moreOpen && rest.map(row)}
                {rest.length > 0 && (
                  <button className="dir-row dir-more" onClick={() => setMoreOpen(!moreOpen)}>
                    <span className="dir-name muted">
                      {moreOpen ? "fewer directories" : "more directories…"}
                    </span>
                    {!moreOpen && <span className="dir-count">{rest.length}</span>}
                  </button>
                )}
              </>
            );
          })()}
        </nav>
      </aside>

      <main className="session-pane">
        <div className="session-pane-head">
          <input
            className="search"
            placeholder="Filter by title, directory, or id…"
            value={filter}
            onChange={(e) => set({ filter: e.target.value })}
          />
          <span className="muted small">
            {loading && sessions.length === 0 ? "scanning…" : `${visible.length} conversations`}
          </span>
        </div>

        {cwdFilter && (
          <div className="active-dir muted small">
            <code>{tilde(cwdFilter)}</code>
            <button className="ghost" onClick={() => set({ cwdFilter: "" })}>
              show all
            </button>
          </div>
        )}

        <ul className="tree-list">
          {visible.map((s) => (
            <li key={s.id}>
              <button className="tree-card" onClick={() => void openSession(s.id)}>
                <span className="tree-title">{s.title}</span>
                <span className="muted small tree-sub">
                  {!cwdFilter && (
                    <>
                      <code className="cwd" title={s.cwd}>
                        {s.cwd ? tilde(s.cwd) : "(unknown directory)"}
                      </code>
                      {" · "}
                    </>
                  )}
                  {s.nodeCount} turns
                  {s.branchPoints > 0 && (
                    <span className="branch-badge" title="branch points">
                      ⑂ {s.branchPoints}
                    </span>
                  )}
                  {" · "}
                  {when(s.updatedAt)}
                  {" · "}
                  <code className="id-short">{s.id.slice(0, 8)}</code>
                </span>
              </button>
            </li>
          ))}
        </ul>

        {!loading && visible.length === 0 && (
          <p className="muted empty">
            {sessions.length === 0
              ? "No Claude Code sessions found in ~/.claude/projects."
              : filter
                ? "Nothing matches that filter."
                : "No conversations in this directory yet."}
          </p>
        )}
      </main>
    </div>
  );
}
