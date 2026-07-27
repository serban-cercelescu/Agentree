import { useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../api.ts";
import type { ForkResult } from "../../shared/types.ts";
import { contextAt, costOf, inferWindow, pathToRoot } from "../../shared/render.ts";
import { Markdown } from "../markdown.tsx";
import { pct, tokens, when } from "../format.ts";
import { useMemo } from "react";

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

export function NodePanel() {
  const { session, nodes, selected, patch, setStatus } = useStore();
  const [editingLabel, setEditingLabel] = useState(false);
  const [fork, setFork] = useState<ForkResult | null>(null);
  const [forking, setForking] = useState(false);

  // A fork belongs to the turn it was taken at; keep showing it while that turn
  // stays selected, and drop it the moment the user moves on.
  const [forkFor, setForkFor] = useState<string | null>(null);
  const forkResult = forkFor === selected ? fork : null;

  // Inferred once per session; every node's percentage shares it.
  const window_ = useMemo(() => inferWindow(session?.nodes ?? []), [session]);

  if (!session) return null;
  const meta = session.meta;
  const node = selected ? nodes.get(selected) : null;
  const cost = costOf(node ?? undefined);
  const ctx = node ? contextAt(node.id, nodes) : null;
  const depth = node ? pathToRoot(node.id, nodes).length : 0;

  const resumeCmd = meta.cwd
    ? `cd ${JSON.stringify(meta.cwd)} && claude --resume ${meta.id}`
    : `claude --resume ${meta.id}`;

  return (
    <aside className="panel">
      <section className="panel-block session-block">
        <h3>Session</h3>
        <div className="kv">
          <span className="muted small">id</span>
          <code className="id">{meta.id}</code>
        </div>
        <div className="kv">
          <span className="muted small">cwd</span>
          <code className="path" title={meta.cwd}>
            {meta.cwd || "—"}
          </code>
        </div>

        <div className="copy-row">
          <Copy value={meta.id} label="copy id" />
          <Copy value={resumeCmd} label="copy resume command" />
        </div>
        <p className="muted small hint">
          Sessions are per-directory; the command includes the <code>cd</code> for that.
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
              {!node.injected && <Copy value={node.id} label="copy node uuid" />}
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

            {node.injected && (
              <p className="muted small hint">
                Sent mid-turn; Claude Code wrote no record for it, so it can't be resumed at.
              </p>
            )}

            <div className="panel-actions">
              <button
                className="primary"
                title={
                  node.injected
                    ? "No transcript record to resume from"
                    : "Get a command that resumes the session from this turn"
                }
                disabled={forking || node.injected}
                onClick={async () => {
                  setForking(true);
                  setForkFor(node.id);
                  try {
                    setFork(await api.forkAt(meta.id, node.id));
                  } catch (e) {
                    setFork({ ok: false, error: String(e) });
                  } finally {
                    setForking(false);
                  }
                }}
              >
                {forking ? "forking…" : "⑂ fork after this turn"}
              </button>
            </div>

            {forkResult &&
              (forkResult.ok ? (
                <div className="fork-result">
                  <div className="copy-row">
                    <Copy value={forkResult.command} label="copy resume command" />
                    <Copy value={forkResult.id} label="copy session id" />
                  </div>
                  <p className="muted small hint">
                    Continues from this turn as a new branch. Nothing is deleted.
                  </p>
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
            <div className="panel-body md">
              <Markdown text={node.text} />
            </div>
          </section>
        </>
      )}
    </aside>
  );
}
