import { create } from "zustand";
import { api } from "./api.ts";
import { childIndex, forkPointOf, newestLeaf, resolveForkPoint, toNodeMap, type NodeMap } from "../shared/render.ts";
import type {
  NodeId,
  NodeMeta,
  NodeStatus,
  ProviderHealth,
  ProviderId,
  SessionDetail,
  SessionId,
  SessionMeta,
  SettingsPatch,
  SettingsState,
  TurnNode,
  UpdateInfo,
} from "../shared/types.ts";

interface State {
  sessions: SessionMeta[];
  /** One row per provider from the last scan — shown above the list. */
  health: ProviderHealth[];
  filter: string;
  /** Show only sessions from this working directory (a `cwdKey`). Empty means all of them. */
  cwdFilter: string;
  /** Show only one agent's sessions. Empty means every agent. */
  providerFilter: ProviderId | "";

  session: SessionDetail | null;
  nodes: NodeMap;
  children: Map<string, TurnNode[]>;

  selected: NodeId | null;
  /**
   * The member session the user is looking through: the fork they opened the
   * tree on, or picked on a shared turn. Open/resume act on it wherever the
   * selected turn is in its history (`actionTarget`); elsewhere, on the
   * turn's own session. Kept across selections and reloads while it is a
   * member; cleared by opening the family without one.
   */
  focus: SessionId | null;
  /** Collapsed linear runs the user has clicked open. */
  expanded: Set<string>;
  compress: boolean;

  error: string | null;
  loading: boolean;
  /** Set once per launch if the main process found a newer build on GitHub. */
  update: UpdateInfo | null;

  /** Agentree's settings, once loaded. */
  settings: SettingsState | null;
  /**
   * Bumped by every settings change. Watches depend on it: their targets are
   * resolved once, so a moved root needs a new watch, not just a new list.
   */
  settingsRev: number;
  settingsOpen: boolean;
  /**
   * Why the last settings change wasn't saved; cleared by the next one that
   * is. Shown where settings are edited, apart from `error`.
   */
  settingsError: string | null;
  /**
   * Change the settings, then refresh everything that depends on them.
   * Resolves to whether the change was saved.
   */
  saveSettings: (patch: SettingsPatch) => Promise<boolean>;

  boot: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /**
   * Open the family holding `id`. With `focus`, select that member session's
   * own tip (`MemberInfo.tipId`) instead of the family's newest leaf, and act
   * on that member (`State.focus`).
   */
  openSession: (id: string, opts?: { focus?: string }) => Promise<void>;
  close: () => void;

  select: (id: NodeId | null) => void;
  toggleChain: (chainId: string) => void;

  /** Re-read the open session from disk, keeping the user's place. */
  reloadSession: () => Promise<void>;
  /** True while the selection sits on the conversation tip, so it can follow. */
  following: boolean;

