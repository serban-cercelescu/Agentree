import type { SessionRef } from "../shared/types.ts";

/**
 * Deep links that open a session in its harness's VS Code extension.
 *
 * Both come from the extensions' own URI handlers (read from their shipped
 * code): Claude Code handles `/open?session=<id>` by calling
 * `claude-vscode.primaryEditor.open`, and Codex forwards the path to its
 * webview router, which routes threads at `/local/<threadId>`. Outside VS Code
 * the OS hands a `vscode://` link to VS Code itself, which is how the desktop
 * app opens a session in the chat panel.
 *
 * `scheme` is `vscode` for the desktop app; inside an extension it is
 * `vscode.env.uriScheme`, which also covers Insiders and VS Code forks.
 */
export function nativeLink(ref: SessionRef, scheme = "vscode"): string | null {
  const id = ref.sessionId;
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return null;
  if (ref.provider === "claude") return `${scheme}://anthropic.claude-code/open?session=${id}`;
  if (ref.provider === "codex") return `${scheme}://openai.chatgpt/local/${id}`;
  return null;
}
