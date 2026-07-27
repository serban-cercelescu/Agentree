import { create } from "zustand";
import { api } from "./api.ts";
import { childIndex, newestLeaf, toNodeMap, type NodeMap } from "../shared/render.ts";
import type {
  NodeId,
  NodeStatus,
  SessionDetail,
  SessionMeta,
  TurnNode,
  UpdateInfo,
} from "../shared/types.ts";

interface State {
  sessions: SessionMeta[];
  filter: string;
  /** Show only sessions from this working directory. Empty means all of them. */
  cwdFilter: string;

  session: SessionDetail | null;
  nodes: NodeMap;
  children: Map<string, TurnNode[]>;

  selected: NodeId | null;
  /** Collapsed linear runs the user has clicked open. */
  expanded: Set<string>;
  compress: boolean;

  error: string | null;
  loading: boolean;
  /** Set once per launch if the main process found a newer build on GitHub. */
  update: UpdateInfo | null;

  boot: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (id: string) => Promise<void>;
  close: () => void;

  select: (id: NodeId | null) => void;
  toggleChain: (chainId: string) => void;

  /** Re-read the open session from disk, keeping the user's place. */
  reloadSession: () => Promise<void>;
  /** True while the selection sits on the conversation tip, so it can follow. */
  following: boolean;

  patch: (id: NodeId, patch: Partial<TurnNode>) => Promise<void>;
  setStatus: (id: NodeId, status: NodeStatus | undefined) => Promise<void>;

  set: (partial: Partial<State>) => void;
}

/**
 * Back-pressure for disk-driven refreshes.
 *
 * A full session scan takes far longer than the watcher's debounce, so during
 * an active conversation changes arrive faster than they can be served. Without
 * a gate each one starts another parse, and every pending IPC promise retains a
 * whole parse result — the renderer grows without bound until the process dies.
 *
 * So: at most one refresh of a kind in flight. Anything that arrives while one
 * is running sets `again`, which triggers exactly one more pass afterwards —
 * never a queue, but never a missed update either.
 */
function gate(): (run: () => Promise<void>) => Promise<void> {
  let busy = false;
  let again = false;
  return async function invoke(run) {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      await run();
    } finally {
      busy = false;
    }
    if (again) {
      again = false;
      await invoke(run);
    }
  };
}

const listGate = gate();
const sessionGate = gate();

export const useStore = create<State>((set, get) => ({
  sessions: [],
  filter: "",
  cwdFilter: "",

  session: null,
  nodes: new Map(),
  children: new Map(),

  selected: null,
  expanded: new Set(),
  compress: true,
  following: true,

  error: null,
  loading: false,
  update: null,

  set: (partial) => set(partial),

  boot: async () => {
    api.onUpdateAvailable((update) => set({ update }));
    await get().refreshSessions();
  },

  refreshSessions: () =>
    listGate(async () => {
      set({ loading: true });
      try {
        set({ sessions: await api.listSessions() });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ loading: false });
      }
    }),

  openSession: async (id) => {
    set({ loading: true });
    try {
      const session = await api.getSession(id);
      if (!session) {
        set({ error: "That session's transcript is no longer on disk." });
        return;
      }
      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      set({
        session,
        nodes,
        children,
        selected: newestLeaf(session.nodes, children),
        expanded: new Set(),
        following: true,
        error: null,
      });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ loading: false });
    }
  },

  close: () =>
    set({
      session: null,
      nodes: new Map(),
      children: new Map(),
      selected: null,
      expanded: new Set(),
    }),

  // Clicking a node stops the view chasing the tip; clicking the tip resumes it.
  select: (id) =>
    set({
      selected: id,
      following: id != null && id === newestLeaf(get().session?.nodes ?? [], get().children),
    }),

  reloadSession: () =>
    sessionGate(async () => {
      const prev = get().session;
      if (!prev) return;

      const session = await api.getSession(prev.meta.id);
      if (!session) return; // transcript vanished mid-session; keep what's drawn

      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      const tip = newestLeaf(session.nodes, children);

      // Follow the conversation only if the user was already sitting on the
      // tip. Otherwise they're reading history, and yanking the selection away
      // as new turns land would make the app unusable during a live session.
      const wasFollowing = get().following;
      const kept = get().selected;
      const selected = wasFollowing || !kept || !nodes.has(kept) ? tip : kept;

      // `expanded` is intentionally preserved: chain ids are keyed on their
      // first node, so an opened run stays open as turns are appended below it.
      set({ session, nodes, children, selected, error: null });
    }),

  toggleChain: (chainId) => {
    const next = new Set(get().expanded);
    if (next.has(chainId)) next.delete(chainId);
    else next.add(chainId);
    set({ expanded: next });
  },

  patch: async (id, patch) => {
    const { session } = get();
    if (!session) return;
    const nodes = session.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    set({
      session: { ...session, nodes },
      nodes: toNodeMap(nodes),
      children: childIndex(nodes),
    });
    await api.patchNode(session.meta.id, id, patch);
  },

  setStatus: async (id, status) => {
    await get().patch(id, { status });
  },
}));