  /** Annotate a node, shown at once. Resolves to whether it was saved. */
  patch: (id: NodeId, patch: Partial<TurnNode>) => Promise<boolean>;
  setStatus: (id: NodeId, status: NodeStatus | undefined) => Promise<boolean>;
  /**
   * Why the last annotation wasn't saved; the tree was redrawn from disk.
   * Cleared by the next one that is, or by opening another conversation.
   */
  annotationError: string | null;

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

/**
 * Which open view an async result belongs to. Bumped by every open and close;
 * a result that comes back for an older view is dropped. Without it, a
 * reload in flight when the user closed the conversation re-opened it.
 */
let view = 0;

/**
 * Where a selection lives in a reloaded family. First the node that ends
 * where it did: new membership can split a display group under the same
 * head id, and the head alone would quietly shorten the selected prefix.
 * Then the same id (a group that grew, or was folded into a longer one), then
 * the same semantic identity (a re-rooted family draws it under other ids).
 */
function carry(id: NodeId | null, from: NodeMap, to: NodeMap): NodeId | null {
  if (!id) return null;
  const prev = from.get(id);
  const same = prev && resolveForkPoint([...to.values()], forkPointOf(prev));
  if (same) return same.id;
  if (to.has(id)) return id;
  const ids = new Set(from.get(id)?.stableIds ?? []);
  if (!ids.size) return null;
  for (const n of to.values()) if (n.stableIds?.some((s) => ids.has(s))) return n.id;
  return null;
}

export const useStore = create<State>((set, get) => ({
  sessions: [],
  health: [],
  filter: "",
  cwdFilter: "",
  providerFilter: "",

  session: null,
  nodes: new Map(),
  children: new Map(),

  selected: null,
  focus: null,
  expanded: new Set(),
  compress: true,
  following: true,

  error: null,
  annotationError: null,
  loading: false,
  update: null,

  settings: null,
  settingsRev: 0,
  settingsOpen: false,
  settingsError: null,

  set: (partial) => set(partial),

  boot: async () => {
    api.onUpdateAvailable((update) => set({ update }));
    try {
      const settings = await api.getSettings();
      const v = settings.settings.rememberView ? settings.settings.view : undefined;
      set({
        settings,
        ...(v ? { compress: v.compress, cwdFilter: v.cwdFilter, providerFilter: v.providerFilter } : {}),
      });
    } catch {
      /* defaults; the list still loads */
    }
    await get().refreshSessions();
  },

  saveSettings: async (patch) => {
    if (patch.rememberView === false) cancelViewSave();
    try {
      const settings = await writeSettings(patch);
      set({ ...(settings ? { settings } : {}), settingsRev: get().settingsRev + 1, settingsError: null });
    } catch (e) {
      set({ settingsError: e instanceof Error ? e.message : String(e) });
      return false;
    }
    // A setting can move a root or turn an agent off: the list re-scans, and
    // an open tree reloads from wherever its sessions are now.
    await get().refreshSessions();
    if (get().session) await get().reloadSession();
    return true;
  },

  refreshSessions: () =>
    listGate(async () => {
      set({ loading: true });
      try {
        set({ sessions: await api.listSessions() });
        // After the list: health describes the scan that list came from.
        set({ health: await api.providerHealth() });
      } catch (e) {
        set({ error: String(e) });
      } finally {
        set({ loading: false });
      }
    }),

  openSession: async (id, opts) => {
    const mine = ++view;
    set({ loading: true });
    try {
      const session = await api.getSession(id);
      if (mine !== view) return;
      if (!session) {
        set({ error: "That session's transcript is no longer on disk." });
        return;
      }
      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      const tip = newestLeaf(session.nodes, children);
      const focus = session.members.find((m) => m.id === opts?.focus) ?? null;
      const selected = focus?.tipId && nodes.has(focus.tipId) ? focus.tipId : tip;
      set({
        session,
        nodes,
        children,
        selected,
        focus: focus?.id ?? null,
        expanded: new Set(),
        // Follow the conversation only from its tip; a focused fork that
        // isn't the tip is a place the user asked to read.
        following: selected === tip,
        error: null,
        annotationError: null,
      });
    } catch (e) {
      if (mine === view) set({ error: String(e) });
    } finally {
      if (mine === view) set({ loading: false });
    }
  },

  close: () => {
    view++;
    set({
      session: null,
      nodes: new Map(),
      children: new Map(),
      selected: null,
      focus: null,
      expanded: new Set(),
      error: null,
      annotationError: null,
    });
    // The list may have changed while the tree was open (a fork made, a
    // member deleted); the welcome watch only fires on the NEXT write.
    void get().refreshSessions();
  },

  // Clicking a node stops the view chasing the tip; clicking the tip resumes it.
  select: (id) =>
    set({
      selected: id,
      following: id != null && id === newestLeaf(get().session?.nodes ?? [], get().children),
    }),

  reloadSession: () =>
    sessionGate(async () => {
      const mine = view;
      const prev = get().session;
      if (!prev) return;

      // A family isn't one file: its root can be deleted while a fork
      // survives (the provider then re-roots the family on that fork), and
      // deleting a member that bridged two others splits it in two. Any
      // member's id loads the family it is in NOW, so the view asks first for
      // the session the user is looking through — the focused member — then
      // for the sessions holding the selected turn, and only then for the
      // root and the other members. The old root loading proves only that
      // the root survived, not that the user's member is still with it.
      //
      // The user can pick another member while the stores are read. A result
      // looked up for the earlier choice that doesn't hold the newer one is
      // not adopted: the lookup runs again from the latest choice, so a
      // member choice stands until the user changes it or it is really gone.
      const prevNodes = get().nodes;
      let session: SessionDetail | null = null;
      for (;;) {
        const asked = get().focus;
        const sel = get().selected ? prevNodes.get(get().selected!) : undefined;
        const candidates = [
          ...new Set(
            [
              asked,
              sel?.sourceSessionId,
              ...(sel?.heldBy ?? []),
              prev.meta.id,
              ...prev.members.map((m) => m.id),
            ].filter(Boolean) as string[],
          ),
        ];
        session = null;
        for (const id of candidates) {
          session = await api.getSession(id);
          if (mine !== view) return;
          if (session) break;
        }
        const now = get().focus;
        if (now === asked || !now || session?.members.some((m) => m.id === now)) break;
      }
      if (!session) {
        set({ error: "This conversation's transcripts are no longer on disk." });
        return;
      }

      const nodes = toNodeMap(session.nodes);
      const children = childIndex(session.nodes);
      const tip = newestLeaf(session.nodes, children);

      // Follow the conversation only if the user was already sitting on the
      // tip. Otherwise they're reading history, and yanking the selection away
      // as new turns land would make the app unusable during a live session.
      // A re-rooted family draws shared turns under another session's ids;
      // the selection follows its semantic identity there.
      const wasFollowing = get().following;
      const kept = carry(get().selected, prevNodes, nodes);
      const selected = wasFollowing || !kept ? tip : kept;

      // The focused member stays in focus while it is still in the family.
      const focus = session.members.some((m) => m.id === get().focus) ? get().focus : null;

      // `expanded` is intentionally preserved: chain ids are keyed on their
      // first node, so an opened run stays open as turns are appended below it.
      set({ session, nodes, children, selected, focus, error: null });
    }),

  toggleChain: (chainId) => {
    const next = new Set(get().expanded);
    if (next.has(chainId)) next.delete(chainId);
    else next.add(chainId);
    set({ expanded: next });
  },

  patch: async (id, patch) => {
    const { session } = get();
    if (!session) return false;
    const nodes = session.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
    set({
      session: { ...session, nodes },
      nodes: toNodeMap(nodes),
      children: childIndex(nodes),
    });
    // A cleared field travels as null: `undefined` doesn't survive JSON (the
    // VS Code webview bridge), and a dropped key would mean "leave as is".
    const wire = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v ?? null])) as NodeMeta;
    try {
      await api.patchNode(session.meta.id, id, wire);
    } catch (e) {
      // The edit above was only a guess at the result. Say it wasn't saved,
      // and redraw from disk: one member's sidecar may have been written
      // before another's failed, so undoing the guess wouldn't be the truth
      // either.
      set({ annotationError: `Not saved: ${e instanceof Error ? e.message : String(e)}` });
      await get().reloadSession().catch(() => {
        /* the redraw comes with the next watch event */
      });
      return false;
    }
    set({ annotationError: null });
    return true;
  },

