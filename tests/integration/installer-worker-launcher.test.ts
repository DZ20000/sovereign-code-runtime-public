import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MAX_SCHEDULED_TASK_COMMAND_LENGTH,
  buildScheduledTaskCommand,
  cleanupInstallerWorkerLauncher,
  createInstallerWorkerLauncher,
} from "../../apps/desktop-tauri/scripts/installer-worker-launcher.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("installer scheduled worker launcher", () => {
  it("keeps the scheduled command bounded while moving long arguments into a runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-worker-"));
    cleanup.push(root);
    const localAppData = join(root, "local-app-data");
    const scriptPath = join(root, "very", "long", "source", "path", "worker-fixture.mjs");
    const manifestPath = join(root, "very", "long", "package", "path", "installer-package.json");
    const logPath = join(root, "very", "long", "install", "log", "worker.log");
    const outputPath = join(root, "worker-output.json");
    await mkdir(dirname(scriptPath), { recursive: true });
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      scriptPath,
      `import { writeFile } from "node:fs/promises";\n` +
        `await writeFile(process.env.SCR_INSTALLER_WORKER_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));\n`,
      "utf8",
    );
    await writeFile(manifestPath, "{}\n", "utf8");

    const launcher = await createInstallerWorkerLauncher({
      localAppData,
      nodePath: process.execPath,
      scriptPath,
      manifestPath,
      taskName: "Sovereign-OneShot-Install-Test",
      logPath,
    });
    expect(launcher.command.length).toBeLessThanOrEqual(MAX_SCHEDULED_TASK_COMMAND_LENGTH);
    expect(launcher.command).toBe(buildScheduledTaskCommand(process.execPath, launcher.runnerPath));
    const runner = await readFile(launcher.runnerPath, "utf8");
    expect(runner).toContain(JSON.stringify(scriptPath));
    expect(runner).toContain(JSON.stringify(manifestPath));
    expect(runner).toContain(JSON.stringify(logPath));

    const executed = spawnSync(process.execPath, [launcher.runnerPath], {
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        SCR_INSTALLER_WORKER_TEST_OUTPUT: outputPath,
      },
    });
    expect(executed.error).toBeUndefined();
    expect(executed.status).toBe(0);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual([
      "--worker",
      "--manifest",
      manifestPath,
      "--task-name",
      "Sovereign-OneShot-Install-Test",
      "--log",
      logPath,
    ]);
    await expect(readFile(launcher.runnerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe quoting and overlong scheduled command paths", () => {
    expect(() => buildScheduledTaskCommand('C:/bad"node.exe', "C:/runner.mjs"))
      .toThrow("not safe");
    expect(() => buildScheduledTaskCommand(
      `C:/${"n".repeat(240)}.exe`,
      "C:/runner.mjs",
    )).toThrow("exceeds 261 characters");
  });

  it("cleans a launcher explicitly when task creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-installer-worker-cleanup-"));
    cleanup.push(root);
    const scriptPath = join(root, "worker.mjs");
    const manifestPath = join(root, "installer-package.json");
    const logPath = join(root, "worker.log");
    await writeFile(scriptPath, "export {};\n", "utf8");
    await writeFile(manifestPath, "{}\n", "utf8");
    const launcher = await createInstallerWorkerLauncher({
      localAppData: join(root, "local"),
      nodePath: process.execPath,
      scriptPath,
      manifestPath,
      taskName: "Sovereign-OneShot-Install-Cleanup",
      logPath,
    });
    await cleanupInstallerWorkerLauncher(launcher);
    await expect(readFile(launcher.runnerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
