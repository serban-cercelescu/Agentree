// Starts Electron on this checkout: `node scripts/electron.mjs` runs the
// built app, `--dev` points it at the Vite dev server.
//
// A Node launcher rather than `electron .` / `VAR=value electron .` in
// package.json, for two Windows realities:
//  - npm runs scripts through cmd.exe, which has no `VAR=value cmd` syntax;
//  - shells started from inside VS Code (its terminals' child tools, agent
//    extensions) inherit ELECTRON_RUN_AS_NODE=1, which turns electron.exe into
//    plain Node — the app then dies on `ipcMain` being undefined.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes("--dev")) {
  env.AGENTVIEW_DEV_URL = env.AGENTVIEW_DEV_URL ?? "http://localhost:5173";
}
const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
