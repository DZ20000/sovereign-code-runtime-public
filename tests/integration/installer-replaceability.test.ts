import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertInstalledExecutableReplaceable } from "../../apps/desktop-tauri/scripts/installer-replaceability.mjs";

function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  expected: string,
) {
  return new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${expected}. stdout=${stdout} stderr=${stderr}`,
        ),
      );
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(expected)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      if (!stdout.includes(expected)) {
        clearTimeout(timeout);
        reject(
          new Error(
            `File-lock helper exited early with code ${String(code)}. stderr=${stderr}`,
          ),
        );
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for file-lock helper to exit."));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

describe("installer executable replaceability gate", () => {
  it("requires an exclusive read-write open immediately before NSIS", () => {
    let observedScript = "";
    let observedTimeout = 0;
    const result = assertInstalledExecutableReplaceable(
      "C:\\Program Files\\Sovereign Code Runtime\\sovereign-desktop-tauri.exe",
      (script: string, timeoutMs?: number) => {
        observedScript = script;
        observedTimeout = timeoutMs ?? 0;
        return "replaceable";
      },
    );

    expect(result.replaceable).toBe(true);
    expect(result.existed).toBe(true);
    expect(observedTimeout).toBe(5_000);
    expect(observedScript).toContain("[System.IO.FileAccess]::ReadWrite");
    expect(observedScript).toContain("[System.IO.FileShare]::None");
    expect(observedScript).toContain("$stream.Dispose()");
  });

  it("allows a fresh install when the target executable does not exist", () => {
    const result = assertInstalledExecutableReplaceable(
      "C:\\missing\\sovereign-desktop-tauri.exe",
      () => "absent",
    );
    expect(result).toMatchObject({ existed: false, replaceable: true });
  });

  it("fails closed on a sharing violation or other exclusive-open failure", () => {
    expect(() =>
      assertInstalledExecutableReplaceable(
        "C:\\locked\\sovereign-desktop-tauri.exe",
        () => {
          throw new Error(
            "The process cannot access the file because it is being used by another process.",
          );
        },
      ),
    ).toThrow("Installed executable is not replaceable before NSIS cutover");
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt(
    "detects a real Windows exclusive file lock and succeeds after release",
    async () => {
      const root = await mkdtemp(
        join(tmpdir(), "scr-installer-replaceability-"),
      );
      const executable = join(root, "sovereign-desktop-tauri.exe");
      await writeFile(executable, Buffer.from("fixture-shell"));
      const escaped = executable.replaceAll("'", "''");
      const lockScript = [
        `$stream = [System.IO.File]::Open('${escaped}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
        "Write-Output 'LOCKED'",
        "[Console]::Out.Flush()",
        "[Console]::In.ReadLine() | Out-Null",
        "$stream.Dispose()",
      ].join("; ");
      const child = spawn(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lockScript],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );

      try {
        await waitForOutput(child, "LOCKED");
        expect(() => assertInstalledExecutableReplaceable(executable)).toThrow(
          "Installed executable is not replaceable before NSIS cutover",
        );
        child.stdin.write("release\n");
        child.stdin.end();
        await waitForExit(child);
        expect(assertInstalledExecutableReplaceable(executable)).toMatchObject({
          existed: true,
          replaceable: true,
        });
      } finally {
        if (child.exitCode === null) child.kill();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
