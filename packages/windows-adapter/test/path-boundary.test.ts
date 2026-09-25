import { existsSync } from "node:fs";
import { link, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WindowsPathGuard } from "../src/path-guard.js";

describe.skipIf(process.platform !== "win32")("Windows opened-file boundary", () => {
  it("rejects a hard-linked file handle", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-hardlink-boundary-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    await mkdir(workspace);
    await writeFile(outside, "outside");
    await link(outside, join(workspace, "linked.txt"));
    const guard = new WindowsPathGuard({ id: "fixture", root: workspace });
    const resolved = await guard.resolve("linked.txt", "read");
    const handle = await open(resolved.absolutePath, "r+");
    try {
      await expect(
        guard.assertOpenedRegularFile(resolved.absolutePath, handle),
      ).rejects.toMatchObject({ code: "FILE_LINKED" });
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a file opened after its checked parent becomes a junction", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-junction-race-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const checked = join(workspace, "checked");
    await mkdir(checked, { recursive: true });
    await mkdir(outside);
    const guard = new WindowsPathGuard({ id: "fixture", root: workspace });
    const resolved = await guard.resolve("checked\\escaped.txt", "create");
    await rename(checked, join(workspace, "checked-original"));
    await symlink(outside, checked, "junction");
    const handle = await open(resolved.absolutePath, "wx");
    try {
      await expect(
        guard.assertOpenedRegularFile(resolved.absolutePath, handle),
      ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
      expect((await handle.stat()).size).toBe(0);
    } finally {
      await handle.close();
      await rm(root, { recursive: true, force: true });
    }
    expect(existsSync(join(outside, "escaped.txt"))).toBe(false);
  });
});
