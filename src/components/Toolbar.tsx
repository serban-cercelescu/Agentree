import { useStore } from "../store.ts";
import logoUrl from "../../assets/logo.png";

export function Toolbar() {
  const { session, compress, set, close } = useStore();
  if (!session) return null;

  return (
    <header className="toolbar">
      <button className="ghost" onClick={close} title="Back to all sessions (Esc)">
        ←
      </button>
      <img className="mark" src={logoUrl} alt="" width={20} height={20} />
      <span className="tree-name" title={session.meta.title}>
        {session.meta.title}
      </span>
      <span className="muted small">{session.meta.project}</span>
      <span className="muted small">
        {session.meta.nodeCount} turns · {session.meta.branchPoints} branch
        {session.meta.branchPoints === 1 ? "" : "es"}
      </span>

      <span className="spacer" />

      <label className="ctl" title="Collapse runs of linear turns into a single element">
        <input
          type="checkbox"
          checked={compress}
          onChange={(e) => set({ compress: e.target.checked })}
        />
        <span className="small">compress chains</span>
      </label>

    </header>
  );
}
