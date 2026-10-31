import { useEffect } from "react";
import { useStore } from "./store.ts";
import { api } from "./api.ts";
import { Welcome } from "./components/Welcome.tsx";
import { Toolbar } from "./components/Toolbar.tsx";
import { TreeCanvas } from "./components/TreeCanvas.tsx";
import { NodePanel } from "./components/NodePanel.tsx";
import { ErrorBanner } from "./components/ErrorBanner.tsx";

export function App() {
  const { session, boot, error, set, close, reloadSession, refreshSessions, settingsRev } = useStore();
  const sessionId = session?.meta.id ?? null;

  useEffect(() => {
    void boot();
  }, [boot]);

  // Live view: follow the transcript on disk. With a session open we watch its
  // family's folders; on the welcome screen every root, so a conversation
  // started in another terminal shows up on its own. A settings change
  // re-subscribes: the targets are resolved once, and a root may have moved.
  useEffect(() => {
    return api.watch(sessionId, () => {
      if (sessionId) void reloadSession();
      else void refreshSessions();
    });
  }, [sessionId, reloadSession, refreshSessions, settingsRev]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key === "Escape" && session) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, close]);

  if (!session) return <Welcome />;

  return (
    <div className="app">
      <Toolbar />
      <ErrorBanner message={error} onDismiss={() => set({ error: null })} />
      <div className="split">
        <TreeCanvas />
        <NodePanel />
      </div>
    </div>
  );
}
