import { readFileSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(import.meta.dirname, "..");
const request = createRequire(join(sourceRoot, "apps/desktop/package.json"));
const packagerEntry = realpathSync(request.resolve("@electron/packager"));
const packagerRequire = createRequire(packagerEntry);
const extractorEntry = realpathSync(packagerRequire.resolve("extract-zip"));
const { extractElectronZip } = packagerRequire(join(dirname(packagerEntry), "unzip.js")) as {
  extractElectronZip(zipPath: string, targetDir: string): Promise<void>;
};

type Entry = { name: string; text: string; mode?: number; deflate?: boolean };
/** Tiny synthetic ZIP writer: no downloaded fixtures and no filesystem outside our test root. */
function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8"), bytes = Buffer.from(entry.text, "utf8");
    const body = entry.deflate ? deflateRawSync(bytes) : bytes;
    const mode = entry.mode ?? 0o100644, local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc32(bytes), 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE((mode * 65536) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); directory.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const index = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, index, end]);
}

async function fixture(run: (root: string, destination: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "scr-electron-extraction-"));
  try {
    const destination = join(root, "output"); await mkdir(destination);
    await writeFile(join(root, "sentinel.txt"), "unchanged synthetic data");
    try { await run(root, destination); }
    finally { expect(await readFile(join(root, "sentinel.txt"), "utf8")).toBe("unchanged synthetic data"); }
  } finally {
    if (!root.startsWith(join(tmpdir(), "scr-electron-extraction-"))) throw new Error("Unexpected test root.");
    await rm(root, { recursive: true, force: true });
  }
}

// These bounded regressions do not expand upstream's trusted-Electron-archive threat model.
describe("Electron Packager scoped extraction replacement", () => {
  it("loads the exact native replacement through Packager's real CommonJS boundary", () => {
    expect(packagerEntry.startsWith(sourceRoot + sep)).toBe(true);
    expect(extractorEntry.startsWith(sourceRoot + sep)).toBe(true);
    expect(JSON.parse(readFileSync(join(dirname(extractorEntry), "package.json"), "utf8")))
      .toMatchObject({ name: "@electron-internal/extract-zip", version: "1.0.5", license: "BSD-2-Clause" });
    expect(typeof extractElectronZip).toBe("function");
    expect(typeof packagerRequire("extract-zip").default).toBe("function");
  });
  it("extracts nested stored and deflated files through the unchanged Packager API", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "valid.zip");
      await writeFile(archive, zip([{ name: "version", text: "synthetic-electron" },
        { name: "resources/app/nested.txt", text: "compressed fixture", deflate: true }]));
      await extractElectronZip(archive, destination);
      expect(await readFile(join(destination, "version"), "utf8")).toBe("synthetic-electron");
      expect(await readFile(join(destination, "resources/app/nested.txt"), "utf8")).toBe("compressed fixture");
    });
  });
  it.each(["../sentinel.txt", "nested/../../sentinel.txt"])("rejects traversal entry %s", async name => {
    await fixture(async (root, destination) => {
      const archive = join(root, "traversal.zip"); await writeFile(archive, zip([{ name, text: "must not escape" }]));
      await expect(extractElectronZip(archive, destination)).rejects.toThrow();
    });
  });
  it("strips an absolute entry prefix and keeps all output inside the destination", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "absolute.zip");
      await writeFile(archive, zip([{ name: join(root, "sentinel.txt").replaceAll("\\", "/"), text: "must not escape" }]));
      // Upstream SECURITY.md explicitly strips absolute prefixes, rather than promising rejection.
      await extractElectronZip(archive, destination);
      const entries = await readdir(destination, { recursive: true, withFileTypes: true });
      expect(entries.every(entry => !entry.isSymbolicLink())).toBe(true);
      const files = entries.filter(entry => entry.isFile()); expect(files).toHaveLength(1);
      const output = realpathSync(join(files[0]!.parentPath, files[0]!.name));
      expect(output.startsWith(realpathSync(destination) + sep)).toBe(true);
      expect(await readFile(output, "utf8")).toBe("must not escape");
    });
  });
  it("rejects an escaping symlink target before any outside write", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "symlink.zip");
      await writeFile(archive, zip([{ name: "link", text: "../sentinel.txt", mode: 0o120777 }]));
      await expect(extractElectronZip(archive, destination)).rejects.toThrow();
      expect(await lstat(join(destination, "link")).catch(() => null)).toBeNull();
    });
  });
  it("resolves a duplicate name to a contained regular file without following the earlier link", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "duplicate.zip");
      await writeFile(archive, zip([{ name: "same", text: "../sentinel.txt", mode: 0o120777 },
        { name: "same", text: "must not escape" }]));
      // The ZIP reader selects the last entry. Assert the filesystem safety invariant,
      // not an unsupported requirement that every duplicate name must be an error.
      await extractElectronZip(archive, destination);
      const output = join(destination, "same");
      expect((await lstat(output)).isFile()).toBe(true);
      expect((await lstat(output)).isSymbolicLink()).toBe(false);
      expect(await readFile(output, "utf8")).toBe("must not escape");
    });
  });
  it("rejects the reverse duplicate order when the selected entry is an escaping link", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "reverse.zip");
      await writeFile(archive, zip([{ name: "same", text: "regular fixture" },
        { name: "same", text: "../sentinel.txt", mode: 0o120777 }]));
      await expect(extractElectronZip(archive, destination)).rejects.toThrow();
    });
  });
  it("does not traverse an archive symlink used as a later file parent", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "parent-link.zip");
      await writeFile(archive, zip([{ name: "folder", text: "..", mode: 0o120777 },
        { name: "folder/sentinel.txt", text: "must not escape" }]));
      await expect(extractElectronZip(archive, destination)).rejects.toThrow();
    });
  });
  it("rejects a malformed ZIP rather than treating arbitrary bytes as a successful extraction", async () => {
    await fixture(async (root, destination) => {
      const archive = join(root, "invalid.zip"); await writeFile(archive, "not an archive");
      await expect(extractElectronZip(archive, destination)).rejects.toThrow();
    });
  });
});
