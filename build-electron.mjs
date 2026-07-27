// Bundles the Electron main + preload to CommonJS. Kept as a tiny esbuild
// script rather than a plugin so the build has one obvious moving part.
import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Stamp the build so the launch-time update check can ask GitHub "is main
// ahead of this?". A tarball build without git still gets the version for the
// fallback compare.
{
  let commit = null;
  try {
    commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  mkdirSync("dist-electron", { recursive: true });
  writeFileSync("dist-electron/build-info.json", JSON.stringify({ version, commit }) + "\n");
}

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
