import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertPortableRelativePath,
  parseGitStatus,
  verifyPortablePackage,
  writeJsonAtomic,
} from "../scripts/release-metadata.mjs";

const cleanupPaths: string[] = [];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createValidPortable(): Promise<{
  readonly root: string;
  readonly manifestPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "scr-portable-manifest-"));
  cleanupPaths.push(root);
  await mkdir(join(root, "node"), { recursive: true });
  const shell = "signed-shell-bytes";
  const node = "node-runtime-bytes";
  const rendererTrustedKeys = '{"schemaVersion":"scr.renderer-trusted-keys/v1","keys":[]}\n';
  await writeFile(join(root, "SovereignCodeRuntime.exe"), shell, "utf8");
  await writeFile(join(root, "node", "node.exe"), node, "utf8");
  await writeFile(
    join(root, "renderer-trusted-keys.json"),
    rendererTrustedKeys,
    "utf8",
  );
  const components = [
    {
      path: "SovereignCodeRuntime.exe",
      bytes: Buffer.byteLength(shell),
      sha256: sha256(shell),
    },
    {
      path: "node/node.exe",
      bytes: Buffer.byteLength(node),
      sha256: sha256(node),
    },
    {
      path: "renderer-trusted-keys.json",
      bytes: Buffer.byteLength(rendererTrustedKeys),
      sha256: sha256(rendererTrustedKeys),
    },
  ];
  const manifestPath = join(root, "portable-package.json");
  await writeJsonAtomic(manifestPath, {
    schemaVersion: "scr.portable-package/v2",
    createdAt: "2026-08-20T00:00:00.000Z",
    product: {
      name: "Sovereign Code Runtime",
      version: "0.1.0",
      identifier: "com.sovereign.runtime",
      platform: "win32",
      architecture: "x64",
    },
    source: {
      commit: "a".repeat(40),
      shortCommit: "a".repeat(12),
      branch: "feature/release-provenance",
      committedAt: "2026-08-20T00:00:00.000Z",
      dirty: false,
      changeCount: 0,
    },
    executable: components[0],
    totalBytes: components.reduce((sum, component) => sum + component.bytes, 0),
    components,
    runtime: { schemaVersion: "scr.runtime-resources/v1" },
  });
  return { root, manifestPath };
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("portable release metadata", () => {
  it("verifies every component, executable and total size", async () => {
    const portable = await createValidPortable();

    const result = await verifyPortablePackage(portable.root);

    expect(result).toMatchObject({
      passed: true,
      sourceCommit: "a".repeat(40),
      sourceDirty: false,
      productVersion: "0.1.0",
      problems: [],
    });
    expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.componentChecks).toHaveLength(3);
    expect(result.componentChecks.every((component: { matched: boolean }) => component.matched)).toBe(true);
  });

  it("detects component tampering before launch", async () => {
    const portable = await createValidPortable();
    await writeFile(
      join(portable.root, "SovereignCodeRuntime.exe"),
      "tampered-shell-bytes",
      "utf8",
    );

    const result = await verifyPortablePackage(portable.root);

    expect(result.passed).toBe(false);
    expect(result.problems).toContain(
      "portable component does not match its manifest: SovereignCodeRuntime.exe",
    );
    expect(result.problems).toContain(
      "portable executable metadata does not match its component",
    );
  });

  it("rejects a package that omits the renderer trust registry", async () => {
    const portable = await createValidPortable();
    const manifest = JSON.parse(await readFile(portable.manifestPath, "utf8")) as {
      components: Array<{ path: string; bytes: number }>;
      totalBytes: number;
    };
    const removed = manifest.components.find(
      (component) => component.path === "renderer-trusted-keys.json",
    );
    manifest.components = manifest.components.filter(
      (component) => component.path !== "renderer-trusted-keys.json",
    );
    manifest.totalBytes -= removed?.bytes ?? 0;

    const result = await verifyPortablePackage(portable.root, manifest);

    expect(result.passed).toBe(false);
    expect(result.problems).toContain(
      "required portable component is missing: renderer-trusted-keys.json",
    );
  });

  it("rejects duplicate and escaping component paths", async () => {
    const portable = await createValidPortable();
    const manifest = JSON.parse(await readFile(portable.manifestPath, "utf8")) as {
      components: Array<Record<string, unknown>>;
      totalBytes: number;
    };
    manifest.components.push({ ...manifest.components[0] });
    manifest.components.push({
      path: "../outside.exe",
      bytes: 1,
      sha256: "b".repeat(64),
    });

    const result = await verifyPortablePackage(portable.root, manifest);

    expect(result.passed).toBe(false);
    expect(result.problems).toContain(
      "Duplicate portable component: SovereignCodeRuntime.exe",
    );
    expect(result.problems).toContain(
      "Portable component path escapes the package: ../outside.exe",
    );
  });

  it("parses bounded Git dirty state without retaining paths", () => {
    expect(parseGitStatus("")).toEqual({ dirty: false, changeCount: 0 });
    expect(parseGitStatus(" M src/main.ts\n?? local.txt\n")).toEqual({
      dirty: true,
      changeCount: 2,
    });
  });

  it("accepts contained paths and rejects ambiguous segments", () => {
    expect(assertPortableRelativePath("native/bin/agent.exe")).toBe(
      "native/bin/agent.exe",
    );
    expect(() => assertPortableRelativePath("native//agent.exe")).toThrow(
      /escapes the package/iu,
    );
    expect(() => assertPortableRelativePath("../agent.exe")).toThrow(
      /escapes the package/iu,
    );
  });

  it("rejects a component reached through an escaping junction", async () => {
    const portable = await createValidPortable();
    const outside = await mkdtemp(join(tmpdir(), "scr-portable-outside-"));
    cleanupPaths.push(outside);
    await writeFile(join(outside, "escaped.exe"), "outside", "utf8");
    await symlink(outside, join(portable.root, "linked"), "junction");
    const manifest = JSON.parse(await readFile(portable.manifestPath, "utf8")) as {
      components: Array<Record<string, unknown>>;
    };
    manifest.components.push({
      path: "linked/escaped.exe",
      bytes: Buffer.byteLength("outside"),
      sha256: sha256("outside"),
    });

    const result = await verifyPortablePackage(portable.root, manifest);

    expect(result.passed).toBe(false);
    expect(result.problems).toContain(
      "Portable component resolves outside the package: linked/escaped.exe",
    );
  });

  it("atomically replaces an existing JSON pointer", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-release-pointer-"));
    cleanupPaths.push(root);
    const pointer = join(root, "latest-portable.json");

    await writeJsonAtomic(pointer, { generation: 1 });
    await writeJsonAtomic(pointer, { generation: 2, path: "portable-next" });

    await expect(readFile(pointer, "utf8").then(JSON.parse)).resolves.toEqual({
      generation: 2,
      path: "portable-next",
    });
  });
});
