import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

test("pre-push isolates linked-worktree Git state and preserves a failing validation gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "scr-hook-fixture-"));
  const source = join(root, "source repository");
  const linked = join(root, "linked worktree");
  const target = join(root, "target.git");
  const foreign = join(root, "validation repository");
  const bin = join(root, "bin");
  const marker = join(root, "validation-ran");
  const env = { ...process.env };
  for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" }).trim().split(/\s+/)) {
    delete env[name];
  }
  delete env.SCR_SKIP_HOOKS;
  const git = (cwd, args) => execFileSync("git", args, { cwd, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (cwd, message) => git(cwd, ["-c", "user.name=Hook Test", "-c", "user.email=hook@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", message]);
  try {
    await mkdir(source);
    await mkdir(bin);
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "core.hooksPath", "scripts/hooks"]);
    await mkdir(join(source, "scripts", "hooks"), { recursive: true });
    await writeFile(join(source, "scripts", "hooks", "pre-push"), await readFile(new URL("./hooks/pre-push", import.meta.url)), { mode: 0o755 });
    await writeFile(join(source, "fixture.txt"), "initial\n");
    git(source, ["add", "."]);
    commit(source, "Initial fixture");
    git(source, ["worktree", "add", "-b", "feature", linked]);
    git(source, ["init", "--bare", target]);
    await writeFile(join(bin, "pnpm"), [
      "#!/bin/sh",
      "set -e",
      'test "$#" -eq 1 && test "$1" = verify:push',
      'git init --quiet "$SCR_HOOK_FOREIGN"',
      'git -C "$SCR_HOOK_FOREIGN" config user.name "Validation fixture"',
      'printf checked > "$SCR_HOOK_MARKER"',
      'exit "$SCR_HOOK_EXIT"',
      "",
    ].join("\n"), { mode: 0o755 });
    const pathKey = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = bin + delimiter + (env[pathKey] ?? "");
    env.SCR_HOOK_FOREIGN = foreign;
    env.SCR_HOOK_MARKER = marker;
    env.SCR_HOOK_EXIT = "0";
    const sourceConfig = await readFile(join(source, ".git", "config"));
    const before = git(linked, ["rev-parse", "HEAD"]);
    git(linked, ["push", target, "HEAD:refs/heads/main"]);
    assert.equal(await readFile(marker, "utf8"), "checked");
    assert.deepEqual(await readFile(join(source, ".git", "config")), sourceConfig);
    assert.equal(git(linked, ["rev-parse", "HEAD"]), before);
    assert.equal(git(linked, ["status", "--porcelain"]), "");
    assert.equal(git(foreign, ["config", "user.name"]), "Validation fixture");
    assert.equal(git(source, ["--git-dir=" + target, "rev-parse", "refs/heads/main"]), before);
    await rm(marker);
    await writeFile(join(linked, "fixture.txt"), "changed\n");
    git(linked, ["add", "fixture.txt"]);
    commit(linked, "Next fixture");
    env.SCR_HOOK_EXIT = "42";
    const denied = spawnSync("git", ["push", target, "HEAD:refs/heads/main"], { cwd: linked, env, encoding: "utf8", windowsHide: true });
    assert.notEqual(denied.status, 0, denied.stderr);
    assert.equal(await readFile(marker, "utf8"), "checked");
    assert.deepEqual(await readFile(join(source, ".git", "config")), sourceConfig);
    assert.equal(git(source, ["--git-dir=" + target, "rev-parse", "refs/heads/main"]), before);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
