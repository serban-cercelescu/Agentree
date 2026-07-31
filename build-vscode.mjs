// Builds the VS Code extension out of the same sources as the Electron app:
// the extension host bundles electron/registry + watch + meta (pure Node — no
// Electron import anywhere below main/preload), and the webview is the
// unmodified renderer plus a postMessage shim for `window.agentree`.
import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";

const OUT = "vscode-ext/dist";
rmSync(OUT, { recursive: true, force: true });

// Renderer → webview bundle. Fixed output names (no hashes) so the extension
// host can write a static HTML shell referencing index.js / index.css.
await viteBuild({
  configFile: false,
  plugins: [react()],
  base: "./",
  build: {
    outDir: path.join(OUT, "webview"),
    rollupOptions: {
      input: { index: path.resolve("src/main.tsx") },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});

// Extension host: CommonJS for VS Code's require(), only `vscode` external.
await esbuild({
  entryPoints: ["vscode-ext/src/extension.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(OUT, "extension.cjs"),
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
});

// Webview shim: classic IIFE script so it runs before the module bundle.
await esbuild({
  entryPoints: ["vscode-ext/src/shim.ts"],
  bundle: true,
  format: "iife",
  target: "es2020",
  outfile: path.join(OUT, "webview", "shim.js"),
  sourcemap: true,
  logLevel: "info",
});

// vsce requires the marketplace icon to live inside the extension folder.
copyFileSync("assets/logo-256.png", "vscode-ext/logo.png");
