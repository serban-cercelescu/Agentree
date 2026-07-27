#!/usr/bin/env node
/**
 * `agentree` — launch the built app in its packaged Electron runtime.
 *
 * Detaches by default so the terminal comes straight back, like `code`.
 * `--foreground` keeps it attached with logs, for debugging.
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(`agentree — see your coding-agent conversations as trees

Usage: agentree [--foreground]

  --foreground   stay attached to the terminal and print app logs
  --help         show this help

Reads sessions from ~/.claude/projects, ~/.codex/sessions, and
~/.copilot/session-state. https://github.com/serban-cercelescu/Agentree`);
  process.exit(0);
}

// Under plain Node, require("electron") resolves to the path of the binary.
const electron = require("electron");
const appDir = path.join(__dirname, "..");

if (!fs.existsSync(path.join(appDir, "dist-electron", "main.cjs"))) {
  console.error(
    "Agentree is not built. Run `npm install` in the repo (the build runs automatically), then retry.",
  );
  process.exit(1);
}

if (args.includes("--foreground")) {
  const child = spawn(electron, [appDir], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  spawn(electron, [appDir], { detached: true, stdio: "ignore" }).unref();
}
