// Bundles the Electron main + preload to CommonJS. Kept as a tiny esbuild
// script rather than a plugin so the build has one obvious moving part.
import { build, context } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

const entries = ["electron/main.ts", "electron/preload.ts"];

if (process.argv.includes("--watch")) {
  const ctx = await context({ ...common, entryPoints: entries });
  await ctx.watch();
} else {
  await build({ ...common, entryPoints: entries });
}
