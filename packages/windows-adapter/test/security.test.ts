import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  createPrincipal,
} from "@sovereign/runtime-core";
import { NativeNotificationManager, WindowsAdapter } from "../src/index.js";

const cleanupPaths: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    })),
  );
});

async function createFixture(
  notificationManager?: NativeNotificationManager,
): Promise<{
  root: string;
  audit: MemoryAuditStore;
  adapter: WindowsAdapter;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-workspace-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "safe"), { recursive: true });
  const audit = new MemoryAuditStore();
  const policy = new PolicyEngine();
  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy,
    audit,
    ...(notificationManager === undefined ? {} : { notificationManager }),
  });
  return { root, audit, adapter };
}

const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

describe("Windows path containment and file primitives", () => {
  it("rejects traversal, drive, absolute, UNC, device, and ADS paths", async () => {
    const { adapter } = await createFixture();
    const rejected = [
      "..\\secret.txt",
      "safe\\..\\secret.txt",
      "C:\\Windows\\win.ini",
      "\\\\server\\share\\secret.txt",
      "\\absolute\\secret.txt",
      "\\?\\C:\\Windows\\win.ini",
      "safe\\note.txt:stream",
    ];

    for (const path of rejected) {
      await expect(adapter.readTextFile(owner, "workspace", path)).rejects.toMatchObject({
        code: "PATH_REJECTED",
      });
    }
  });

  it("runs validation in both modes without running a package manager planted in the workspace", async () => {
    const { root, adapter } = await createFixture();
    await writeFile(join(root, "package.json"), JSON.stringify({
      private: true, scripts: { typecheck: "node check.mjs" },
    }));
    await writeFile(join(root, "check.mjs"), "console.log('VALIDATION_OK');\n");
    // cmd.exe resolves a bare command against the working directory first, and
    // the working directory is the workspace the agent can write.
    const marker = join(root, "planted-pnpm-ran.txt");
    await writeFile(
      join(root, "pnpm.cmd"),
      ["@echo off", `> "${marker}" echo owned`, ""].join(String.fromCharCode(13, 10)),
      "utf8",
    );

    // This host already sets the variable, so clear it: the adapter must be
    // the thing that keeps the workspace off the search path.
    const inherited = process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    try {
      const result = await adapter.runValidation(owner, "workspace", "typecheck");
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("VALIDATION_OK");
      const run = await adapter.startValidationRun(owner, "workspace", "typecheck");
      const completed = await adapter.waitRun(owner, "workspace", run.id, 15_000);
      expect(completed.state, completed.stderr).toBe("succeeded");
      expect(completed.stdout).toContain("VALIDATION_OK");
    } finally {
      if (inherited === undefined) {
        delete process.env.NoDefaultCurrentDirectoryInExePath;
      } else {
        process.env.NoDefaultCurrentDirectoryInExePath = inherited;
      }
      await adapter.shutdown();
    }

    expect(existsSync(marker)).toBe(false);
  }, 30_000);
  it("keeps file tools out of Git metadata", async () => {
    const { adapter } = await createFixture();
    // Hooks run on commit and config keys such as core.fsmonitor run a command
    // on ordinary status calls, so writing here would turn workspace write
    // access into arbitrary execution.
    const denied = [
      ".git\\hooks\\post-commit",
      ".git\\config",
      "safe\\.git\\config",
      ".GIT\\hooks\\pre-commit",
    ];

    for (const path of denied) {
      await expect(
        adapter.createTextFile(owner, "workspace", path, "#!/bin/sh\necho owned"),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });
      await expect(
        adapter.readTextFile(owner, "workspace", path),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });
      await expect(
        adapter.deleteFile(owner, "workspace", path, "0".repeat(64)),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });
    }
  });

  it("creates, reads, and SHA-256 guards a replacement", async () => {
    const { adapter, audit } = await createFixture();
    const created = await adapter.createTextFile(
      owner,
      "workspace",
      "safe\\note.txt",
      "first",
    );
    const read = await adapter.readTextFile(owner, "workspace", "safe\\note.txt");
    expect(read.sha256).toBe(created.sha256);

    const replaced = await adapter.replaceTextFile(
      owner,
      "workspace",
      "safe\\note.txt",
      "second",
      read.sha256,
    );
    expect(replaced.sha256).not.toBe(read.sha256);
    expect(audit.list(10).filter((receipt) => receipt.outcome === "succeeded")).toHaveLength(2);
  });

  it("supports the self-hosting tree, metadata, directory, and exact-replace primitives", async () => {
    const { adapter, audit } = await createFixture();
    await adapter.createDirectory(owner, "workspace", "safe\\nested");
    const created = await adapter.createTextFile(
      owner,
      "workspace",
      "safe\\nested\\source.ts",
      "const value = 1;\n",
    );

    await expect(
      adapter.fileMetadata(owner, "workspace", "safe\\nested\\source.ts"),
    ).resolves.toMatchObject({
      type: "file",
      sha256: created.sha256,
    });
    const tree = await adapter.workspaceTree(owner, "workspace", "safe", 3, 20);
    expect(tree.map((entry) => entry.path)).toContain("safe\\nested\\source.ts");

    const replaced = await adapter.replaceTextInFile(
      owner,
      "workspace",
      "safe\\nested\\source.ts",
      "value = 1",
      "value = 2",
      created.sha256,
    );
    expect(replaced.replacements).toBe(1);
    await expect(
      adapter.readTextFile(owner, "workspace", "safe\\nested\\source.ts"),
    ).resolves.toMatchObject({ content: "const value = 2;\n" });
    expect(audit.list(10)[0]).toEqual(
      expect.objectContaining({
        toolName: "files.replace_text",
        outcome: "succeeded",
      }),
    );
  });

  it("moves and deletes regular files with SHA-256 guards", async () => {
    const { adapter, audit } = await createFixture();
    const created = await adapter.createTextFile(
      owner,
      "workspace",
      "safe\\source.txt",
      "guarded",
    );

    const moved = await adapter.moveFile(
      owner,
      "workspace",
      "safe\\source.txt",
      "safe\\moved.txt",
      created.sha256,
    );
    expect(moved).toMatchObject({
      sourcePath: "safe\\source.txt",
      relativePath: "safe\\moved.txt",
      sha256: created.sha256,
    });
    await expect(
      adapter.readTextFile(owner, "workspace", "safe\\source.txt"),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    await expect(
      adapter.readTextFile(owner, "workspace", "safe\\moved.txt"),
    ).resolves.toMatchObject({ content: "guarded" });

    await adapter.deleteFile(
      owner,
      "workspace",
      "safe\\moved.txt",
      moved.sha256,
    );
    await expect(
      adapter.readTextFile(owner, "workspace", "safe\\moved.txt"),
    ).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    expect(audit.list(10).slice(0, 2).map((receipt) => receipt.toolName)).toEqual([
      "files.delete",
      "files.move",
    ]);
  });

  it("rejects a stale hash and records the failed write", async () => {
    const { adapter, audit } = await createFixture();
    await adapter.createTextFile(owner, "workspace", "safe\\note.txt", "current");

    await expect(
      adapter.replaceTextFile(
        owner,
        "workspace",
        "safe\\note.txt",
        "next",
        "0".repeat(64),
      ),
    ).rejects.toMatchObject({ code: "STALE_HASH" });

    expect(audit.list(10)[0]).toEqual(
      expect.objectContaining({
        toolName: "files.replace",
        outcome: "failed",
        errorCode: "STALE_HASH",
      }),
    );
  });

  it("fails closed on a junction escape", async () => {
    const { root, adapter } = await createFixture();
    const outside = await mkdtemp(join(tmpdir(), "scr-outside-"));
    cleanupPaths.push(outside);
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");

    try {
      await symlink(outside, join(root, "escape"), "junction");
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "EPERM" || code === "EACCES") {
        return;
      }
      throw error;
    }

    await expect(
      adapter.readTextFile(owner, "workspace", "escape\\secret.txt"),
    ).rejects.toMatchObject({ code: "PATH_SYMLINK" });
  });

  it("denies missing write capability and emits a denied receipt", async () => {
    const { adapter, audit } = await createFixture();
    const reader = createPrincipal("reader", ["files.read"], ["workspace"]);

    await expect(
      adapter.createTextFile(reader, "workspace", "safe\\blocked.txt", "blocked"),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });

    expect(audit.list(10)[0]).toEqual(
      expect.objectContaining({
        principalId: "reader",
        outcome: "denied",
        errorCode: "POLICY_DENIED",
      }),
    );
  });

  it("supports fixed local Git diff, stage, commit, and log operations", async () => {
    const { root, adapter, audit } = await createFixture();
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Sovereign Test"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@localhost"], { cwd: root });
    await writeFile(join(root, "safe", "tracked.txt"), "first\n", "utf8");

    await adapter.gitStage(owner, "workspace", ["safe\\tracked.txt"]);
    const staged = await adapter.gitDiff(owner, "workspace", "safe\\tracked.txt", true);
    expect(staged.stdout).toContain("+first");
    await adapter.gitCommit(owner, "workspace", "Add tracked fixture");
    const history = await adapter.gitLog(owner, "workspace", 5);
    expect(history.stdout).toContain("Add tracked fixture");
    expect(audit.list(10).slice(0, 2).map((receipt) => receipt.toolName)).toEqual([
      "git.commit",
      "git.stage",
    ]);
  });

  it("probes and runs available Python through the background run model", async () => {
    const { adapter } = await createFixture();
    try {
      const capabilities = await adapter.pythonCapabilities(owner, "workspace");
      expect(capabilities).toMatchObject({ isolatedMode: true, networkIsolation: false });
      if (!capabilities.available) {
        return;
      }

      const run = await adapter.startPythonRun(
        owner,
        "workspace",
        "code",
        "print('python-ready')",
        undefined,
        [],
        "",
        [],
        10_000,
      );
      const completed = await adapter.waitRun(owner, "workspace", run.id, 10_000);
      expect(completed).toMatchObject({ kind: "python", state: "succeeded", exitCode: 0 });
      expect(completed.stdout).toContain("python-ready");
    } finally {
      await adapter.shutdown();
    }
  });

  it("opens a real Windows ConPTY session through the compiled native helper", async () => {
    if (process.platform !== "win32") {
      return;
    }
    const nativeAgentPath = join(
      process.cwd(),
      "apps",
      "desktop",
      "native",
      "bin",
      "SovereignNativeAgent.exe",
    );
    if (!existsSync(nativeAgentPath)) {
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "scr-conpty-workspace-"));
    cleanupPaths.push(root);
    const policy = new PolicyEngine();
    const adapter = new WindowsAdapter({
      workspaces: [{ id: "workspace", root }],
      policy,
      audit: new MemoryAuditStore(),
      nativeAgentPath,
    });
    try {
      const created = await adapter.createTerminalSession(
        owner,
        "workspace",
        "",
        100,
        28,
      );
      let session = adapter.getTerminalSession(owner, "workspace", created.id);
      const readyDeadline = Date.now() + 5_000;
      while (session.state === "starting" && Date.now() < readyDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        session = adapter.getTerminalSession(owner, "workspace", created.id);
      }
      expect(session.state).toBe("running");

      adapter.writeTerminalSession(
        owner,
        "workspace",
        created.id,
        "echo SCR_CONPTY_READY",
        true,
      );
      const outputDeadline = Date.now() + 5_000;
      while (!session.output.includes("SCR_CONPTY_READY") && Date.now() < outputDeadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        session = adapter.getTerminalSession(owner, "workspace", created.id);
      }
      expect(session.output).toContain("SCR_CONPTY_READY");
      expect(adapter.closeTerminalSession(owner, "workspace", created.id).state).toBe("closed");
    } finally {
      await adapter.shutdown();
    }
  }, 15_000);

  it("notifies attention outcomes without notifying routine successful runs", async () => {
    const notificationCalls: Array<{
      readonly executable: string;
      readonly args: readonly string[];
      readonly timeoutMs: number;
    }> = [];
    const notificationManager = new NativeNotificationManager(
      "C:\\fake\\SovereignNativeAgent.exe",
      {
        runner: async (executable, args, timeoutMs) => {
          notificationCalls.push({ executable, args: [...args], timeoutMs });
          return ["NOTIFIED"];
        },
        pathExists: () => true,
        platform: "win32",
      },
    );
    const { root, audit, adapter } = await createFixture(notificationManager);
    await writeFile(
      join(root, "package.json"),
      `${JSON.stringify({ private: true, scripts: { typecheck: "node wait.mjs" } }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(root, "wait.mjs"), "setTimeout(() => undefined, 30_000);\n", "utf8");

    try {
      const validation = await adapter.startValidationRun(
        owner,
        "workspace",
        "typecheck",
        30_000,
      );
      expect(validation.state).toBe("running");
      expect(adapter.listRuns(owner, "workspace", 10)).toEqual([
        expect.objectContaining({ id: validation.id, state: "running" }),
      ]);

      const cancellation = adapter.cancelRun(owner, "workspace", validation.id);
      expect(cancellation.cancelRequested).toBe(true);
      const cancelled = await adapter.waitRun(owner, "workspace", validation.id, 5_000);
      expect(cancelled.state).toBe("cancelled");
      expect(notificationCalls).toHaveLength(1);
      expect(notificationCalls[0]?.args.slice(3)).toEqual(["warning", "3000"]);
      notificationCalls.length = 0;

      const terminal = await adapter.startTerminalRun(
        owner,
        "workspace",
        "Write-Output 'terminal-ready'",
        "",
        10_000,
      );
      const completed = await adapter.waitRun(owner, "workspace", terminal.id, 10_000);
      expect(completed).toMatchObject({ state: "succeeded", exitCode: 0 });
      expect(completed.stdout).toContain("terminal-ready");

      expect(notificationCalls).toHaveLength(0);

      const receipts = audit.list(20);
      expect(receipts[0]).toMatchObject({
        toolName: "runs.complete",
        operation: "complete_managed_run",
        outcome: "succeeded",
        workspaceId: "workspace",
        details: {
          runId: terminal.id,
          runKind: "terminal",
          runState: "succeeded",
          exitCode: 0,
          notificationSource: "automatic",
          notificationStatus: "suppressed",
          notificationReason: "routine-success",
        },
      });
      expect(receipts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          toolName: "terminal.start",
          operation: "start_powershell_run",
          outcome: "succeeded",
          details: expect.objectContaining({ runId: terminal.id }),
        }),
      ]));
    } finally {
      await adapter.shutdown();
    }
  });
});