  setStatus: (id, status) => get().patch(id, { status }),
}));

/**
 * Settings writes, in the order they were made. A response that comes back
 * after a newer write was sent describes an older state, and is dropped.
 */
let settingsWrites = 0;
async function writeSettings(patch: SettingsPatch): Promise<SettingsState | null> {
  const mine = ++settingsWrites;
  const settings = await api.setSettings(patch);
  return mine === settingsWrites ? settings : null;
}

/**
 * Remembered view state: with the setting on, compress-chains and the list
 * filters are saved (debounced) whenever they change, and `boot` restores
 * them. Off, nothing is written: turning it off cancels a pending save, a
 * save that fires rechecks the setting, and the settings store keeps no view
 * while it is off (whichever write lands last).
 */
let viewTimer: ReturnType<typeof setTimeout> | null = null;
function cancelViewSave() {
  if (viewTimer) clearTimeout(viewTimer);
  viewTimer = null;
}
const remembering = () => !!useStore.getState().settings?.settings.rememberView;
useStore.subscribe((s, prev) => {
  if (!remembering()) return cancelViewSave();
  if (s.compress === prev.compress && s.cwdFilter === prev.cwdFilter && s.providerFilter === prev.providerFilter) return;
  cancelViewSave();
  viewTimer = setTimeout(() => {
    viewTimer = null;
    if (!remembering()) return;
    const { compress, cwdFilter, providerFilter } = useStore.getState();
    writeSettings({ view: { compress, cwdFilter, providerFilter } }).then(
      (settings) => settings && useStore.setState({ settings }),
      () => {
        /* not remembered this time; the view itself is unaffected */
      },
    );
  }, 500);
});
