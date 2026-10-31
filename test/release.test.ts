import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { disagreements, newer, readVersions, setVersion } from "../scripts/release/version.mjs";

// The release script's version edits, on copies of the real files: every
// place moves together, nothing else in them changes, and a bad request
// writes nothing.
const ROOT = path.resolve(__dirname, "..");
const FILES = ["package.json", "package-lock.json", "vscode-ext/package.json", "README.md"];

function copy(eol?: "\r\n"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-release-"));
  fs.mkdirSync(path.join(dir, "vscode-ext"));
  for (const f of FILES) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
    fs.writeFileSync(path.join(dir, f), eol ? text.replace(/\n/g, eol) : text);
  }
  return dir;
}
const read = (dir: string) => Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(dir, f), "utf8")]));
const current = (): string => disagreements(ROOT).version ?? "";
const bump = (v: string) => v.replace(/\d+$/, (n) => String(Number(n) + 1));

describe("setting the version", () => {
  it("moves every place together and changes nothing else", () => {
    const dir = copy();
    const before = read(dir);
    const next = bump(current());
    setVersion(dir, next);
    expect(readVersions(dir).map((e) => e[1])).toEqual(Array(5).fill(next));
    const after = read(dir);
    for (const f of FILES) {
      const a = before[f].split("\n");
      const b = after[f].split("\n");
      expect(b.length).toBe(a.length);
      const changed = a.filter((line: string, i: number) => line !== b[i]);
      // One line per place: the lockfile states it twice.
      expect(changed.length).toBe(f === "package-lock.json" ? 2 : 1);
      // A lockfile's dependencies keep their own versions.
      expect(changed.every((line: string) => line.includes(current()))).toBe(true);
    }
    expect(JSON.parse(after["package-lock.json"]).packages[""].version).toBe(next);
  });

  it("keeps CRLF line endings", () => {
    const dir = copy("\r\n");
    setVersion(dir, bump(current()));
    for (const f of FILES) expect(read(dir)[f].replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("refuses a version that isn't newer, isn't X.Y.Z, or a tree that already disagrees, and writes nothing", () => {
    const dir = copy();
    const before = read(dir);
    expect(() => setVersion(dir, current())).toThrow(/not newer/);
    expect(() => setVersion(dir, "0.0.1")).toThrow(/not newer/);
    expect(() => setVersion(dir, "v9.0.0")).toThrow(/X\.Y\.Z/);
    expect(() => setVersion(dir, "9.0")).toThrow(/X\.Y\.Z/);
    expect(read(dir)).toEqual(before);

    fs.writeFileSync(path.join(dir, "README.md"), before["README.md"].replace(/agentree-[^\s]+\.vsix/, "agentree-0.0.9.vsix"));
    expect(disagreements(dir).wrong.map((e) => e[0])).toEqual(["README.md install command"]);
    expect(() => setVersion(dir, "9.0.0")).toThrow(/doesn't agree/);
    expect(read(dir)["package.json"]).toEqual(before["package.json"]);
  });

  it("orders versions numerically", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
    expect(newer("0.2.1", "0.3.0")).toBe(false);
  });
});

// prepare.mjs in a scratch repository with a local bare `origin` (its path
// has the github.com/owner/repo shape the script looks for) and a fake `gh`.
// POSIX only: Node finds a stand-in `gh` on PATH there, not on Windows.
describe.skipIf(process.platform === "win32")("preparing a release", () => {
  const NEXT = "9.9.9";
  const BRANCH = `release/v${NEXT}`;

  function scratch() {
    const dir = copy();
    const log = path.join(dir, "..", `${path.basename(dir)}-gh.log`);
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-origin-"));
    const bare = path.join(origin, "github.com", "acme", "agentree.git");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentree-bin-"));
    fs.writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_LOG"
case "$1" in
  auth) exit 0 ;;
  api) echo "the notes" ;;
  pr) if [ -n "$GH_FAIL_PR" ]; then echo "pull request refused" >&2; exit 1; fi
      echo "https://github.com/acme/agentree/pull/1" ;;
esac
`,
      { mode: 0o755 },
    );
    fs.mkdirSync(path.join(dir, "scripts", "release"), { recursive: true });
    for (const f of ["prepare.mjs", "version.mjs"]) fs.copyFileSync(path.join(ROOT, "scripts", "release", f), path.join(dir, "scripts", "release", f));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "t");
    git("config", "user.email", "t@example.com");
    git("add", ".");
    git("commit", "-q", "-m", "start");
    git("remote", "add", "origin", bare);
    git("push", "-q", "origin", "main");
    git("switch", "-q", "-c", "work");
    const prepare = (env: Record<string, string> = {}) =>
      spawnSync(process.execPath, ["scripts/release/prepare.mjs", NEXT], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GH_LOG: log, ...env },
      });
    return { bare, git, log, prepare };
  }
  const refuse = (bare: string) => fs.writeFileSync(path.join(bare, "hooks", "pre-receive"), "#!/bin/sh\necho refused >&2\nexit 1\n", { mode: 0o755 });

  it("opens the pull request, asks for the evidence, and returns you to your branch", () => {
    const { git, log, prepare } = scratch();
    const res = prepare();
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(git("branch", "--show-current")).toBe("work");
    expect(git("ls-remote", "--heads", "origin", BRANCH)).toContain(BRANCH);
    const gh = fs.readFileSync(log, "utf8");
    expect(gh).toContain("--repo acme/agentree");
    expect(gh).toMatch(/Real-store audit/);
    expect(gh).toMatch(/Native canaries/);
  });

  it("when the push fails: back on your branch, the commit kept, and how to finish", () => {
    const { bare, git, prepare } = scratch();
    refuse(bare);
    const res = prepare();
    expect(res.status).toBe(1);
    expect(git("branch", "--show-current")).toBe("work");
    expect(git("show", `${BRANCH}:package.json`)).toContain(`"version": "${NEXT}"`);
    expect(res.stderr).toContain(`git push -u origin ${BRANCH}`);
    expect(res.stderr).toContain(`gh pr create --repo acme/agentree --base main --head ${BRANCH}`);
    expect(res.stderr).toContain(`git branch -D ${BRANCH}`);
    expect(res.stderr).not.toContain("push origin --delete");
  });

  it("when the pull request fails after the push: only what's left to do", () => {
    const { git, prepare } = scratch();
    const res = prepare({ GH_FAIL_PR: "1" });
    expect(res.status).toBe(1);
    expect(git("branch", "--show-current")).toBe("work");
    expect(res.stderr).toContain("pull request refused");
    expect(res.stderr).not.toContain("git push -u");
    expect(res.stderr).toContain(`gh pr create --repo acme/agentree --base main --head ${BRANCH}`);
    expect(res.stderr).toContain(`git push origin --delete ${BRANCH}`);
  });
});
