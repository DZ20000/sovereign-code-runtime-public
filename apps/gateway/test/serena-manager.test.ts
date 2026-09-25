import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  SERENA_READ_ONLY_TOOLS,
  SerenaSemanticManager,
} from "../src/serena-manager.js";

const cleanupPaths: string[] = [];
const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "fake-serena-server.mjs",
);

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `${label}-`));
  cleanupPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

describe("Serena semantic manager", () => {
  it("runs an exact read-only allowlist from an outside-workspace profile", async () => {
    const workspaceRoot = await temporaryDirectory("scr-serena-workspace");
    const profileRoot = await temporaryDirectory("scr-serena-profile");
    await writeFile(
      join(workspaceRoot, "source.ts"),
      "export class Example {}\n",
      "utf8",
    );
    const manager = new SerenaSemanticManager({
      workspaceRoot,
      profileRoot,
      executablePath: process.execPath,
      expectedExecutableVersion: "1.7.0",
      versionProbeArguments: [fixturePath, "--version"],
      serverArguments: [fixturePath],
      toolTimeoutMs: 10_000,
    });

    try {
      await expect(manager.probe()).resolves.toMatchObject({
        state: "ready",
        executableVersion: "1.7.0",
        expectedExecutableVersion: "1.7.0",
        allowedTools: [...SERENA_READ_ONLY_TOOLS],
        lastError: null,
      });
      expect(manager.status().processId).toBeGreaterThan(0);
      await expect(
        manager.call("find_symbol", {
          relative_path: "source.ts",
          name_path_pattern: "Example",
          max_answer_chars: 10_000,
        }),
      ).resolves.toEqual({
        provider: "serena",
        toolName: "find_symbol",
        result: {
          name: "find_symbol",
          input: {
            relative_path: "source.ts",
            name_path_pattern: "Example",
            max_answer_chars: 10_000,
          },
        },
      });

      expect(existsSync(join(workspaceRoot, ".serena"))).toBe(false);
      const config = await readFile(
        join(profileRoot, ".serena", "serena_config.yml"),
        "utf8",
      );
      expect(config).toContain("fixed_tools:");
      for (const toolName of SERENA_READ_ONLY_TOOLS) {
        expect(config).toContain(`  - ${toolName}`);
      }
      expect(config).not.toContain("replace_symbol_body");

      await expect(
        manager.call("find_symbol", {
          relative_path: "../outside.ts",
          name_path_pattern: "Outside",
          max_answer_chars: 10_000,
        }),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });

      await manager.deactivate();
      expect(manager.status()).toMatchObject({
        state: "idle",
        processId: null,
        startedAt: null,
      });
      await expect(manager.probe()).resolves.toMatchObject({
        state: "ready",
        processId: expect.any(Number),
      });
    } finally {
      await manager.stop();
    }
    expect(manager.status().state).toBe("closed");
  });

  it("fails closed when the Serena executable version is not reviewed", async () => {
    const workspaceRoot = await temporaryDirectory("scr-serena-version-workspace");
    const profileRoot = await temporaryDirectory("scr-serena-version-profile");
    const manager = new SerenaSemanticManager({
      workspaceRoot,
      profileRoot,
      executablePath: process.execPath,
      expectedExecutableVersion: "9.9.9",
      versionProbeArguments: [fixturePath, "--version"],
      serverArguments: [fixturePath],
    });

    try {
      await expect(manager.probe()).rejects.toMatchObject({
        code: "PROCESS_FAILED",
      });
      expect(manager.status()).toMatchObject({
        state: "failed",
        executableVersion: "1.7.0",
        expectedExecutableVersion: "9.9.9",
      });
      expect(manager.status().lastError).toMatch(/does not match the reviewed version/u);
    } finally {
      await manager.stop();
    }
  });

  it("rejects semantic profile storage inside the authorized workspace on first use", async () => {
    const workspaceRoot = await temporaryDirectory(
      "scr-serena-profile-boundary",
    );
    const profileRoot = join(workspaceRoot, ".serena-profile");
    const manager = new SerenaSemanticManager({
      workspaceRoot,
      profileRoot,
      executablePath: process.execPath,
      serverArguments: [fixturePath],
    });

    try {
      await expect(manager.probe()).rejects.toMatchObject({
        code: "PROCESS_FAILED",
      });
      expect(manager.status().lastError).toMatch(
        /outside the authorized workspace/u,
      );
      expect(existsSync(profileRoot)).toBe(false);
    } finally {
      await manager.stop();
    }
  });

  it("fails closed when the sidecar exposes an unreviewed write tool", async () => {
    const workspaceRoot = await temporaryDirectory(
      "scr-serena-workspace-extra",
    );
    const profileRoot = await temporaryDirectory("scr-serena-profile-extra");
    await writeFile(
      join(workspaceRoot, "source.ts"),
      "export const value = 1;\n",
      "utf8",
    );
    const manager = new SerenaSemanticManager({
      workspaceRoot,
      profileRoot,
      executablePath: process.execPath,
      serverArguments: [fixturePath, "--extra"],
      toolTimeoutMs: 10_000,
    });

    try {
      await expect(manager.probe()).rejects.toMatchObject({
        code: "PROCESS_FAILED",
      });
      expect(manager.status()).toMatchObject({
        state: "failed",
        processId: null,
      });
      expect(manager.status().lastError).toMatch(
        /outside the reviewed read-only allowlist/u,
      );
    } finally {
      await manager.stop();
    }
  });
});
