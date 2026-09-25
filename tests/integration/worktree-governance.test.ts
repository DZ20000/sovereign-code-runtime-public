import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

function read(...parts: string[]): string {
  return readFileSync(resolve(process.cwd(), ...parts), "utf8");
}

function withWorktreeFixture(check: (fixture: {
  repository: string;
  worktree: string;
  temporary: string;
  git: (...args: string[]) => string;
  run: (...args: string[]) => ReturnType<typeof spawnSync>;
}) => void): void {
  const script = resolve("scripts/worktrees.mjs");
  const tempParent = realpathSync.native(tmpdir());
  const temporary = mkdtempSync(join(tempParent, "so-worktree-lifecycle-test-"));
  const repository = join(temporary, "repository");
  const worktree = join(repository, ".worktrees", "active-task");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_"))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const options = { cwd: repository, env, encoding: "utf8" as const, windowsHide: true, timeout: 15_000 };
  const git = (...args: string[]): string => execFileSync("git", args, options);
  try {
    mkdirSync(repository);
    git("init", "--initial-branch=main", "--template=");
    writeFileSync(join(repository, ".gitignore"), ".worktrees/\n.sovereign/\n");
    writeFileSync(join(repository, "task.txt"), "committed work still in use\n");
    git("add", ".");
    git("-c", "user.name=Worktree test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
    git("worktree", "add", "-b", "active-task", worktree);
    check({ repository, worktree, temporary, git, run: (...args) => spawnSync(process.execPath, [script, ...args], options) });
  } finally {
    assert.equal(dirname(temporary), tempParent);
    assert(basename(temporary).startsWith("so-worktree-lifecycle-test-"));
    const verify = (path: string): void => {
      const info = lstatSync(path);
      assert(!info.isSymbolicLink(), `Refusing linked cleanup target: ${path}`);
      const canonical = realpathSync.native(path);
      const child = relative(temporary, canonical);
      assert(!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
      assert.equal(resolve(path), canonical);
      if (info.isDirectory()) for (const name of readdirSync(path)) verify(join(path, name));
    };
    verify(temporary);
    rmSync(temporary, { recursive: true, maxRetries: 3, retryDelay: 100 });
  }
}

describe("worktree lifecycle governance", () => {
  it("exposes bounded managed commands", () => {
    const pkg = JSON.parse(read("package.json")) as {
      readonly scripts: Readonly<Record<string, string>>;
    };
    expect(pkg.scripts["worktrees:audit"]).toBe("node scripts/worktrees.mjs audit");
    expect(pkg.scripts["worktrees:guard"]).toBe("node scripts/worktrees.mjs guard");
    expect(pkg.scripts["worktree:create"]).toBe("node scripts/worktrees.mjs create");
    expect(pkg.scripts["worktree:finish"]).toBe("node scripts/worktrees.mjs finish");
  });

  it("uses parameterized Git calls and strict path guards", () => {
    const script = read("scripts", "worktrees.mjs");
    expect(script).toContain("const DEFAULT_MAX_WORKTREES = 8");
    expect(script).toContain("const DEFAULT_MAX_DIRTY_WORKTREES = 4");
    expect(script).toContain("shell: false");
    expect(script).toContain("assertManagedPath");
    expect(script).toContain("Refusing to remove dirty worktree");
    expect(script).not.toContain("cmd.exe");
    expect(script).not.toContain("Remove-Item");
  });

  it("prune --all-clean lists a clean worktree without removing its files or registration", () => {
    withWorktreeFixture(({ worktree, git, run }) => {
      expect(git("-C", worktree, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
      const registered = git("worktree", "list", "--porcelain");
      const branchHead = git("rev-parse", "active-task");

      const result = run("prune", "--all-clean");
      expect(result.status).toBe(0);
      const output = result.stdout;

      expect(output).toContain("active-task");
      expect(output).toContain("1 clean candidate(s); no worktrees removed");
      expect(lstatSync(worktree).isDirectory()).toBe(true);
      expect(readFileSync(join(worktree, "task.txt"), "utf8")).toBe("committed work still in use\n");
      expect(git("worktree", "list", "--porcelain")).toBe(registered);
      expect(git("rev-parse", "active-task")).toBe(branchHead);
      expect(git("-C", worktree, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    });
  }, 30_000);

  it("finish refuses ignored hidden deliverables and links while preserving files, registration and branch", () => {
    withWorktreeFixture(({ worktree, temporary, git, run }) => {
      const ignored = join(worktree, ".sovereign");
      const deliverable = join(ignored, ".pending", "user-deliverable.txt");
      const link = join(ignored, "linked-output");
      const output = join(temporary, "linked-output");
      mkdirSync(dirname(deliverable), { recursive: true });
      writeFileSync(deliverable, "unaccepted user work\n");
      mkdirSync(output);
      writeFileSync(join(output, "result.txt"), "linked result\n");
      symlinkSync(output, link, process.platform === "win32" ? "junction" : "dir");
      try {
        expect(git("-C", worktree, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
        const registered = git("worktree", "list", "--porcelain");
        const branchHead = git("rev-parse", "active-task");
        for (const onlyLink of [false, true]) {
          if (onlyLink) unlinkSync(deliverable);
          const result = run("finish", "active-task");
          expect(result.status).toBe(1);
          expect(result.stderr).toContain("ignored path(s) remain");
          if (!onlyLink) expect(readFileSync(deliverable, "utf8")).toBe("unaccepted user work\n");
          expect(lstatSync(link).isSymbolicLink()).toBe(true);
          expect(readFileSync(join(output, "result.txt"), "utf8")).toBe("linked result\n");
          expect(git("worktree", "list", "--porcelain")).toBe(registered);
          expect(git("rev-parse", "active-task")).toBe(branchHead);
        }
      } finally {
        assert.equal(realpathSync.native(link), realpathSync.native(output));
        assert(lstatSync(link).isSymbolicLink());
        unlinkSync(link);
      }
    });
  }, 30_000);

  it("finish removes an inactive clean worktree without ignored contents and preserves its branch", () => {
    withWorktreeFixture(({ worktree, git, run }) => {
      const branchHead = git("rev-parse", "active-task");
      const result = run("finish", "active-task");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("branch active-task remains available");
      expect(existsSync(worktree)).toBe(false);
      expect(git("worktree", "list", "--porcelain")).not.toContain("refs/heads/active-task");
      expect(git("rev-parse", "active-task")).toBe(branchHead);
    });
  }, 30_000);

  it("documents root, escape, timeout and nested-shell protections", () => {
    const rules = read("CONTRIBUTING.md");
    expect(rules).toContain("Never construct recursive deletion commands");
    expect(rules).toContain("Never use `\\\"` as a PowerShell quote escape");
    expect(rules).toContain("Refuse volume roots");
    expect(rules).toContain("A timeout is an unknown execution state");
  });
});
