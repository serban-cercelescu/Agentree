import * as vscode from "vscode";
import path from "node:path";

import { startBackend, type Backend } from "../../electron/backend-client.ts";
import { nativeLink } from "../../electron/native.ts";
import { quote } from "../../electron/shell.ts";
import { usableCwd } from "../../electron/terminal.ts";
import { watchLater, type Watcher } from "../../electron/watch.ts";
import type { ActionResult, ForkPoint, NodeMeta, SessionRef, SettingsPatch } from "../../shared/types.ts";

/**
 * VS Code host for Agentree. The Electron app's main/renderer split maps
 * one-to-one onto extension host/webview: the same provider code answers the
 * same calls, and the webview runs the same React bundle with a postMessage
 * shim standing in for the contextBridge (see src/shim.ts).
 *
 * The providers run in a worker thread (dist/worker.cjs), not here: a cold
 * scan takes seconds, and the extension host is shared by every extension.
 */

/** One panel, like the Electron app's one window; re-running the command reveals it. */
let current: vscode.WebviewPanel | undefined;
let backend: Backend;

export function activate(context: vscode.ExtensionContext) {
  backend = startBackend(path.join(context.extensionPath, "dist", "worker.cjs"));
  context.subscriptions.push({ dispose: () => backend.dispose() });
  context.subscriptions.push(
    vscode.commands.registerCommand("agentree.open", () => {
      if (current) {
        current.reveal();
        return;
      }
      current = createPanel(context);
      current.onDidDispose(() => (current = undefined));
    }),
  );
}

function createPanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  const webviewRoot = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
  const panel = vscode.window.createWebviewPanel(
    "agentree",
    "Agentree",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      // The tree, selection, and viewport are all webview state; rebuilding
      // them on every tab switch would lose the user's place.
      retainContextWhenHidden: true,
      localResourceRoots: [webviewRoot],
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "logo.png");
  panel.webview.html = htmlFor(panel.webview, webviewRoot);

  // Live-view watchers, keyed by the shim's subscription token — same shape
  // as the Electron main process's token-keyed watcher map.
  const watchers = new Map<string, Watcher>();

  panel.webview.onDidReceiveMessage(async (m: BridgeRequest) => {
    if (m.kind === "invoke") {
      try {
        const value = await dispatch(m.method, m.args);
        await panel.webview.postMessage({ kind: "result", id: m.id, ok: true, value });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await panel.webview.postMessage({ kind: "result", id: m.id, ok: false, error });
      }
    } else if (m.kind === "watchStart") {
      watchers.get(m.token)?.close();
      watchers.set(
        m.token,
        watchLater(() => backend.watchTargets(m.sessionId), () => {
          void panel.webview.postMessage({ kind: "changed", token: m.token });
        }),
      );
    } else if (m.kind === "watchStop") {
      watchers.get(m.token)?.close();
      watchers.delete(m.token);
    }
  });

  panel.onDidDispose(() => {
    for (const w of watchers.values()) w.close();
    watchers.clear();
  });

  return panel;
}

type BridgeRequest =
  | { kind: "invoke"; id: number; method: string; args: unknown[] }
  | { kind: "watchStart"; token: string; sessionId: string | null }
  | { kind: "watchStop"; token: string };

function dispatch(method: string, args: unknown[]): unknown {
  switch (method) {
    case "listSessions":
      return backend.listSessions();
    case "getSession":
      return backend.getSession(args[0] as string);
    case "patchNode":
      return backend.patchNode(args[0] as string, args[1] as string, args[2] as NodeMeta);
    case "forkAt":
      return backend.forkAt(args[0] as string, args[1] as ForkPoint);
    case "providerHealth":
      return backend.providerHealth();
    case "getSettings":
      return backend.getSettings();
    case "setSettings":
      return backend.setSettings(args[0] as SettingsPatch);
    case "openNative":
      return openNative(args[0] as SessionRef);
    case "resumeInTerminal":
      return resumeInTerminal(args[0] as SessionRef);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * Hand a session to its harness's own VS Code extension.
 *
 * - Claude Code: `claude-vscode.editor.open(sessionId)` — the command its own
 *   `vscode://anthropic.claude-code/open?session=` URI handler calls.
 * - Codex: its URI handler routes `/local/<threadId>` to the conversation
 *   view; `uriScheme` keeps this right under Insiders and forks of VS Code.
 */
async function openNative(ref: SessionRef): Promise<ActionResult> {
  const id = ref.sessionId;
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return { ok: false, error: "Not a session id." };
  try {
    if (ref.provider === "claude") {
      if (!vscode.extensions.getExtension("anthropic.claude-code")) {
        return { ok: false, error: "The Claude Code extension isn't installed in this VS Code." };
      }
      await vscode.commands.executeCommand("claude-vscode.editor.open", id);
      return { ok: true };
    }
    if (ref.provider === "codex") {
      if (!vscode.extensions.getExtension("openai.chatgpt")) {
        return { ok: false, error: "The Codex extension (openai.chatgpt) isn't installed in this VS Code." };
      }
      const uri = vscode.Uri.parse(nativeLink(ref, vscode.env.uriScheme)!);
      const ok = await vscode.env.openExternal(uri);
      return ok ? { ok: true } : { ok: false, error: "VS Code declined to open the Codex link." };
    }
    return { ok: false, error: "This harness has no VS Code extension to open sessions in." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Resume in an integrated terminal started in the session's own directory,
 * with what the worker resolved: argv, and the environment that points the
 * harness at the store Agentree read the session from.
 */
async function resumeInTerminal(ref: SessionRef): Promise<ActionResult> {
  const launch = await backend.resumeLaunch(ref.provider, ref.sessionId);
  if (!launch) return { ok: false, error: "Unknown session." };
  const term = vscode.window.createTerminal({
    name: `${ref.provider} ${ref.sessionId.slice(0, 8)}`,
    // A session's folder can be gone (repo moved); the CLI still finds the session.
    cwd: usableCwd(ref.cwd),
    env: launch.env,
  });
  term.show();
  term.sendText(launch.argv.map((a) => quote(a)).join(" "));
  return { ok: true };
}

function htmlFor(webview: vscode.Webview, root: vscode.Uri): string {
  const base = webview.asWebviewUri(root);
  const csp = webview.cspSource;
  return /* html */ `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <base href="${base}/" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${csp} 'unsafe-inline'; script-src ${csp}; img-src ${csp} data:; font-src ${csp};"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Agentree</title>
    <!-- Vite injects this link into index.html; this shell has no HTML for it
         to transform, so the app stylesheet is linked by hand. -->
    <link rel="stylesheet" href="index.css" />
    <style>
      /* Follow the editor theme, not the OS one: VS Code stamps these classes
         on the webview body, and a light editor over a dark OS (or vice versa)
         would otherwise mismatch the surrounding chrome. */
      body.vscode-dark, body.vscode-high-contrast {
        --bg: #12100e; --panel: #191614; --panel-2: #201c19; --line: #322c27;
        --fg: #ede7e0; --muted: #9a8f85;
      }
      body.vscode-light, body.vscode-high-contrast-light {
        --bg: #faf8f5; --panel: #fff; --panel-2: #f2eee9; --line: #e0d8ce;
        --fg: #21201c; --muted: #756e66;
      }
      /* No macOS traffic lights to clear inside an editor tab. */
      .rail-brand { padding: 14px; }
      .session-pane-head { padding: 12px 0; }
      .toolbar { padding: 8px 12px; }
      body { padding: 0; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script src="shim.js"></script>
    <script type="module" src="index.js"></script>
  </body>
</html>`;
}
