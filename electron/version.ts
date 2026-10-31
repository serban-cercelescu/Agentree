declare const __AGENTREE_VERSION__: string | undefined;

/**
 * Agentree's version: package.json's, written into the bundles at build time
 * (esbuild `define` in build-electron.mjs and build-vscode.mjs), so a release
 * changes it in one place. "dev" when run from source, as the tests do.
 */
export const AGENTREE_VERSION = typeof __AGENTREE_VERSION__ === "string" ? __AGENTREE_VERSION__ : "dev";
