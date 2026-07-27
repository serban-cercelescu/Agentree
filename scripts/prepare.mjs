// Build during `prepare`, bootstrapping the toolchain when npm didn't.
//
// `npm install -g <git-url>` runs prepare in a temp checkout where npm (in
// some versions/paths) skips devDependencies — so tsc/vite/esbuild are
// missing. Detect that and install them first. `--ignore-scripts` stops the
// inner install from recursing into this same prepare script, and the
// npm_config_* environment of the OUTER run is stripped: inherited flags like
// `global=true` would otherwise point the inner install at the global tree
// instead of this checkout.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const env = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)),
);
const run = (cmd) => execSync(cmd, { stdio: "inherit", env });

if (!existsSync("node_modules/typescript") || !existsSync("node_modules/vite")) {
  run("npm install --include=dev --ignore-scripts --no-audit --no-fund");
}
run("npm run build");
