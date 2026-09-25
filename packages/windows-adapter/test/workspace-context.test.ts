import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  CAPABILITIES,
  MemoryAuditStore,
  PolicyEngine,
  RuntimeError,
  createPrincipal,
} from "@sovereign/runtime-core";
import { WindowsAdapter } from "../src/index.js";
import {
  buildWorkspaceContext,
  type WorkspaceContextProcessResult,
  type WorkspaceContextReadResult,
} from "../src/workspace-context.js";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

function processResult(
  stdout: string,
  outputTruncated = false,
): WorkspaceContextProcessResult {
  return {
    stdout,
    stderr: "",
    exitCode: 0,
    outputTruncated,
  };
}

function readResult(content: string): WorkspaceContextReadResult {
  return {
    content,
    bytes: Buffer.byteLength(content, "utf8"),
    sha256: "0".repeat(64),
  };
}

async function fixture(): Promise<{ root: string; adapter: WindowsAdapter }> {
  const root = await mkdtemp(join(tmpdir(), "scr-workspace-context-"));
  cleanupPaths.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Sovereign Test"]);
  await git(root, ["config", "user.email", "sovereign@example.invalid"]);
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored.txt\n", "utf8");
  await writeFile(join(root, "README.md"), "workspace context fixture\n", "utf8");
  await writeFile(
    join(root, "src", "alpha.ts"),
    "export const alpha = true;\n// semantic needle alpha\nexport const omega = false;\n",
    "utf8",
  );
  await writeFile(
    join(root, "src", "beta.ts"),
    "export function beta() {\n  return 'semantic needle beta';\n}\n",
    "utf8",
  );
  await writeFile(join(root, "dist", "generated.ts"), "semantic needle generated\n", "utf8");
  await writeFile(join(root, "node_modules", "pkg", "index.ts"), "semantic needle dependency\n", "utf8");
  await writeFile(join(root, "ignored.txt"), "semantic needle ignored\n", "utf8");
  await git(root, ["add", ".gitignore", "README.md", "src"]);
  await git(root, ["add", "-f", "dist/generated.ts", "node_modules/pkg/index.ts"]);
  await git(root, ["commit", "-m", "workspace context fixture"]);
  await writeFile(join(root, "src", "untracked.ts"), "semantic needle untracked\n", "utf8");
  await writeFile(join(root, "README.md"), "workspace context fixture\ndirty\n", "utf8");

  return {
    root,
    adapter: new WindowsAdapter({
      workspaces: [{ id: "workspace", root }],
      policy: new PolicyEngine(),
      audit: new MemoryAuditStore(),
    }),
  };
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  })));
});

