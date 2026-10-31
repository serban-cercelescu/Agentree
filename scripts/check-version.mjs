// Every place that states Agentree's version states package.json's
// (scripts/release/version.mjs lists them). Run by CI and by
// `npm run release:prepare`.
//
//   node scripts/check-version.mjs
import path from "node:path";
import { disagreements } from "./release/version.mjs";

const { version, wrong } = disagreements(path.resolve(import.meta.dirname, ".."));
if (wrong.length) {
  console.error(`package.json says ${version}, but:\n${wrong.map(([l, v]) => `  ${l}: ${v ?? "(not found)"}`).join("\n")}`);
  process.exit(1);
}
console.log(`Version ${version} everywhere.`);
