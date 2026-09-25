import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SBX_REVIEWED_VERSION,
  SandboxManager,
  type SandboxProcessResult,
  type SandboxProcessRunner,
} from "../src/sandbox-manager.js";

const cleanupPaths: string[] = [];

interface RunnerCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

function processResult(
  stdout = "",
  stderr = "",
  exitCode = 0,
  overrides: Partial<SandboxProcessResult> = {},
): SandboxProcessResult {
  return {
    commandLabel: "fake sbx",
    exitCode,
    signal: null,
    durationMs: 5,
    stdout,
    stderr,
    outputTruncated: false,
    timedOut: false,
    ...overrides,
  };
}

async function fixture(
  options: {
    readonly authenticated?: boolean;
    readonly linkedWorktree?: boolean;
    readonly listSchema?: "array" | "object" | "invalid";
    readonly onExecStarted?: () => void;
    readonly waitForExecRelease?: Promise<void>;
    readonly gitRunner?: SandboxProcessRunner;
  } = {},
): Promise<{
  readonly root: string;
  readonly workspaceRoot: string;
  readonly registryPath: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly calls: RunnerCall[];
  readonly runner: SandboxProcessRunner;
  readonly manager: SandboxManager;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-sandbox-manager-"));
  cleanupPaths.push(root);
  const workspaceRoot = join(root, "workspace");
  const securityRoot = join(root, "security");
  const executableRoot = join(root, "trusted-bin");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(securityRoot, { recursive: true }),
    mkdir(executableRoot, { recursive: true }),
  ]);
  if (options.linkedWorktree === true) {
    await writeFile(
      join(workspaceRoot, ".git"),
      "gitdir: ../main/.git/worktrees/test\n",
      "utf8",
    );
  } else {
    await mkdir(join(workspaceRoot, ".git"), { recursive: true });
  }
  const executablePath = join(executableRoot, "sbx.exe");
  const executableContent = Buffer.from("reviewed fake sbx binary", "utf8");
  await writeFile(executablePath, executableContent);
  const executableSha256 = createHash("sha256")
    .update(executableContent)
    .digest("hex");
  const registryPath = join(securityRoot, "sandboxes.json");
  const calls: RunnerCall[] = [];
  const observed = new Map<string, string>();
  const authenticated = options.authenticated ?? true;
  const listSchema = options.listSchema ?? "array";
  const runner: SandboxProcessRunner = async (command, args, runOptions) => {
    calls.push({
      command,
      args: [...args],
      cwd: runOptions.cwd,
      timeoutMs: runOptions.timeoutMs,
      maxOutputBytes: runOptions.maxOutputBytes,
    });
    if (args[0] === "version") {
      return processResult(`sbx version: v${SBX_REVIEWED_VERSION} deadbeef\n`);
    }
    if (args[0] === "ls" && args[1] === "--json") {
      if (!authenticated) {
        return processResult(
          "",
          "ERROR: Not authenticated to Docker\nSign in with: sbx login\n",
          1,
        );
      }
      if (listSchema === "invalid") {
        return processResult(JSON.stringify({ unexpected: [] }));
      }
      const sandboxes = [...observed].map(([name, status]) => ({
        name,
        status,
      }));
      return processResult(
        JSON.stringify(listSchema === "object" ? { sandboxes } : sandboxes),
      );
    }
    if (args[0] === "create") {
      const nameIndex = args.indexOf("--name");
      const name = nameIndex >= 0 ? args[nameIndex + 1] : undefined;
      if (name === undefined) {
        return processResult("", "missing name", 2);
      }
      observed.set(name, "running");
      return processResult(`created ${name}\n`);
    }
    if (args[0] === "exec") {
      options.onExecStarted?.();
      await options.waitForExecRelease;
      return processResult("sandbox-output\n");
    }
    if (args[0] === "stop") {
      const name = args[1];
      if (name !== undefined) observed.set(name, "stopped");
      return processResult();
    }
    if (args[0] === "rm") {
      const name = args.at(-1);
      if (name !== undefined) observed.delete(name);
      return processResult();
    }
    return processResult("", `unexpected command: ${args.join(" ")}`, 2);
  };
  const manager = new SandboxManager({
    workspaceRoot,
    registryPath,
    executablePath,
    expectedVersion: SBX_REVIEWED_VERSION,
    expectedExecutableSha256: executableSha256,
    runner,
    ...(options.gitRunner === undefined
      ? {}
      : { gitRunner: options.gitRunner }),
  });
  return {
    root,
    workspaceRoot,
    registryPath,
    executablePath,
    executableSha256,
    calls,
    runner,
    manager,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      }),
    ),
  );
});

