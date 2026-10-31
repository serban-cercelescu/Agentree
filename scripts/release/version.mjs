// Every place that states Agentree's version, read and written in one place.
// package.json is the source; the code takes it from there at build time
// (electron/version.ts). The rest are files a release rewrites.
//
// Writes are text edits of the one field, never a reformat, and keep each
// file's line endings.
import fs from "node:fs";
import path from "node:path";

export const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** a > b, for X.Y.Z versions. */
export function newer(a, b) {
  const x = SEMVER.exec(a);
  const y = SEMVER.exec(b);
  if (!x || !y) throw new Error(`Not an X.Y.Z version: ${x ? b : a}`);
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]);
  return false;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Each place: the file, and a pattern whose group 2 is the version. The
 * patterns are anchored to where the field is, so a dependency that happens
 * to have the same version is never touched.
 */
const PLACES = [
  // The manifest's own version: the top-level field, two spaces in.
  { label: "package.json", file: "package.json", re: /^( {2}"version": ")([^"]*)(")/m },
  { label: "vscode-ext/package.json", file: "vscode-ext/package.json", re: /^( {2}"version": ")([^"]*)(")/m },
  // The lockfile states it twice: at its top, and for the root package ("").
  { label: "package-lock.json", file: "package-lock.json", re: /^( {2}"version": ")([^"]*)(")/m },
  { label: 'package-lock.json packages[""]', file: "package-lock.json", re: /^( {4}"": \{\r?\n {6}"name": "[^"]*",\r?\n {6}"version": ")([^"]*)(")/m },
  // The quick start's install command.
  { label: "README.md install command", file: "README.md", re: /(code --install-extension agentree-)([^\s]*?)(\.vsix)/ },
];

/** [label, version or null] for every place, under `root`. */
export function readVersions(root) {
  return PLACES.map(({ label, file, re }) => {
    const m = re.exec(fs.readFileSync(path.join(root, file), "utf8"));
    return [label, m ? m[2] : null];
  });
}

/** The places that don't state package.json's version (empty when all agree). */
export function disagreements(root) {
  const all = readVersions(root);
  const want = all[0][1];
  return { version: want, wrong: all.filter(([, v]) => v !== want) };
}

/**
 * Set every place to `next`, which must be newer than the current version
 * and every place must agree first. Returns the files changed.
 */
export function setVersion(root, next) {
  if (!SEMVER.test(next)) throw new Error(`Not an X.Y.Z version: ${next}`);
  const { version, wrong } = disagreements(root);
  if (wrong.length) throw new Error(`The version doesn't agree before the change: ${wrong.map(([l, v]) => `${l}: ${v}`).join(", ")}`);
  if (!newer(next, version)) throw new Error(`${next} is not newer than ${version}`);
  const texts = new Map();
  for (const { label, file, re } of PLACES) {
    const before = texts.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
    const after = before.replace(re, (_, a, v, b) => {
      if (v !== version) throw new Error(`${label} says ${v}, expected ${version}`);
      return `${a}${next}${b}`;
    });
    if (after === before) throw new Error(`${label}: version not found`);
    texts.set(file, after);
  }
  for (const [file, text] of texts) fs.writeFileSync(path.join(root, file), text);
  return [...texts.keys()];
}
