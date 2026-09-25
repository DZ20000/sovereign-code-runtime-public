import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { requestGracefulRestartExit } from "../../apps/desktop-tauri/scripts/restart-exit-request.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitForFileContent(path: string, expected: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  let latest = "";
  while (Date.now() < deadline) {
    try {
      latest = await readFile(path, "utf8");
      if (latest === expected) return latest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${path} to contain ${expected}; latest=${JSON.stringify(latest)}`);
}

describe("graceful restart-exit request", () => {
  it("returns after spawn instead of waiting for the control process to exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-restart-exit-"));
    cleanup.push(root);
    const script = join(root, "control.mjs");
    const marker = join(root, "marker.txt");
    await writeFile(script,
      `import { writeFile } from "node:fs/promises";\n` +
      `await writeFile(process.env.SCR_RESTART_MARKER, process.argv.at(-1));\n` +
      `await new Promise((resolve) => setTimeout(resolve, 1_500));\n`,
      "utf8",
    );
    const startedAt = Date.now();
    const request = await requestGracefulRestartExit(process.execPath, {
      argumentsPrefix: [script],
      environment: { ...process.env, SCR_RESTART_MARKER: marker },
    });
    expect(request).toMatchObject({ requested: true, error: null });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await expect(waitForFileContent(marker, "--exit-for-restart"))
      .resolves.toBe("--exit-for-restart");
  });

  it("reports a missing executable without throwing or blocking", async () => {
    const request = await requestGracefulRestartExit(
      join(tmpdir(), "definitely-missing-sovereign.exe"),
    );
    expect(request.requested).toBe(false);
    expect(request.processId).toBeNull();
    expect(request.error).toEqual(expect.any(String));
  });

  it("can wait for its own control process to exit before checking for remaining Shells", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-restart-exit-wait-"));
    cleanup.push(root);
    const script = join(root, "control.mjs");
    const marker = join(root, "finished.txt");
    await writeFile(script,
      `import { writeFile } from "node:fs/promises";\n` +
      `await new Promise((resolve) => setTimeout(resolve, 300));\n` +
      `await writeFile(process.env.SCR_RESTART_MARKER, "finished");\n`,
      "utf8",
    );
    const request = await requestGracefulRestartExit(process.execPath, {
      argumentsPrefix: [script],
      environment: { ...process.env, SCR_RESTART_MARKER: marker },
      waitForExitMs: 5_000,
    });
    expect(request).toMatchObject({ requested: true, exited: true, error: null });
    // Read immediately: a spawn-only result can arrive before this marker exists.
    await expect(readFile(marker, "utf8")).resolves.toBe("finished");
    expect(() => process.kill(request.processId!, 0)).toThrow();
  });
});