describe("SandboxManager", () => {
  it("verifies the executable supply chain and reports authentication state", async () => {
    const ready = await fixture();
    await expect(ready.manager.capabilities()).resolves.toMatchObject({
      provider: "docker-sbx",
      available: true,
      trusted: true,
      compatible: true,
      authenticated: true,
      version: SBX_REVIEWED_VERSION,
      executableSha256: ready.executableSha256,
      loginRequired: false,
      reason: null,
      guarantees: {
        microVm: true,
        privateClone: true,
        hostRepositoryReadOnly: true,
        hostWorkingTree: "unchanged",
        hostGitConfig: "sandbox-remote-managed",
        network: "deny-all",
        hostShell: false,
        privilegedExec: false,
        hostPathCopy: false,
      },
    });

    const unauthenticated = await fixture({ authenticated: false });
    await expect(unauthenticated.manager.capabilities()).resolves.toMatchObject(
      {
        available: true,
        trusted: true,
        compatible: true,
        authenticated: false,
        loginRequired: true,
        reason: expect.stringMatching(/sbx login/u),
      },
    );
    await expect(unauthenticated.manager.list()).rejects.toMatchObject({
      code: "AUTH_REQUIRED",
    });

    const untrusted = new SandboxManager({
      workspaceRoot: ready.workspaceRoot,
      registryPath: join(ready.root, "other-security", "sandboxes.json"),
      executablePath: ready.executablePath,
      expectedVersion: SBX_REVIEWED_VERSION,
      expectedExecutableSha256: "0".repeat(64),
      runner: ready.runner,
    });
    await expect(untrusted.capabilities()).resolves.toMatchObject({
      available: true,
      trusted: false,
      compatible: false,
      authenticated: false,
      reason: expect.stringMatching(/version or SHA-256/u),
    });
    await expect(untrusted.list()).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
  });

  it("creates only clone-mode deny-all sandboxes and controls owned names", async () => {
    const fixtureValue = await fixture({ listSchema: "object" });
    const created = await fixtureValue.manager.create({
      label: "Dependency audit",
      cpus: 2,
      memoryMiB: 4_096,
    });

    expect(created).toMatchObject({
      label: "Dependency audit",
      provider: "docker-sbx",
      status: "created",
      cpus: 2,
      memoryMiB: 4_096,
      isolation: {
        mode: "clone",
        hostRepository: "read-only",
        hostWorkingTree: "unchanged",
        hostGitConfig: "sandbox-remote-managed",
        network: "deny-all",
      },
    });
    const createCall = fixtureValue.calls.find(
      (call) => call.args[0] === "create",
    );
    expect(createCall).toBeDefined();
    expect(createCall?.command).toBe(fixtureValue.executablePath);
    expect(createCall?.cwd).toBe(fixtureValue.workspaceRoot);
    expect(createCall?.args).toEqual([
      "create",
      "--clone",
      "--name",
      expect.stringMatching(/^sovereign-dependency-audit-[a-f0-9]{8}$/u),
      "--cpus",
      "2",
      "--memory",
      "4096m",
      "--deny-network",
      "**",
      "shell",
      fixtureValue.workspaceRoot,
    ]);
    expect(createCall?.args).not.toContain("--env");
    expect(createCall?.args).not.toContain("--privileged");
    expect(createCall?.args).not.toContain("--publish");

    const registry = JSON.parse(
      await readFile(fixtureValue.registryPath, "utf8"),
    ) as {
      entries: Array<{ id: string; name: string }>;
    };
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]?.id).toBe(created.id);

    await expect(fixtureValue.manager.list()).resolves.toMatchObject({
      count: 1,
      sandboxes: [
        expect.objectContaining({ id: created.id, status: "running" }),
      ],
    });
    const execution = await fixtureValue.manager.exec(
      created.id,
      "pnpm test",
      30_000,
    );
    expect(execution).toMatchObject({
      exitCode: 0,
      stdout: "sandbox-output\n",
      commandLabel: expect.stringMatching(
        /^sbx exec sovereign-.+ bash -lc <command:[a-f0-9]{64}>$/u,
      ),
    });
    expect(execution.commandLabel).not.toContain("pnpm test");
    const execCall = fixtureValue.calls.find((call) => call.args[0] === "exec");
    expect(execCall?.args).toEqual([
      "exec",
      registry.entries[0]?.name,
      "bash",
      "-lc",
      'cd "$(git rev-parse --show-toplevel)" && pnpm test',
    ]);

    await expect(fixtureValue.manager.stop(created.id)).resolves.toMatchObject({
      id: created.id,
      status: "stopped",
    });
    await expect(fixtureValue.manager.remove(created.id)).resolves.toEqual({
      removed: true,
      id: created.id,
    });
    await expect(fixtureValue.manager.list()).resolves.toMatchObject({
      count: 0,
      sandboxes: [],
    });
    await expect(
      fixtureValue.manager.exec(created.id, "true"),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
  });

  it("allows stop during active execution and blocks destructive removal until execution settles", async () => {
    let resolveStarted!: () => void;
    let releaseExec!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const execRelease = new Promise<void>((resolve) => {
      releaseExec = resolve;
    });
    const fixtureValue = await fixture({
      onExecStarted: resolveStarted,
      waitForExecRelease: execRelease,
    });
    const created = await fixtureValue.manager.create({
      label: "Concurrent stop",
      cpus: 2,
      memoryMiB: 4_096,
    });
    const execution = fixtureValue.manager.exec(created.id, "sleep 30", 60_000);
    await started;

    await expect(
      Promise.race([
        fixtureValue.manager.stop(created.id),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(new Error("sandbox.stop was blocked behind sandbox.exec")),
            2_000,
          );
        }),
      ]),
    ).resolves.toMatchObject({
      id: created.id,
      status: "stopped",
    });
    await expect(fixtureValue.manager.remove(created.id)).rejects.toMatchObject(
      {
        code: "POLICY_DENIED",
      },
    );

    releaseExec();
    await expect(execution).resolves.toMatchObject({
      exitCode: 0,
      stdout: "sandbox-output\n",
    });
    await expect(fixtureValue.manager.remove(created.id)).resolves.toEqual({
      removed: true,
      id: created.id,
    });
  });

  it("fences stop and removal while committed sandbox work is being collected", async () => {
    let resolveStarted!: () => void;
    let releaseFetch!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const fetchRelease = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const commit = "c".repeat(40);
    let destinationRef = "";
    const gitRunner: SandboxProcessRunner = async (_command, args) => {
      if (args[0] === "config" && args.includes("--name-only")) {
        return processResult("core.repositoryformatversion\n");
      }
      if (args[0] === "config" && args.includes("--get-all")) {
        return processResult("git://127.0.0.1:9418/sandbox.git\n");
      }
      if (args.includes("ls-remote")) {
        return processResult(`${commit}\trefs/heads/main\n`);
      }
      if (args.includes("fetch")) {
        const refspec = args.find((argument) =>
          argument.startsWith("+refs/heads/main:"),
        );
        destinationRef = refspec?.split(":", 2)[1] ?? "";
        resolveStarted();
        await fetchRelease;
        return processResult();
      }
      if (args.includes("for-each-ref")) {
        const verifiesObjectType = args.some((argument) =>
          argument.includes("%(objecttype)"),
        );
        if (!verifiesObjectType) return processResult();
        return processResult(`${destinationRef}\t${commit}\tcommit\n`);
      }
      return processResult("", `unexpected git call: ${args.join(" ")}`, 2);
    };
    const fixtureValue = await fixture({ gitRunner });
    const created = await fixtureValue.manager.create({
      label: "Collect results",
      cpus: 2,
      memoryMiB: 4_096,
    });

    const collection = fixtureValue.manager.collect(created.id);
    await started;
    await expect(fixtureValue.manager.stop(created.id)).rejects.toMatchObject({
      code: "POLICY_DENIED",
    });
    await expect(fixtureValue.manager.remove(created.id)).rejects.toMatchObject(
      {
        code: "POLICY_DENIED",
      },
    );

    releaseFetch();
    await expect(collection).resolves.toMatchObject({
      sandboxId: created.id,
      refCount: 1,
      refs: [{ branch: "main", commit }],
    });
    await expect(fixtureValue.manager.stop(created.id)).resolves.toMatchObject({
      id: created.id,
      status: "stopped",
    });
    await expect(fixtureValue.manager.remove(created.id)).resolves.toEqual({
      removed: true,
      id: created.id,
    });
  });

  it("rejects linked worktrees, workspace-controlled registries, executables, and schema drift", async () => {
    const linked = await fixture({ linkedWorktree: true });
    await expect(
      linked.manager.create({
        label: "Linked worktree",
        cpus: 2,
        memoryMiB: 4_096,
      }),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(linked.calls.some((call) => call.args[0] === "create")).toBe(false);

    expect(
      () =>
        new SandboxManager({
          workspaceRoot: linked.workspaceRoot,
          registryPath: join(linked.workspaceRoot, ".scr", "sandboxes.json"),
          executablePath: linked.executablePath,
          expectedExecutableSha256: linked.executableSha256,
          runner: linked.runner,
        }),
    ).toThrow(/registry storage must remain outside/u);

    expect(
      () =>
        new SandboxManager({
          workspaceRoot: linked.workspaceRoot,
          registryPath: join(linked.root, "registry", "sandboxes.json"),
          executablePath: join(linked.workspaceRoot, "tools", "sbx.exe"),
          expectedExecutableSha256: linked.executableSha256,
          runner: linked.runner,
        }),
    ).toThrow(/executable must remain outside/u);

    const changedSchema = await fixture({ listSchema: "invalid" });
    await expect(changedSchema.manager.capabilities()).resolves.toMatchObject({
      trusted: true,
      compatible: false,
      authenticated: false,
      reason: expect.stringMatching(/unsupported list schema/u),
    });
  });
});
