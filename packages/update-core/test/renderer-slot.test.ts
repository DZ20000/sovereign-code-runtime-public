import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
  RendererSlotStore,
  parseRendererSlotManifest,
  type RendererSlotManifest,
} from "../src/renderer-slot.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createRelease(
  root: string,
  releaseId: string,
  marker: string,
): Promise<{ readonly source: string; readonly manifest: RendererSlotManifest }> {
  const source = join(root, `source-${releaseId}`);
  const index = Buffer.from(`<html><body>${marker}</body></html>`, "utf8");
  const script = Buffer.from(`globalThis.__release = ${JSON.stringify(marker)};`, "utf8");
  await mkdir(join(source, "assets"), { recursive: true });
  await writeFile(join(source, "index.html"), index);
  await writeFile(join(source, "assets", "main.js"), script);
  return {
    source,
    manifest: {
      schemaVersion: RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
      releaseId,
      entrypoint: "index.html",
      files: [
        { path: "index.html", bytes: index.length, sha256: sha256(index) },
        { path: "assets/main.js", bytes: script.length, sha256: sha256(script) },
      ],
    },
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "scr-renderer-slots-"));
  temporaryRoots.push(root);
  return root;
}

describe("RendererSlotStore", () => {
  it("stages immutable renderer assets and atomically switches and rolls back the pointer", async () => {
    const root = await temporaryRoot();
    const first = await createRelease(root, "renderer-1", "one");
    const second = await createRelease(root, "renderer-2", "two");
    let now = 10;
    const store = new RendererSlotStore({
      rootDirectory: join(root, "store"),
      now: () => now++,
    });

    const stagedFirst = await store.stage(first.manifest, first.source);
    expect(stagedFirst.fileCount).toBe(2);
    expect(stagedFirst.entrypoint).toMatch(/index\.html$/u);
    const firstPointer = await store.activate("renderer-1", {
      expectedGeneration: null,
    });
    expect(firstPointer).toMatchObject({
      generation: 1,
      activeReleaseId: "renderer-1",
      previousReleaseId: null,
    });

    await store.stage(second.manifest, second.source);
    const secondPointer = await store.activate("renderer-2", {
      expectedGeneration: 1,
    });
    expect(secondPointer).toMatchObject({
      generation: 2,
      activeReleaseId: "renderer-2",
      previousReleaseId: "renderer-1",
    });
    expect(await store.resolveActiveEntrypoint()).toContain("renderer-2");

    const rolledBack = await store.rollback({ expectedGeneration: 2 });
    expect(rolledBack).toMatchObject({
      generation: 3,
      activeReleaseId: "renderer-1",
      previousReleaseId: "renderer-2",
    });
    expect(await store.resolveActiveEntrypoint()).toContain("renderer-1");
  });

  it("is idempotent for an identical slot and rejects release ID content reuse", async () => {
    const root = await temporaryRoot();
    const release = await createRelease(root, "renderer-idempotent", "same");
    const store = new RendererSlotStore({ rootDirectory: join(root, "store") });

    const first = await store.stage(release.manifest, release.source);
    const second = await store.stage(release.manifest, release.source);
    expect(second.manifestSha256).toBe(first.manifestSha256);

    const conflicting = await createRelease(root, "renderer-idempotent", "different");
    await expect(store.stage(conflicting.manifest, conflicting.source)).rejects.toThrow(
      /different content/u,
    );
  });

  it("rejects extra files, bad digests, and stale pointer generations", async () => {
    const root = await temporaryRoot();
    const release = await createRelease(root, "renderer-safe", "safe");
    const store = new RendererSlotStore({ rootDirectory: join(root, "store") });

    await writeFile(join(release.source, "unexpected.txt"), "extra", "utf8");
    await expect(store.stage(release.manifest, release.source)).rejects.toThrow(
      /inventory count mismatch/u,
    );
    await rm(join(release.source, "unexpected.txt"));

    const badManifest: RendererSlotManifest = {
      ...release.manifest,
      files: release.manifest.files.map((file, index) =>
        index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
      ),
    };
    await expect(store.stage(badManifest, release.source)).rejects.toThrow(/SHA-256/u);

    await store.stage(release.manifest, release.source);
    await store.activate(release.manifest.releaseId, { expectedGeneration: null });
    await expect(
      store.activate(release.manifest.releaseId, { expectedGeneration: 99 }),
    ).rejects.toThrow(/generation changed/u);
  });

  it("detects post-install tampering and refuses to resolve the active entrypoint", async () => {
    const root = await temporaryRoot();
    const release = await createRelease(root, "renderer-tamper", "trusted");
    const store = new RendererSlotStore({ rootDirectory: join(root, "store") });
    const staged = await store.stage(release.manifest, release.source);
    await store.activate(release.manifest.releaseId, { expectedGeneration: null });

    await writeFile(join(staged.directory, "index.html"), "tampered", "utf8");
    await expect(store.verifySlot(release.manifest.releaseId)).rejects.toThrow();
    await expect(store.resolveActiveEntrypoint()).rejects.toThrow();
  });

  it("prunes only slots outside the active, rollback, explicit, and retention sets", async () => {
    const root = await temporaryRoot();
    let now = 100;
    const store = new RendererSlotStore({
      rootDirectory: join(root, "store"),
      now: () => now++,
    });
    for (const id of ["renderer-a", "renderer-b", "renderer-c", "renderer-d"]) {
      const release = await createRelease(root, id, id);
      await store.stage(release.manifest, release.source);
    }
    await store.activate("renderer-a", { expectedGeneration: null });
    await store.activate("renderer-b", { expectedGeneration: 1 });

    const removed = await store.prune({
      keepReleaseIds: ["renderer-c"],
      maxRetained: 0,
    });
    expect(removed).toEqual(["renderer-d"]);
    await expect(store.verifySlot("renderer-a")).resolves.toBeDefined();
    await expect(store.verifySlot("renderer-b")).resolves.toBeDefined();
    await expect(store.verifySlot("renderer-c")).resolves.toBeDefined();
  });


  it("serializes cross-instance pointer mutations and rejects the stale generation", async () => {
    const root = await temporaryRoot();
    const storeRoot = join(root, "store");
    const bootstrap = new RendererSlotStore({ rootDirectory: storeRoot });
    for (const id of ["renderer-lock-a", "renderer-lock-b", "renderer-lock-c"]) {
      const candidate = await createRelease(root, id, id);
      await bootstrap.stage(candidate.manifest, candidate.source);
    }
    await bootstrap.activate("renderer-lock-a", { expectedGeneration: null });

    const left = new RendererSlotStore({ rootDirectory: storeRoot });
    const right = new RendererSlotStore({ rootDirectory: storeRoot });
    const outcomes = await Promise.allSettled([
      left.activate("renderer-lock-b", { expectedGeneration: 1 }),
      right.activate("renderer-lock-c", { expectedGeneration: 1 }),
    ]);

    expect(outcomes.filter((value) => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "rejected")).toHaveLength(1);
    await expect(bootstrap.readPointer()).resolves.toMatchObject({ generation: 2 });
  });

  it("recovers the previous pointer after an interrupted Windows replacement window", async () => {
    const root = await temporaryRoot();
    const storeRoot = join(root, "store");
    const release = await createRelease(root, "renderer-recovery", "recovery");
    const store = new RendererSlotStore({ rootDirectory: storeRoot });
    await store.stage(release.manifest, release.source);
    await store.activate(release.manifest.releaseId, { expectedGeneration: null });

    const pointer = join(storeRoot, "active-renderer.json");
    const backup = join(storeRoot, ".active-renderer.json.interrupted.bak");
    await copyFile(pointer, backup);
    await rm(pointer);

    await expect(store.readPointer()).resolves.toMatchObject({
      activeReleaseId: "renderer-recovery",
      generation: 1,
    });
  });  it("rejects traversal, backslashes, case collisions, and unlisted entrypoints", () => {
    const base = {
      schemaVersion: RENDERER_SLOT_MANIFEST_SCHEMA_VERSION,
      releaseId: "renderer-invalid",
      entrypoint: "index.html",
    };
    for (const path of ["../index.html", "/index.html", "assets\\main.js"]) {
      expect(() =>
        parseRendererSlotManifest({
          ...base,
          entrypoint: path,
          files: [{ path, bytes: 0, sha256: "0".repeat(64) }],
        }),
      ).toThrow();
    }
    expect(() =>
      parseRendererSlotManifest({
        ...base,
        files: [
          { path: "INDEX.html", bytes: 0, sha256: "0".repeat(64) },
          { path: "index.html", bytes: 0, sha256: "0".repeat(64) },
        ],
      }),
    ).toThrow(/duplicate portable path/u);
    expect(() =>
      parseRendererSlotManifest({
        ...base,
        files: [{ path: "main.js", bytes: 0, sha256: "0".repeat(64) }],
      }),
    ).toThrow(/entrypoint/u);
  });
});
