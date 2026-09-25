import { spawnSync } from "node:child_process";
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectGeneratedArtifacts,
  parseGeneratedArtifactCliArguments,
  runGeneratedArtifactInventoryCli,
} from "../../scripts/generated-artifact-inventory.mjs";

const cleanupPaths: string[] = [];
const tempPrefix = resolve(tmpdir(), "scr-generated-artifacts-");

function runGit(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || "git failed");
  return result.stdout.trim();
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(tempPrefix);
  cleanupPaths.push(root);
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.email", "inventory@example.test"]);
  runGit(root, ["config", "user.name", "Inventory Test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "apps", "service", "dist"), { recursive: true });
  await mkdir(join(root, "apps", "service", "target"), { recursive: true });
  await mkdir(join(root, "apps", "desktop", ".visual-final"), {
    recursive: true,
  });
  await mkdir(join(root, "node_modules", "example"), { recursive: true });
  await mkdir(join(root, ".worktrees", "active"), { recursive: true });
  await writeFile(
    join(root, ".gitignore"),
    [
      "target/",
      ".visual-final/",
      "node_modules/",
      ".worktrees/",
      "*.log",
      ".sovereign/reports/",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    join(root, "src", "index.ts"),
    "export const value = 1;\n",
    "utf8",
  );
  await writeFile(
    join(root, "apps", "service", "dist", "tracked.js"),
    "tracked\n",
    "utf8",
  );
  await writeFile(
    join(root, "apps", "service", "target", "output.bin"),
    Buffer.alloc(64),
  );
  await writeFile(
    join(root, "apps", "desktop", ".visual-final", "screen.png"),
    Buffer.alloc(32),
  );
  await writeFile(
    join(root, "node_modules", "example", "index.js"),
    "module.exports = 1;\n",
    "utf8",
  );
  await writeFile(
    join(root, ".worktrees", "active", "do-not-traverse.bin"),
    Buffer.alloc(128),
  );
  await writeFile(
    join(root, "diagnostic.log"),
    "temporary diagnostic\n",
    "utf8",
  );
  runGit(root, [
    "add",
    "-f",
    ".gitignore",
    "src/index.ts",
    "apps/service/dist/tracked.js",
  ]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  runGit(root, ["branch", "-M", "main"]);
  return root;
}

function entry(
  manifest: Awaited<ReturnType<typeof collectGeneratedArtifacts>>,
  relativePath: string,
) {
  const value = manifest.entries.find(
    (candidate) => candidate.relativePath === relativePath,
  );
  expect(value, `Missing inventory entry ${relativePath}`).toBeDefined();
  return value!;
}

async function safeCleanup(path: string): Promise<void> {
  const normalized = resolve(path);
  if (!normalized.startsWith(tempPrefix)) {
    throw new Error(`Refusing to clean an unexpected test path: ${normalized}`);
  }
  await rm(normalized, { recursive: true, force: true });
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(safeCleanup));
});

describe("generated-artifact inventory", () => {
  it("classifies ignored output while blocking tracked content and worktrees", async () => {
    const root = await fixture();
    const manifest = await collectGeneratedArtifacts({
      root,
      maximumEntries: 10_000,
    });

    expect(manifest).toMatchObject({
      schemaVersion: "scr.generated-artifact-inventory/v1",
      readOnly: true,
      automatedDeletionAllowed: false,
    });
    expect(manifest.entries.map((candidate) => candidate.relativePath)).toEqual(
      [...manifest.entries.map((candidate) => candidate.relativePath)].sort(),
    );
    expect(entry(manifest, "apps/service/target")).toMatchObject({
      category: "build-output",
      gitIgnored: true,
      trackedFileCount: 0,
      disposition: "eligible-after-process-check",
      complete: true,
      byteCount: 64,
      automatedDeletionAllowed: false,
    });
    expect(entry(manifest, "apps/service/dist")).toMatchObject({
      disposition: "blocked",
      risk: "contains-git-tracked-content",
      trackedFileCount: 1,
    });
    expect(entry(manifest, "apps/desktop/.visual-final")).toMatchObject({
      category: "visual-test-output",
      disposition: "eligible-after-process-check",
    });
    expect(entry(manifest, "node_modules")).toMatchObject({
      category: "dependency-cache",
      disposition: "review",
      risk: "reinstallable-review",
    });
    expect(entry(manifest, ".worktrees")).toMatchObject({
      category: "worktree-container",
      disposition: "blocked",
      risk: "active-worktree-container",
      fileCount: 0,
      complete: false,
    });
    expect(entry(manifest, "diagnostic.log")).toMatchObject({
      kind: "file",
      category: "diagnostic-log",
      disposition: "eligible-after-process-check",
    });
  });

  it("does not follow a symbolic-link candidate", async () => {
    const root = await fixture();
    const outside = await mkdtemp(tempPrefix);
    cleanupPaths.push(outside);
    await writeFile(
      join(outside, "outside.txt"),
      "must not be traversed\n",
      "utf8",
    );
    try {
      await symlink(outside, join(root, "artifacts"), "junction");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }
    const manifest = await collectGeneratedArtifacts({
      root,
      maximumEntries: 10_000,
    });
    expect(entry(manifest, "artifacts")).toMatchObject({
      kind: "link",
      disposition: "review",
      risk: "contains-link-or-junction",
      linkCount: 1,
      fileCount: 0,
    });
  });

  it("treats a hard-linked candidate as review-only evidence", async () => {
    const root = await fixture();
    await link(
      join(root, "diagnostic.log"),
      join(root, "diagnostic-hardlink.log"),
    );

    const manifest = await collectGeneratedArtifacts({
      root,
      maximumEntries: 10_000,
    });

    expect(entry(manifest, "diagnostic.log")).toMatchObject({
      disposition: "review",
      risk: "contains-link-or-junction",
      linkCount: 1,
      complete: false,
    });
    expect(entry(manifest, "diagnostic-hardlink.log")).toMatchObject({
      disposition: "review",
      risk: "contains-link-or-junction",
      linkCount: 1,
      complete: false,
    });
  });

  it("marks a bounded partial traversal as review instead of claiming an exact size", async () => {
    const root = await fixture();
    for (let index = 0; index < 150; index += 1) {
      await writeFile(
        join(root, "apps", "service", "target", `file-${index}.bin`),
        Buffer.alloc(1),
      );
    }
    const manifest = await collectGeneratedArtifacts({
      root,
      maximumEntries: 100,
    });
    expect(entry(manifest, "apps/service/target")).toMatchObject({
      complete: false,
      truncated: true,
      disposition: "review",
      risk: "scan-budget-exhausted",
    });
  });

  it("rejects volume roots, deletion flags, and unsafe report paths", async () => {
    const root = await fixture();
    await expect(
      collectGeneratedArtifacts({
        root: parse(root).root,
        maximumEntries: 10_000,
      }),
    ).rejects.toThrow("filesystem or volume root");
    expect(() =>
      parseGeneratedArtifactCliArguments(["--root", root, "--delete", "yes"]),
    ).toThrow("Deletion is intentionally unsupported");
    await expect(
      runGeneratedArtifactInventoryCli([
        "--root",
        root,
        "--output",
        "../outside.json",
      ]),
    ).rejects.toThrow("unsafe path segment");
  });

  it("writes a new ignored report and never overwrites it", async () => {
    const root = await fixture();
    const output = ".sovereign/reports/generated-artifacts.json";
    const manifest = await runGeneratedArtifactInventoryCli([
      "--root",
      root,
      "--output",
      output,
      "--max-entries",
      "10000",
    ]);
    const persisted = JSON.parse(
      await readFile(join(root, ...output.split("/")), "utf8"),
    ) as typeof manifest;
    expect(persisted.entries).toEqual(manifest.entries);
    await expect(
      runGeneratedArtifactInventoryCli(["--root", root, "--output", output]),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("contains no filesystem deletion primitive or deletion mode", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "generated-artifact-inventory.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:rm|rmdir|unlink|rename|copyFile)\s*\(/u);
    expect(source).toContain('"--delete"');
    expect(source).toContain("Deletion is intentionally unsupported");
    expect(source).toContain("automatedDeletionAllowed: false");
    expect(source).toContain('flag: "wx"');
  });
});
