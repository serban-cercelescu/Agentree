import { useMemo, useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../api.ts";
import type { ActionResult, ForkResult, ProviderId, SessionRef, SettingsPaths, SettingsState } from "../../shared/types.ts";
import { actionTarget, contextAt, costOf, forkPointOf, inferWindow, pathToRoot } from "../../shared/render.ts";
import { Markdown } from "../markdown.tsx";
import { pct, tokens, when } from "../format.ts";

function Copy({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`copy ${done ? "done" : ""}`}
      title={value}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
        } catch {
          // Clipboard API needs a secure context; localhost qualifies, but a
          // denied permission shouldn't look like success.
          setDone(false);
          return;
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "✓ copied" : label}
    </button>
  );
}

/** A merged turn can carry dozens of calls; show unique names with counts. */
function toolSummary(tools: string[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(" · ");
}

/** The harnesses with a VS Code extension Agentree can hand a session to. */
const NATIVE: Partial<Record<ProviderId, string>> = { claude: "Claude Code", codex: "Codex" };

/**
 * "open in Claude Code / Codex" and "resume in terminal" for one session.
 * Inside VS Code they use the harness's own chat panel and an integrated
 * terminal. The desktop app hands the session to VS Code through the
 * extensions' deep links and opens an OS terminal window.
 */
function NativeButtons({ ref_, onResult }: { ref_: SessionRef; onResult: (r: ActionResult) => void }) {
  const native = NATIVE[ref_.provider];
  const run = async (fn: () => Promise<ActionResult>) => {
    try {
      onResult(await fn());
    } catch (e) {
      onResult({ ok: false, error: String(e) });
    }
  };
  return (
    <>
      {native && (
        <button
          className="copy"
          title={api.host === "vscode" ? undefined : "Opens the session in VS Code's chat panel"}
          onClick={() => void run(() => api.openNative(ref_))}
        >
          open in {native}
          {api.host === "vscode" ? "" : " (VS Code)"}
        </button>
      )}
      <button className="copy" onClick={() => void run(() => api.resumeInTerminal(ref_))}>
        resume in terminal
      </button>
    </>
  );
}

/** The path setting that relocates each harness's store (electron/paths.ts, HOME_SETTING). */
const HOME: Record<ProviderId, { key: keyof SettingsPaths; env: string }> = {
  claude: { key: "claudeConfigDir", env: "CLAUDE_CONFIG_DIR" },
  codex: { key: "codexHome", env: "CODEX_HOME" },
  copilot: { key: "copilotHome", env: "COPILOT_HOME" },
};

/**
 * Terminal resume and the copied command carry the store Agentree reads; a
 * chat-panel hand-off can't — the receiving extension reads its own
 * configuration. Say so when they may differ: the store comes from a saved
 * setting, or (desktop) from a variable VS Code may not have.
 */
function nativeCaveat(provider: ProviderId, state: SettingsState | null): string | null {
  const native = NATIVE[provider];
  if (!native || !state) return null;
  const { key, env } = HOME[provider];
  const fromEnv = !!state.env[key];
  if (!(fromEnv ? api.host !== "vscode" : state.settings.paths[key])) return null;
  return `Agentree reads ${native} history from a location you set; “open in ${native}” finds this session only if the ${native} extension uses the same one (${env}).`;
}

/** Open / resume / copy for one session. */
function SessionActions({ ref_, resumeCmd }: { ref_: SessionRef; resumeCmd: string }) {
  const [status, setStatus] = useState<ActionResult | null>(null);
  const caveat = nativeCaveat(ref_.provider, useStore((s) => s.settings));
  return (
    <>
      <div className="copy-row">
        <NativeButtons ref_={ref_} onResult={setStatus} />
        <Copy value={resumeCmd} label="copy resume command" />
        <Copy value={ref_.sessionId} label="copy id" />
      </div>
      {status && !status.ok && <p className="error-text small hint">{status.error}</p>}
      {caveat && <p className="muted small hint">{caveat}</p>}
    </>
  );
}

export function NodePanel() {
  const { session, nodes, selected, focus, patch, setStatus, annotationError, settings, set } = useStore();
  // A fresh fork opens in the harness's chat panel: by default only in VS
  // Code, where that panel is right there; the desktop app shows the buttons.
  const openForks = settings?.settings.openForkInChat ?? api.host === "vscode";
  const [editingLabel, setEditingLabel] = useState(false);
  const [fork, setFork] = useState<ForkResult | null>(null);
  const [opened, setOpened] = useState<ActionResult | null>(null);
  const [forking, setForking] = useState(false);

  // A fork belongs to the turn it was taken at; keep showing it while that turn
  // stays selected, and drop it the moment the user moves on.
  const [forkFor, setForkFor] = useState<string | null>(null);
  const forkResult = forkFor === selected ? fork : null;

  // Same pattern for the prefix view: it belongs to the turn it was opened on,
  // so selecting another node falls back to that node's own text.
  const [prefixFor, setPrefixFor] = useState<string | null>(null);
  const showPrefix = prefixFor === selected;

  // Inferred once per session; every node's percentage shares it.
  const window_ = useMemo(() => inferWindow(session?.nodes ?? []), [session]);

  if (!session) return null;
  const meta = session.meta;
  const node = selected ? nodes.get(selected) : null;
  const cost = costOf(node ?? undefined);
  const ctx = node ? contextAt(node.id, nodes) : null;
  const depth = node ? pathToRoot(node.id, nodes).length : 0;

  // A family tree mixes sessions: open/resume act on the focused member where
  // the selected turn is in its history, else on the session the turn
  // belongs to — never just the family root.
  const members = session.members ?? [];
  const { member, ref: ref_ } = actionTarget(session, node, focus);
  const parentTitle = member.parentId ? members.find((m) => m.id === member.parentId)?.title : null;
  // Shared history is in several sessions at once; let the user say which.
  const holders = members.filter((m) => node?.heldBy?.includes(m.id));

  const doFork = async () => {
    if (!node) return;
    setForking(true);
    setForkFor(node.id);
    setOpened(null);
    try {
      // Where the node ends as drawn, so a regrouped node is not read as another range.
      const res = await api.forkAt(meta.id, forkPointOf(node));
      setFork(res);
      if (res.ok && res.open && openForks && NATIVE[res.open.provider]) {
        setOpened(await api.openNative(res.open));
      }
    } catch (e) {
      setFork({ ok: false, error: String(e) });
    } finally {
      setForking(false);
    }
  };

  return (
    <aside className="panel">
      <section className="panel-block session-block">
        <h3>
          Conversation <span className={`provider-chip ${meta.provider}`}>{meta.provider}</span>
          {members.length > 1 && <span className="muted small">{members.length} sessions</span>}
        </h3>
        <div className="kv">
          <span className="muted small">cwd</span>
          <code className="path" title={meta.cwd}>
            {meta.cwd || "—"}
          </code>
        </div>
      </section>

      <section className="panel-block member-block">
        <h3>
          Session
          {member.parentId && <span className="fork-badge">fork</span>}
          {member.archived && <span className="fork-badge">archived</span>}
          {member.entrypoint && <span className="muted small"> · {member.entrypoint}</span>}
        </h3>
        {holders.length > 1 ? (
          <select
            className="member-pick"
            title="This turn is in several sessions' history. Open and resume act on the one chosen here."
            value={member.id}
            onChange={(e) => set({ focus: e.target.value })}
          >
            {holders.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} · {m.id.slice(0, 8)}
              </option>
            ))}
          </select>
        ) : (
          <div className="member-title">{member.title}</div>
        )}
        {parentTitle && (
          <p
            className="muted small hint"
            title={
              member.parentEvidence === "inferred"
                ? "Neither session records which was copied from which; Agentree inferred it from shared history and which file was created first."
                : undefined
            }
          >
            {member.parentEvidence === "inferred" ? "probably forked from" : "forked from"} “{parentTitle}”
          </p>
        )}
        <div className="kv">
          <span className="muted small">id</span>
          <code className="id">{member.id}</code>
        </div>
        {(member.files?.length ?? 0) > 1 && (
          <p className="muted small hint" title={member.files!.join("\n")}>
            Stored in {member.files!.length} project folders (the repo moved); read as one session.
          </p>
        )}
        <SessionActions ref_={ref_} resumeCmd={member.resumeCommand} />
        <p className="muted small hint">
          Opens or resumes this session where the agent itself would: at the end of its current
          path, which may not be the branch you selected. To continue from the selected turn, or
          from an older branch, use “⑂ fork after this turn”.
        </p>
      </section>

      {!node ? (
        <section className="panel-block">
          <p className="muted small">Select a node in the tree.</p>
        </section>
      ) : (
        <>
          <section className="panel-block">
            <div className="panel-head">
              <span className={`role ${node.role}`}>{node.role}</span>
              <span className="muted small">
                depth {depth} · {when(node.timestamp)}
                {node.absorbedIds?.length ? (
                  <> · {node.absorbedIds.length + 1} turns merged</>
                ) : null}
              </span>
            </div>

            {ctx != null && (
              <div className="muted small stats">
                <span title="How much of the model's context window the conversation fills at this point. The next message — or a branch from here — sends all of it. Window size inferred from usage.">
                  context {tokens(ctx)} · {pct(ctx / window_)} of window
                </span>
                {node.usage && (
                  <>
                    {" · "}
                    <span title="Prompt tokens already sent across this turn's API calls — what this turn has cost you. A tool-using turn replays the history once per call, so this can exceed the context size.">
                      prompt {tokens(cost.promptTokens)}
                    </span>
                  </>
                )}
              </div>
            )}

            <div className="panel-actions">
              {!node.injected && <Copy value={node.id} label="copy node id" />}
              <button
                className="ghost"
                title="Dims this turn and everything under it"
                onClick={() =>
                  void setStatus(node.id, node.status === "dead-end" ? undefined : "dead-end")
                }
              >
                {node.status === "dead-end" ? "revive" : "mark dead end"}
              </button>
              <button
                className="ghost"
                onClick={() =>
                  void setStatus(node.id, node.status === "favorite" ? undefined : "favorite")
                }
              >
                {node.status === "favorite" ? "unstar" : "star"}
              </button>
              <button className="ghost" onClick={() => setEditingLabel(true)}>
                label
              </button>
            </div>
            {annotationError && <p className="error-text small hint">{annotationError}</p>}

            <div className="panel-actions">
              <button
                className="primary"
                title={
                  node.forkBlocked ??
                  "Create a new session holding the conversation up to and including this turn"
                }
                disabled={forking || !!node.forkBlocked}
                onClick={() => void doFork()}
              >
                {forking ? "forking…" : "⑂ fork after this turn"}
              </button>
            </div>
            {/* The provider decided this when it built the tree, from what the
                harness can actually resume — say why rather than fail on click. */}
            {node.forkBlocked && <p className="muted small hint">{node.forkBlocked}</p>}

            {forkResult &&
              (forkResult.ok ? (
                <div className="fork-result">
                  <p className="small">
                    {opened?.ok
                      ? "Forked and opened. It joins this tree as soon as it has a turn of its own."
                      : "Forked into a new session. It joins this tree as soon as it has a turn of its own."}
                  </p>
                  {opened && !opened.ok && <p className="error-text small">{opened.error}</p>}
                  <code className="path fork-cmd">{forkResult.command}</code>
                  <div className="copy-row">
                    {forkResult.open && <NativeButtons ref_={forkResult.open} onResult={setOpened} />}
                    <Copy value={forkResult.command} label="⑂ copy resume command" />
                    <Copy value={forkResult.id} label="copy session id" />
                  </div>
                  {forkResult.note && <p className="muted small hint">{forkResult.note}</p>}
                </div>
              ) : (
                <div className="fork-result error-text">{forkResult.error}</div>
              ))}

            {editingLabel && (
              <input
                className="label-input"
                autoFocus
                defaultValue={node.label ?? ""}
                placeholder="Label this branch…"
                onBlur={(e) => {
                  void patch(node.id, { label: e.target.value || undefined });
                  setEditingLabel(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingLabel(false);
                }}
              />
            )}
          </section>

          {node.thinking && (
            <section className="panel-block">
              <details className="thinking">
                <summary>thinking</summary>
                <div className="md thinking-body">
                  <Markdown text={node.thinking} />
                </div>
              </details>
            </section>
          )}

          {node.toolUses?.length ? (
            <section className="panel-block">
              <div className="tool-strip muted small">⚒ {toolSummary(node.toolUses)}</div>
            </section>
          ) : null}

          <section className="panel-block grow">
            <div className="prefix-toggle">
              <button
                className="ghost"
                title="Read the displayed turns from the root down to this one. The agent's own context also held tool results, files and instructions not shown here."
                onClick={() => setPrefixFor(showPrefix ? null : node.id)}
              >
                {showPrefix ? "show this turn only" : "view conversation up to here"}
              </button>
            </div>
            {showPrefix ? (
              <div className="panel-body md prefix-view">
                {pathToRoot(node.id, nodes).map((p) => (
                  <div key={p.id} className={`prefix-turn ${p.role}`}>
                    <div className="prefix-role muted small">
                      {p.role}
                      {p.injected || p.midTurn ? " · mid-turn" : ""} · {when(p.timestamp)}
                    </div>
                    <Markdown text={p.text} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel-body md">
                <Markdown text={node.text} />
              </div>
            )}
          </section>
        </>
      )}
    </aside>
  );
}