describe("workspace context", () => {
  it("honors Git ignore and built-in generated-directory exclusions", async () => {
    const { adapter } = await fixture();
    try {
      const context = await adapter.workspaceContext(
        owner,
        "workspace",
        "",
        undefined,
        undefined,
        100,
        20,
        1,
        65_536,
        true,
      );

      expect(context.branch).toMatch(/master|main/u);
      expect(context.dirtyFiles).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "README.md" }),
        expect.objectContaining({ path: "src/untracked.ts" }),
      ]));
      expect(context.matchingPaths).toEqual(expect.arrayContaining([
        ".gitignore",
        "README.md",
        "src/alpha.ts",
        "src/beta.ts",
        "src/untracked.ts",
      ]));
      expect(context.matchingPaths).not.toEqual(expect.arrayContaining([
        "dist/generated.ts",
        "node_modules/pkg/index.ts",
        "ignored.txt",
      ]));
      expect(context.exclusions).toEqual(expect.arrayContaining([
        "dist",
        "node_modules",
        ".worktrees",
      ]));
      expect(context.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(context), "utf8"));
      expect(context.returnedBytes).toBeLessThanOrEqual(65_536);
    } finally {
      await adapter.shutdown();
    }
  });

  it("paginates matching snippets with a request-bound cursor", async () => {
    const { root, adapter } = await fixture();
    try {
      const collected = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const context = await adapter.workspaceContext(
          owner,
          "workspace",
          "src",
          "semantic needle",
          cursor,
          1,
          1,
          1,
          8_192,
          true,
        );
        collected.push(...context.matches);
        cursor = context.nextCursor ?? undefined;
        if (cursor === undefined) {
          break;
        }
      }

      expect(collected.map((match) => match.path)).toEqual([
        "src/alpha.ts",
        "src/beta.ts",
        "src/untracked.ts",
      ]);
      expect(collected[0]).toMatchObject({
        line: 2,
        column: 4,
        snippet: {
          startLine: 1,
          endLine: 3,
        },
      });

      const first = await adapter.workspaceContext(
        owner,
        "workspace",
        "src",
        "semantic needle",
        undefined,
        1,
        1,
        1,
        8_192,
        true,
      );
      expect(first.nextCursor).not.toBeNull();
      await writeFile(join(root, "src", "new-file.ts"), "semantic needle new\n", "utf8");
      await expect(adapter.workspaceContext(
        owner,
        "workspace",
        "src",
        "semantic needle",
        first.nextCursor ?? undefined,
        1,
        1,
        1,
        8_192,
        true,
      )).rejects.toMatchObject({ code: "INVALID_INPUT" });
    } finally {
      await adapter.shutdown();
    }
  });

  it("drops incomplete Git records when bounded process output is truncated", async () => {
    const context = await buildWorkspaceContext({
      workspaceId: "workspace",
      scopePath: "",
      maxFiles: 10,
      maxMatches: 10,
      snippetLines: 0,
      maxBytes: 8_192,
      includeUntracked: true,
      gitStatus: async () => processResult(
        "## main\n M src/complete.ts\n?? src/incomplete",
        true,
      ),
      gitFiles: async () => processResult("src/complete.ts\nsrc/incomplete", true),
      readText: async () => readResult(""),
    });

    expect(context.branch).toBe("main");
    expect(context.dirtyFiles).toEqual([{ status: " M", path: "src/complete.ts" }]);
    expect(context.matchingPaths).toEqual(["src/complete.ts"]);
    expect(context.sourceTruncated).toMatchObject({
      gitStatus: true,
      gitFiles: true,
    });
    expect(context.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(context), "utf8"));
    expect(context.returnedBytes).toBeLessThanOrEqual(8_192);
  });

  it("advances from a filename-only page before returning its companion match", async () => {
    const path = `src/${"p".repeat(2_800)}-needle.ts`;
    const content = `needle ${"x".repeat(2_800)}`;
    const request = {
      workspaceId: "workspace",
      scopePath: "",
      query: "needle",
      maxFiles: 1,
      maxMatches: 1,
      snippetLines: 0,
      maxBytes: 8_192,
      includeUntracked: true,
      gitStatus: async () => processResult("## main\n"),
      gitFiles: async () => processResult(`${path}\n`),
      readText: async () => readResult(content),
    };

    const first = await buildWorkspaceContext(request);
    expect(first.matchingPaths).toEqual([path]);
    expect(first.matches).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(first.returnedBytes).toBeLessThanOrEqual(8_192);

    const second = await buildWorkspaceContext({
      ...request,
      cursor: first.nextCursor!,
    });
    expect(second.matchingPaths).toEqual([]);
    expect(second.matches).toHaveLength(1);
    expect(second.matches[0]?.path).toBe(path);
    expect(second.nextCursor).toBeNull();
    expect(second.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(second), "utf8"));
    expect(second.returnedBytes).toBeLessThanOrEqual(8_192);
  });

  it("rejects a single match that cannot fit instead of returning a live-lock cursor", async () => {
    await expect(buildWorkspaceContext({
      workspaceId: "workspace",
      scopePath: "",
      query: "needle",
      maxFiles: 1,
      maxMatches: 1,
      snippetLines: 0,
      maxBytes: 8_192,
      includeUntracked: true,
      gitStatus: async () => processResult("## main\n"),
      gitFiles: async () => processResult("src/large.ts\n"),
      readText: async () => readResult(`needle ${"x".repeat(12_000)}`),
    })).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: {
        itemType: "match",
        maxBytes: 8_192,
      },
    });
  });

  it("keeps dirty-file metadata inside the total response byte budget", async () => {
    const dirtyLines = Array.from(
      { length: 100 },
      (_, index) => ` M src/${String(index).padStart(3, "0")}-${"d".repeat(400)}.ts`,
    );
    const context = await buildWorkspaceContext({
      workspaceId: "workspace",
      scopePath: "",
      query: "needle",
      maxFiles: 1,
      maxMatches: 1,
      snippetLines: 0,
      maxBytes: 8_192,
      includeUntracked: true,
      gitStatus: async () => processResult(["## main", ...dirtyLines, ""].join("\n")),
      gitFiles: async () => processResult("src/file.ts\n"),
      readText: async () => readResult(`needle ${"x".repeat(2_800)}`),
    });

    expect(context.dirtyFiles.length).toBeGreaterThan(0);
    expect(context.dirtyFiles.length).toBeLessThan(100);
    expect(context.sourceTruncated.dirtyFiles).toBe(true);
    expect(context.matchingPaths).toEqual([]);
    expect(context.matches).toHaveLength(1);
    expect(context.returnedBytes).toBe(Buffer.byteLength(JSON.stringify(context), "utf8"));
    expect(context.returnedBytes).toBeLessThanOrEqual(8_192);
  });

  it("skips guarded links without following them or aborting the remaining page", async () => {
    const reads: string[] = [];
    const context = await buildWorkspaceContext({
      workspaceId: "workspace",
      scopePath: "",
      query: "needle",
      maxFiles: 10,
      maxMatches: 10,
      snippetLines: 0,
      maxBytes: 8_192,
      includeUntracked: true,
      gitStatus: async () => processResult("## main\n"),
      gitFiles: async () => processResult("src/link.ts\nsrc/safe.ts\n"),
      readText: async (path) => {
        reads.push(path);
        if (path === "src/link.ts") {
          throw new RuntimeError("PATH_SYMLINK", "Link reads are rejected.", 400);
        }
        return readResult("const value = 'needle';");
      },
    });

    expect(reads).toEqual(["src/link.ts", "src/safe.ts"]);
    expect(context.matches.map((match) => match.path)).toEqual(["src/safe.ts"]);
    expect(context.nextCursor).toBeNull();
    expect(context.returnedBytes).toBeLessThanOrEqual(8_192);
  });
});
