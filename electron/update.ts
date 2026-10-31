import fs from "node:fs";
import path from "node:path";
import type { UpdateInfo } from "../shared/types.ts";
import { quote } from "./shell.ts";

/**
 * Launch-time update check against GitHub.
 *
 * This is the ONLY network request Agentree ever makes (documented in the
 * README, disabled with AGENTREE_NO_UPDATE_CHECK=1). It must never get in the
 * app's way: every failure path — offline, rate-limited, an unpushed dev
 * build GitHub has never heard of — resolves to `null`, silently.
 *
 * The build stamps its git commit, its `origin` repository and its branch
 * into dist-electron/build-info.json; the compare API then answers precisely
 * "has this branch moved past the running build?" for the repo it was built
 * from. A fork checks itself, never upstream; a feature branch compares with
 * itself, so the offered `git pull` is one that actually brings the update.
 * An unpushed branch is unknown to GitHub and stays silent. A tarball built
 * without git falls back to comparing package.json versions on `main`.
 */
const FALLBACK_REPO = "Sadeeptha-B/Agentree";
const TIMEOUT_MS = 6000;

interface BuildInfo {
  version?: string;
  commit?: string | null;
  /** "owner/name" of the checkout's GitHub origin. */
  repo?: string | null;
  /** Branch the build was made from; null when detached. */
  branch?: string | null;
}

/** Update in place: pull, then reinstall (npm install's prepare step rebuilds). */
function updateCommand(root: string): string {
  return process.platform === "win32"
    ? `Set-Location -LiteralPath ${quote(root, "win32")}; git pull; npm install`
    : `cd ${quote(root, "posix")} && git pull && npm install`;
}

function readBuildInfo(root: string): BuildInfo {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(root, "dist-electron", "build-info.json"), "utf8"),
    ) as BuildInfo;
  } catch {
    return {};
  }
}

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "agentree" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** "1.2.10" newer than "1.2.9"? Plain numeric segment compare. */
function newerVersion(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const d = (r[i] ?? 0) - (l[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

export async function checkForUpdate(appRoot: string): Promise<UpdateInfo | null> {
  if (process.env.AGENTREE_NO_UPDATE_CHECK) return null;
  const { version, commit, repo, branch } = readBuildInfo(appRoot);
  const REPO = repo || FALLBACK_REPO;
  const UPDATE_COMMAND = updateCommand(appRoot);

  try {
    if (commit) {
      const cmp = (await get(
        `https://api.github.com/repos/${REPO}/compare/${commit}...${(branch || "main").split("/").map(encodeURIComponent).join("/")}`,
      )) as { status?: string; commits?: { sha: string }[] };
      // "ahead": the branch moved past this build. "diverged": it moved AND
      // this build has local commits — `git pull` still brings the new ones.
      if (cmp.status !== "ahead" && cmp.status !== "diverged") return null;
      const latest = cmp.commits?.[cmp.commits.length - 1]?.sha ?? "latest";
      return {
        current: commit.slice(0, 7),
        latest: latest.slice(0, 7),
        command: UPDATE_COMMAND,
      };
    }

    if (version) {
      const remote = (await get(
        `https://raw.githubusercontent.com/${REPO}/main/package.json`,
      )) as { version?: string };
      if (remote.version && newerVersion(remote.version, version)) {
        return { current: version, latest: remote.version, command: UPDATE_COMMAND };
      }
    }
  } catch {
    /* offline, rate-limited, or unknown commit — never bother the user */
  }
  return null;
}
