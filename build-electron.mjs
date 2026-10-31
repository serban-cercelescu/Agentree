// Bundles the Electron main + preload to CommonJS. Kept as a tiny esbuild
// script rather than a plugin so the build has one obvious moving part.
import { build, context } from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Stamp the build so the launch-time update check can ask GitHub "is my
// branch ahead of this?" — of the repository this checkout came from (its
// `origin`) and the branch it was built on, so a fork checks itself, never
// upstream, and a feature branch never gets offered a pull of `main`. A
// tarball build without git still gets the version for the fallback compare.
{
  const git = (args) => {
    try {
      return execSync(`git ${args}`, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      return null; // not a git checkout
    }
  };
  const commit = git("rev-parse HEAD");
  const origin = git("remote get-url origin");
  // "HEAD" when detached — no branch to follow.
  const branch = git("rev-parse --abbrev-ref HEAD");
  const repo = origin ? (/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(origin)?.[1] ?? null) : null;
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  mkdirSync("dist-electron", { recursive: true });
  writeFileSync("dist-electron/build-info.json", JSON.stringify({ version, commit, repo, branch: branch === "HEAD" ? null : branch }) + "\n");
}

const common = {
  bundle: true,
  // electron/version.ts: the version, from package.json alone.
  define: { __AGENTREE_VERSION__: JSON.stringify(JSON.parse(readFileSync("package.json", "utf8")).version) },
  platform: "node",
  target: "node20",
  format: "cjs",
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

// worker.ts is the backend thread main.ts starts (see electron/backend.ts).
const entries = ["electron/main.ts", "electron/preload.ts", "electron/worker.ts"];

if (process.argv.includes("--watch")) {
  const ctx = await context({ ...common, entryPoints: entries });
  await ctx.watch();
} else {
  await build({ ...common, entryPoints: entries });
}
