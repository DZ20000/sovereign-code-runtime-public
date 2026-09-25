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
  auditSourceStructure,
  parseSourceStructureCliArguments,
  runSourceStructureAuditCli,
} from "../../scripts/source-structure-audit.mjs";

const cleanupPaths: string[] = [];
const tempPrefix = resolve(tmpdir(), "scr-source-structure-");

function sourceLines(count: number): string {
  return `${Array.from({ length: count }, (_value, index) => `export const value${index} = ${index};`).join("\n")}\n`;
}

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
  runGit(root, ["config", "user.email", "structure@example.test"]);
  runGit(root, ["config", "user.name", "Structure Test"]);
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".sovereign/reports/\n", "utf8");
  await writeFile(
    join(root, "config", "source-structure-audit.json"),
    `${JSON.stringify(
      {
        schemaVersion: "scr.source-structure-audit-config/v1",
        recommendedMaxLines: 10,
        hardMaxLines: 20,
        maximumSourceBytes: 1_000_000,
        sourceExtensions: [".ts"],
        excludedDirectoryNames: ["dist"],
        baselinePath: "config/source-structure-baseline.json",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    join(root, "config", "source-structure-baseline.json"),
    `${JSON.stringify(
      {
        schemaVersion: "scr.source-structure-baseline/v1",
        generatedFromHead: "0".repeat(40),
        policy:
          "Existing debt is explicit and may never grow without a reviewed architectural change.",
        entries: [
          {
            path: "src/legacy.ts",
            observedLines: 25,
            maximumLines: 25,
            reason:
              "Legacy fixture remains temporarily oversized while callers are extracted into cohesive modules.",
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(join(root, "src", "small.ts"), sourceLines(5), "utf8");
  await writeFile(join(root, "src", "legacy.ts"), sourceLines(25), "utf8");
  await writeFile(join(root, "dist", "generated.ts"), sourceLines(100), "utf8");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);
  runGit(root, ["branch", "-M", "main"]);
  return root;
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

describe("source-structure audit", () => {
  it("allows capped legacy debt while warning above the recommended limit", async () => {
    const root = await fixture();
    const report = await auditSourceStructure({ root });
    expect(report.summary).toMatchObject({
      errorCount: 0,
      warningCount: 1,
      passed: true,
    });
    expect(report.findings).toContainEqual({
      severity: "warning",
      code: "SOURCE_FILE_RECOMMENDED_LIMIT",
      path: "src/legacy.ts",
      lines: 25,
      limit: 25,
    });
    expect(
      report.largestFiles.some((file) => file.path.startsWith("dist/")),
    ).toBe(false);
  });

  it("rejects a new oversized source file without silently growing the baseline", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "new-large.ts"), sourceLines(21), "utf8");
    runGit(root, ["add", "src/new-large.ts"]);
    const report = await auditSourceStructure({ root });
    expect(report.summary.passed).toBe(false);
    expect(report.findings).toContainEqual({
      severity: "error",
      code: "SOURCE_FILE_HARD_LIMIT",
      path: "src/new-large.ts",
      lines: 21,
      limit: 20,
    });
  });

  it("fails when a baseline file grows beyond its reviewed ceiling", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "legacy.ts"), sourceLines(26), "utf8");
    const report = await auditSourceStructure({ root });
    expect(report.findings).toContainEqual({
      severity: "error",
      code: "SOURCE_FILE_BASELINE_EXCEEDED",
      path: "src/legacy.ts",
      lines: 26,
      limit: 25,
    });
  });

  it("reports when a baseline can be removed after the file is reduced", async () => {
    const root = await fixture();
    await writeFile(join(root, "src", "legacy.ts"), sourceLines(18), "utf8");
    const report = await auditSourceStructure({ root });
    expect(report.summary.passed).toBe(true);
    expect(report.findings).toContainEqual({
      severity: "warning",
      code: "SOURCE_BASELINE_CAN_BE_REMOVED",
      path: "src/legacy.ts",
      lines: 18,
      limit: 20,
    });
  });

  it("does not follow a tracked source link", async () => {
    const root = await fixture();
    const outside = await mkdtemp(tempPrefix);
    cleanupPaths.push(outside);
    await writeFile(join(outside, "outside.ts"), sourceLines(50), "utf8");
    try {
      await symlink(
        join(outside, "outside.ts"),
        join(root, "src", "linked.ts"),
        "file",
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }
    runGit(root, ["add", "src/linked.ts"]);
    const report = await auditSourceStructure({ root });
    expect(report.findings).toContainEqual({
      severity: "error",
      code: "SOURCE_PATH_NOT_DIRECT_FILE",
      path: "src/linked.ts",
      lines: null,
      limit: null,
    });
  });

  it("rejects a hard-linked tracked source without reading through the alias", async () => {
    const root = await fixture();
    const outside = await mkdtemp(tempPrefix);
    cleanupPaths.push(outside);
    const outsidePath = join(outside, "outside.ts");
    await writeFile(outsidePath, sourceLines(12), "utf8");
    await link(outsidePath, join(root, "src", "hard-linked.ts"));
    runGit(root, ["add", "src/hard-linked.ts"]);

    const report = await auditSourceStructure({ root });

    expect(report.findings).toContainEqual({
      severity: "error",
      code: "SOURCE_PATH_NOT_DIRECT_FILE",
      path: "src/hard-linked.ts",
      lines: null,
      limit: null,
    });
  });

  it("rejects unsafe roots, report paths, and baseline mutation flags", async () => {
    const root = await fixture();
    await expect(
      auditSourceStructure({ root: parse(root).root }),
    ).rejects.toThrow("filesystem or volume root");
    await expect(
      auditSourceStructure({ root: join(root, "src") }),
    ).rejects.toThrow("exact Git worktree root");
    expect(() =>
      parseSourceStructureCliArguments(["--root", root, "--update-baseline"]),
    ).toThrow("Baseline mutation is intentionally unsupported");
    await expect(
      runSourceStructureAuditCli([
        "--root",
        root,
        "--output",
        "../outside.json",
      ]),
    ).rejects.toThrow("unsafe path segment");
  });

  it("writes a new ignored report and never overwrites it", async () => {
    const root = await fixture();
    const output = ".sovereign/reports/source-structure.json";
    const report = await runSourceStructureAuditCli([
      "--root",
      root,
      "--output",
      output,
      "--check",
    ]);
    const persisted = JSON.parse(
      await readFile(join(root, ...output.split("/")), "utf8"),
    ) as typeof report;
    expect(persisted.summary).toEqual(report.summary);
    await expect(
      runSourceStructureAuditCli(["--root", root, "--output", output]),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("contains no source rewrite or automatic baseline-update primitive", async () => {
    const source = await readFile(
      join(process.cwd(), "scripts", "source-structure-audit.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(/\b(?:rm|rmdir|unlink|rename|copyFile)\s*\(/u);
    expect(source).toContain('"--write-baseline"');
    expect(source).not.toContain("updateBaseline(");
    expect(source).toContain("Baseline mutation is intentionally unsupported");
    expect(source).toContain('flag: "wx"');
    const skill = await readFile(
      join(process.cwd(), "docs", "source-structure-guard.md"),
      "utf8",
    );
    expect(skill).toContain("pnpm audit:source-structure");
    expect(skill).toContain(
      "Never use the current failing change to raise a baseline",
    );
    expect(skill).toContain("SOURCE_FILE_BASELINE_EXCEEDED");
  });
});
