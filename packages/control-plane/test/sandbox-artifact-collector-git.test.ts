import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { SandboxArtifactCollector } from "../src/sandbox-artifact-collector.js";
import { sandboxHostEnvironment } from "../src/sandbox-process-runner.js";

const exec = promisify(execFile);
const environment = sandboxHostEnvironment({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    env: environment,
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 262_144,
  });
  return result.stdout;
}

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return address.port;
}

async function startDaemon(
  root: string,
  port: number,
): Promise<() => Promise<void>> {
  const child = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      "--verbose",
      "--export-all",
      "--listen=127.0.0.1",
      `--port=${port}`,
      `--base-path=${root}`,
      root,
    ],
    {
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostic = "";
  child.stderr?.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString("utf8")).slice(-4_096);
  });
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  async function stop(): Promise<void> {
    if (
      child.exitCode === null &&
      child.signalCode === null &&
      child.pid !== undefined
    ) {
      await terminate(child);
    }
    await closed;
  }
  try {
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Git daemon not ready: ${diagnostic}`)),
        10_000,
      );
      const onData = (): void => {
        if (diagnostic.includes("Ready to rumble")) finish();
      };
      const onError = (error: Error): void => finish(error);
      const onExit = (): void =>
        finish(new Error(`Git daemon exited: ${diagnostic}`));
      function finish(error?: Error): void {
        clearTimeout(timer);
        child.stderr?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolveReady();
      }
      child.stderr?.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    await exec(
      join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true, timeout: 10_000 },
    );
  } else {
    child.kill("SIGTERM");
  }
}

async function removeOwnedTemp(
  root: string,
  tempParent: string,
): Promise<void> {
  assert.equal(dirname(root), tempParent);
  assert(basename(root).startsWith("sovereign-collector-git-"));
  async function verify(path: string): Promise<void> {
    const stat = await lstat(path);
    assert(!stat.isSymbolicLink(), `Refusing linked cleanup target: ${path}`);
    const actual = await realpath(path);
    const childPath = relative(root, actual);
    assert(
      !isAbsolute(childPath) &&
        childPath !== ".." &&
        !childPath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
    );
    assert.equal(resolve(path), actual);
    if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await verify(join(path, entry));
    }
  }
  await verify(root);
  await rm(root, { recursive: true, maxRetries: 3, retryDelay: 100 });
}

it("collects real loopback Git commits without changing host work, existing refs, or fetching host submodules", async () => {
  const tempParent = await realpath(tmpdir());
  // Missing Git is an actionable failure, never a skipped integration check.
  expect(await git(tempParent, "--version")).toMatch(/^git version /u);
  const root = await mkdtemp(join(tempParent, "sovereign-collector-git-"));
  let stopDaemon: (() => Promise<void>) | undefined;
  let submoduleConnections = 0;
  const submoduleOrigin = createServer((socket) => {
    submoduleConnections += 1;
    socket.destroy();
  });
  try {
    const host = join(root, "host");
    const source = join(root, "source");
    for (const repo of [host, source]) {
      await mkdir(repo);
      await git(repo, "init", "--initial-branch=main", "--template=");
      await git(repo, "config", "user.name", "Sandbox collection test");
      await git(repo, "config", "user.email", "sandbox-test@example.invalid");
      await git(repo, "config", "commit.gpgSign", "false");
      await git(repo, "config", "core.autocrlf", "false");
      await writeFile(join(repo, "tracked.txt"), `${basename(repo)} initial\n`);
      await git(repo, "add", "tracked.txt");
      await git(repo, "commit", "-m", "initial");
    }
    await new Promise<void>((resolveListen, reject) => {
      submoduleOrigin.once("error", reject);
      submoduleOrigin.listen(0, "127.0.0.2", resolveListen);
    });
    const submoduleAddress = submoduleOrigin.address();
    assert(submoduleAddress !== null && typeof submoduleAddress !== "string");
    await git(host, "-c", "protocol.file.allow=always", "submodule", "add", source, "dependency");
    await git(host, "commit", "-am", "initialized host submodule");
    await git(host, "config", "fetch.recurseSubmodules", "true");
    await git(
      join(host, "dependency"), "remote", "set-url", "origin",
      `git://127.0.0.2:${submoduleAddress.port}/outside-managed-sandbox`,
    );
    const initialSource = (await git(source, "rev-parse", "HEAD")).trim();
    await git(source, "branch", "feature/old-artifact");
    await git(source, "tag", "not-collected");
    await git(host, "branch", "existing-branch");
    await git(host, "tag", "existing-tag");
    await git(host, "update-ref", "refs/remotes/other/main", "HEAD");
    await git(
      host,
      "update-ref",
      "refs/sovereign/sandboxes/other/branches/keep",
      "HEAD",
    );
    await writeFile(join(host, "tracked.txt"), "host staged\n");
    await git(host, "add", "tracked.txt");
    await writeFile(join(host, "tracked.txt"), "host unstaged\n");
    await writeFile(join(host, "untracked.txt"), "host untracked\n");
    await writeFile(join(host, ".git", "FETCH_HEAD"), "preserve fetch head\n");
    const sandboxId = "7b7decd0-d046-4d63-b6f1-8260ef6ca638";
    const sandboxName = "sovereign-build-1234abcd";
    const prefix = `refs/sovereign/sandboxes/${sandboxId}/branches/`;
    const port = await availableLoopbackPort();
    stopDaemon = await startDaemon(root, port);
    await git(
      host,
      "remote",
      "add",
      `sandbox-${sandboxName}`,
      `git://127.0.0.1:${port}/source/.git`,
    );
    const existingRefs = async (): Promise<string[]> =>
      (await git(host, "for-each-ref", "--format=%(refname) %(objectname)"))
        .split(/\r?\n/u)
        .filter((line) => !line.startsWith(prefix));
    const snapshot = async () => ({
      head: await readFile(join(host, ".git", "HEAD")),
      index: await readFile(join(host, ".git", "index")),
      fetchHead: await readFile(join(host, ".git", "FETCH_HEAD")),
      config: await readFile(join(host, ".git", "config")),
      tracked: await readFile(join(host, "tracked.txt")),
      untracked: await readFile(join(host, "untracked.txt")),
      files: (await readdir(host)).sort(),
      refs: await existingRefs(),
    });
    const before = await snapshot();
    const collector = new SandboxArtifactCollector({ workspaceRoot: host });
    const first = await collector.collect(sandboxId, sandboxName);
    expect(submoduleConnections).toBe(0);
    expect(first.refCount).toBe(2);
    expect(first.refs.map((entry) => entry.branch).sort()).toEqual([
      "feature/old-artifact",
      "main",
    ]);
    for (const entry of first.refs) {
      expect(entry.ref).toMatch(new RegExp(`^${prefix}[a-f0-9]{64}$`, "u"));
      expect(entry.commit).toBe(initialSource);
      expect((await git(host, "cat-file", "-t", entry.ref)).trim()).toBe(
        "commit",
      );
      expect(await git(host, "show", `${entry.ref}:tracked.txt`)).toBe(
        "source initial\n",
      );
    }
    expect(await snapshot()).toEqual(before);

    await writeFile(join(source, "tracked.txt"), "source committed update\n");
    await git(source, "commit", "-am", "updated artifact");
    const updatedSource = (await git(source, "rev-parse", "HEAD")).trim();
    await git(source, "branch", "-D", "feature/old-artifact");
    await git(source, "branch", "feature/new-artifact");
    await writeFile(
      join(source, "tracked.txt"),
      "uncommitted sandbox change\n",
    );
    await writeFile(
      join(source, "private-untracked.txt"),
      "untracked sandbox change\n",
    );
    const second = await collector.collect(sandboxId, sandboxName);
    expect(submoduleConnections).toBe(0);
    expect(second.collectionId).not.toBe(first.collectionId);
    expect(second.refCount).toBe(2);
    expect(second.refs.map((entry) => entry.branch).sort()).toEqual([
      "feature/new-artifact",
      "main",
    ]);
    expect(second.refs.find((entry) => entry.branch === "main")?.ref).toBe(
      first.refs.find((entry) => entry.branch === "main")?.ref,
    );
    const stale = first.refs.find(
      (entry) => entry.branch === "feature/old-artifact",
    )!;
    expect(
      await git(host, "for-each-ref", "--format=%(refname)", stale.ref),
    ).toBe("");
    for (const entry of second.refs) {
      expect(entry.commit).toBe(updatedSource);
      expect(await git(host, "show", `${entry.ref}:tracked.txt`)).toBe(
        "source committed update\n",
      );
      expect(await git(host, "ls-tree", "--name-only", entry.ref)).toBe(
        "tracked.txt\n",
      );
    }
    expect(await snapshot()).toEqual(before);
  } finally {
    await stopDaemon?.();
    if (submoduleOrigin.listening) {
      await new Promise<void>((resolveClose, reject) => {
        submoduleOrigin.close((error) => error ? reject(error) : resolveClose());
      });
    }
    await removeOwnedTemp(root, tempParent);
  }
}, 60_000);
