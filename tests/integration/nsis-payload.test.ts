import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractNsisPayloadDescriptor } from "../../apps/desktop-tauri/scripts/nsis-payload.mjs";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fakeExtractor(root: string, writesPayload: boolean): Promise<string> {
  const path = join(root, writesPayload ? "fake-extractor.mjs" : "empty-extractor.mjs");
  const body = writesPayload
    ? `import { copyFile, mkdir } from "node:fs/promises";\n` +
      `import { dirname, resolve } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `const output = args.find((value) => value.startsWith("-o"))?.slice(2);\n` +
      `const payload = args.at(-1);\n` +
      `if (!output || !payload) process.exit(2);\n` +
      `const target = resolve(output, ...payload.replaceAll("\\\\", "/").split("/"));\n` +
      `await mkdir(dirname(target), { recursive: true });\n` +
      `await copyFile(process.env.SCR_FAKE_PAYLOAD_SOURCE, target);\n`
    : `process.exit(0);\n`;
  await writeFile(path, body, "utf8");
  return path;
}

describe("NSIS payload descriptor", () => {
  it("hashes the executable extracted from the installer instead of a mutable release output", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-nsis-payload-test-"));
    cleanup.push(root);
    const installer = join(root, "setup.exe");
    const payload = join(root, "payload.exe");
    await writeFile(installer, Buffer.from("fake NSIS archive"));
    await writeFile(payload, Buffer.from("actual immutable NSIS payload"));
    const extractor = await fakeExtractor(root, true);

    const descriptor = await extractNsisPayloadDescriptor({
      installerPath: installer,
      payloadPath: "sovereign-desktop-tauri.exe",
      extractorExecutable: process.execPath,
      extractorArgumentsPrefix: [extractor],
      extractorEnvironment: {
        SCR_FAKE_PAYLOAD_SOURCE: payload,
      },
    });
    expect(descriptor).toEqual({
      path: "sovereign-desktop-tauri.exe",
      bytes: (await readFile(payload)).byteLength,
      sha256: "12b649c9907d7bb9fa749dd23721b4acc375afd6c7870f807bc22184d93b304d",
    });
  });

  it("fails when the extractor does not produce the requested payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-nsis-payload-missing-"));
    cleanup.push(root);
    const installer = join(root, "setup.exe");
    await writeFile(installer, Buffer.from("fake NSIS archive"));
    const extractor = await fakeExtractor(root, false);
    await expect(extractNsisPayloadDescriptor({
      installerPath: installer,
      payloadPath: "sovereign-desktop-tauri.exe",
      extractorExecutable: process.execPath,
      extractorArgumentsPrefix: [extractor],
    })).rejects.toThrow("was not extracted");
  });

  it("rejects absolute and traversal archive paths before invoking an extractor", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-nsis-payload-path-"));
    cleanup.push(root);
    const installer = join(root, "setup.exe");
    await writeFile(installer, Buffer.from("fake NSIS archive"));
    for (const payloadPath of ["../escape.exe", "C:/escape.exe", "folder//payload.exe"]) {
      await expect(extractNsisPayloadDescriptor({
        installerPath: installer,
        payloadPath,
        extractorExecutable: process.execPath,
      })).rejects.toThrow(/relative|inside/u);
    }
  });
});
