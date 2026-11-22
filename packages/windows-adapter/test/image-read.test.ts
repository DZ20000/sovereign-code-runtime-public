import { mkdtemp, rm, writeFile, mkdir, link, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, MemoryAuditStore, PolicyEngine, createPrincipal } from "@sovereign/runtime-core";
import { WindowsAdapter, WindowsPathGuard } from "../src/index.js";

const roots: string[] = [];
const adapters: WindowsAdapter[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(adapters.splice(0).map((adapter) => adapter.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const principal = createPrincipal("image-owner", CAPABILITIES, ["workspace"]);
const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMBAAZqNRAAAAAASUVORK5CYII=",
  "base64",
);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "so-image-test-"));
  roots.push(root);
  await mkdir(join(root, "allowed"));
  const adapter = new WindowsAdapter({
    workspaces: [{ id: "workspace", root }],
    policy: new PolicyEngine(),
    audit: new MemoryAuditStore(),
  });
  adapters.push(adapter);
  return { root, adapter };
}

describe("global workspace image read", () => {
  it("returns actual PNG pixels from a contained workspace, not a text pretend-image", async () => {
    const { root, adapter } = await setup();
    await writeFile(join(root, "allowed", "test.png"), onePixelPng);
    const result = await adapter.readImageFile(principal, "workspace", "allowed/test.png");
    expect(result).toMatchObject({
      mimeType: "image/png",
      bytes: onePixelPng.length,
      workspaceId: "workspace",
    });
    expect(Buffer.from(result.imageBase64, "base64")).toEqual(onePixelPng);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("denies traversal, nonimages, and forged image signatures", async () => {
    const { root, adapter } = await setup();
    await writeFile(join(root, "allowed", "fake.png"), Buffer.from("This is not PNG data"));
    await writeFile(join(root, "allowed", "sneaky.txt"), onePixelPng);
    await expect(adapter.readImageFile(principal, "workspace", "../outside.png")).rejects.toMatchObject({
      code: "PATH_REJECTED",
    });
    await expect(adapter.readImageFile(principal, "workspace", "allowed/sneaky.txt")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(adapter.readImageFile(principal, "workspace", "allowed/fake.png")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
  it("refuses source images over 6 MiB", async () => {
    const { root, adapter } = await setup();
    await writeFile(join(root, "allowed", "huge.png"), Buffer.alloc(6 * 1024 * 1024 + 1));
    await expect(adapter.readImageFile(principal, "workspace", "allowed/huge.png")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
  });
  it("rejects an image with another hard link outside the workspace boundary", async () => {
    const { root, adapter } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "so-image-outside-"));
    roots.push(outside);
    await writeFile(join(outside, "source.png"), onePixelPng);
    await link(join(outside, "source.png"), join(root, "linked.png"));
    await expect(adapter.readImageFile(principal, "workspace", "linked.png"))
      .rejects.toMatchObject({ code: "FILE_LINKED" });
  });
  it("checks workspace authorization before reading pixels", async () => {
    const { root, adapter } = await setup();
    await writeFile(join(root, "sample.png"), onePixelPng);
    const other = createPrincipal("other", CAPABILITIES, ["other-workspace"]);
    await expect(adapter.readImageFile(other, "workspace", "sample.png")).rejects.toThrow();
  });
  it("rejects growth after the size check using a bounded read", async () => {
    const { root, adapter } = await setup();
    await writeFile(join(root, "growing.png"), onePixelPng);
    const verify = WindowsPathGuard.prototype.assertOpenedRegularFile;
    let inspected = false;
    vi.spyOn(WindowsPathGuard.prototype, "assertOpenedRegularFile").mockImplementation(async function (this: WindowsPathGuard, path, handle) {
      await verify.call(this, path, handle);
      if (inspected) return;
      inspected = true;
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementationOnce((async () => {
        const before = await stat();
        await appendFile(path, Buffer.alloc(6 * 1024 * 1024));
        return before;
      }) as typeof handle.stat);
    });
    await expect(adapter.readImageFile(principal, "workspace", "growing.png"))
      .rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});
