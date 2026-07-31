import * as vscode from "vscode";

import { listAllSessions, loadAnySession, forkAnyAt } from "../../electron/registry.ts";
import { writeMeta } from "../../electron/meta.ts";
import { watchTranscripts, type Watcher } from "../../electron/watch.ts";
import type { NodeMeta } from "../../shared/types.ts";

/**
 * VS Code host for Agentree. The Electron app's main/renderer split maps
 * one-to-one onto extension host/webview: the same provider code answers the
 * same four calls, and the webview runs the same React bundle with a
 * postMessage shim standing in for the contextBridge (see src/shim.ts).
 */

/** One panel, like the Electron app's one window; re-running the command reveals it. */
let current: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
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
        watchTranscripts(m.sessionId, () => {
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
      return listAllSessions();
    case "getSession":
      return loadAnySession(args[0] as string);
    case "patchNode":
      return writeMeta(args[0] as string, args[1] as string, args[2] as NodeMeta);
    case "forkAt":
      return forkAnyAt(args[0] as string, args[1] as string);
    default:
      throw new Error(`Unknown method: ${method}`);
  }
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
