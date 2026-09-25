import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { WindowsAdapter } from "../src/index.js";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

const owner = createPrincipal("owner", CAPABILITIES, ["workspace"]);

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

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

async function createRepository(): Promise<{
  root: string;
  adapter: WindowsAdapter;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-repository-inspection-"));
  cleanupPaths.push(root);
  await git(root, ["init"]);
  await git(root, ["config", "user.name", "Sovereign Test"]);
  await git(root, ["config", "user.email", "sovereign@example.invalid"]);
  await writeFile(join(root, "source.ts"), "first\nsecond\nthird\n", "utf8");
  await git(root, ["add", "source.ts"]);
  await git(root, ["commit", "-m", "initial source"]);
  await git(root, ["tag", "v1.0.0"]);
  await git(root, ["branch", "feature/test"]);
  await writeFile(join(root, "untracked.txt"), "pending\n", "utf8");

  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy: new PolicyEngine(),
    audit: new MemoryAuditStore(),
  });
  return { root, adapter };
}

describe("read-only repository inspection", () => {
  it("shows revisions, blame, refs, worktrees, and bounded file lists", async () => {
    const { adapter } = await createRepository();
    try {
      const show = await adapter.gitShow(owner, "workspace", "HEAD", "source.ts");
      expect(show).toMatchObject({ exitCode: 0, outputTruncated: false });
      expect(show.stdout).toContain("initial source");
      expect(show.stdout).toContain("source.ts");

      const blame = await adapter.gitBlame(owner, "workspace", "source.ts", 1, 2);
      expect(blame.exitCode).toBe(0);
      expect(blame.stdout).toContain("author Sovereign Test");
      expect(blame.stdout).toContain("\tfirst");
      expect(blame.stdout).toContain("\tsecond");
      expect(blame.stdout).not.toContain("\tthird");

      const branches = await adapter.gitBranches(owner, "workspace", 20, false);
      expect(branches.exitCode).toBe(0);
      expect(branches.stdout).toContain("feature/test");

      const tags = await adapter.gitTags(owner, "workspace", 20);
      expect(tags.exitCode).toBe(0);
      expect(tags.stdout).toContain("v1.0.0");

      const worktrees = await adapter.gitWorktrees(owner, "workspace");
      expect(worktrees.exitCode).toBe(0);
      expect(worktrees.stdout).toContain("worktree ");
      expect(worktrees.stdout).toContain("HEAD ");

      const tracked = await adapter.gitFiles(owner, "workspace");
      expect(tracked.exitCode).toBe(0);
      expect(tracked.stdout).toContain("source.ts");
      expect(tracked.stdout).not.toContain("untracked.txt");

      const allFiles = await adapter.gitFiles(owner, "workspace", undefined, true);
      expect(allFiles.exitCode).toBe(0);
      expect(allFiles.stdout).toContain("source.ts");
      expect(allFiles.stdout).toContain("untracked.txt");
    } finally {
      await adapter.shutdown();
    }
  });

  it("rejects revision option injection and escaping blame paths", async () => {
    const { adapter } = await createRepository();
    try {
      await expect(
        adapter.gitShow(owner, "workspace", "--help"),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        adapter.gitBlame(owner, "workspace", "..\\outside.ts", 1, 10),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });
    } finally {
      await adapter.shutdown();
    }
  });

  it("returns a Git-root tree without traversing protected metadata", async () => {
    const { adapter } = await createRepository();
    try {
      const tree = await adapter.workspaceTree(owner, "workspace");
      expect(tree.map((entry) => entry.path)).toContain("source.ts");
      expect(tree.map((entry) => entry.path)).not.toContain(".git");
      await expect(adapter.readTextFile(owner, "workspace", ".git/config"))
        .rejects.toMatchObject({ code: "PATH_REJECTED" });
    } finally {
      await adapter.shutdown();
    }
  });

  it("does not execute textconv when showing committed changes", async () => {
    const { root, adapter } = await createRepository();
    try {
      await writeFile(join(root, ".gitattributes"), "*.ts diff=review\n");
      await git(root, ["config", "diff.review.textconv", "echo TEXTCONV_EXECUTED"]);
      const shown = await adapter.gitShow(owner, "workspace", "HEAD", "source.ts");
      expect(shown.exitCode, shown.stderr).toBe(0);
      expect(shown.stdout).toContain("+first");
      expect(shown.stdout).not.toContain("TEXTCONV_EXECUTED");
    } finally {
      await adapter.shutdown();
    }
  });
});
