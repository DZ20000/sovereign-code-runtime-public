import { existsSync } from "node:fs";
import {
  link,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "@sovereign/runtime-core";
import {
  NativeFileOperations,
  runNativeFileOperation,
  type NativeFileOperationRunner,
} from "../src/native-file-operations.js";

const nativeAgentPath = resolve(
  process.cwd(),
  "apps",
  "desktop",
  "native",
  "bin",
  "SovereignNativeAgent.exe",
);
const cleanupRoots: string[] = [];

async function fixture() {
  const requested = await mkdtemp(join(tmpdir(), "scr-native-file-operations-"));
  const root = await realpath(requested);
  cleanupRoots.push(root);
  return { root, operations: new NativeFileOperations(nativeAgentPath) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("native file-operation protocol", () => {
  it("encodes create input and validates the native result", async () => {
    const calls: Array<{ args: readonly string[]; input: Buffer | null; timeoutMs: number }> = [];
    const runner: NativeFileOperationRunner = async (_executable, args, input, timeoutMs) => {
      calls.push({ args, input, timeoutMs });
      return [`FILE_OK\t5\t${sha256("alpha")}`];
    };
    const operations = new NativeFileOperations("C:\\native-agent.exe", {
      runner,
      pathExists: () => true,
      platform: "win32",
      timeoutMs: 1234,
    });

    await expect(
      operations.create("C:\\workspace", "C:\\workspace\\safe\\alpha.txt", Buffer.from("alpha")),
    ).resolves.toEqual({ bytes: 5, sha256: sha256("alpha") });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0]).toBe("file-create");
    expect(calls[0]?.args.slice(1, 4).map((value) => Buffer.from(value, "base64").toString("utf8"))).toEqual([
      "C:\\workspace",
      "C:\\workspace\\safe",
      "alpha.txt",
    ]);
    expect(calls[0]?.args[4]).toBe("5");
    expect(calls[0]?.args[5]).toBe("1048576");
    expect(calls[0]?.input?.toString("utf8")).toBe("alpha");
    expect(calls[0]?.timeoutMs).toBe(1234);
  });

  it("propagates guarded-read limits to native move and delete", async () => {
    const recorded: string[][] = [];
    const operations = new NativeFileOperations("C:\native-agent.exe", {
      runner: async (_executable, args) => {
        recorded.push([...args]);
        return [`FILE_OK\t5\t${sha256("alpha")}`];
      },
      pathExists: () => true,
      platform: "win32",
    });

    await operations.move(
      "C:\workspace",
      "C:\workspace\source.txt",
      "C:\workspace\destination.txt",
      sha256("alpha"),
      123,
    );
    await operations.delete("C:\workspace", "C:\workspace\destination.txt", sha256("alpha"), 456);

    expect(recorded[0]?.at(-1)).toBe("123");
    expect(recorded[1]?.at(-1)).toBe("456");
    await expect(
      operations.delete("C:\workspace", "C:\workspace\destination.txt", sha256("alpha"), -1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      operations.move(
        "C:\workspace",
        "C:\workspace\source.txt",
        "C:\workspace\destination.txt",
        sha256("alpha"),
        2_147_483_648,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("fails closed without the packaged Windows native agent", async () => {
    const operations = new NativeFileOperations("C:\\missing.exe", {
      runner: vi.fn(),
      pathExists: () => false,
      platform: "win32",
    });
    await expect(
      operations.delete("C:\\workspace", "C:\\workspace\\note.txt", sha256("note")),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED", status: 503 });
  });

  const malformedOutputCases: ReadonlyArray<readonly [readonly string[]]> = [
    [[]],
    [["FILE_OK\t-1\t" + sha256("x")]],
    [["FILE_OK\t1\tnot-a-digest"]],
  ];

  it.each(malformedOutputCases)("rejects malformed native success output %#", async (lines) => {
    const operations = new NativeFileOperations("C:\\native-agent.exe", {
      runner: async () => lines,
      pathExists: () => true,
      platform: "win32",
    });
    await expect(
      operations.delete("C:\\workspace", "C:\\workspace\\note.txt", sha256("note")),
    ).rejects.toMatchObject({ code: "PROCESS_FAILED" });
  });
});

const nativeIt = process.platform === "win32" && existsSync(nativeAgentPath) ? it : it.skip;

describe("handle-bound native file operations", () => {
  nativeIt("creates, moves, and deletes Unicode content across a canonical temp workspace", async () => {
    const { root, operations } = await fixture();
    const source = join(root, "source-中文.txt");
    const destination = join(root, "destination-🚀.txt");
    const content = "alpha\n中文🚀\n";

    await expect(operations.create(root, source, Buffer.from(content))).resolves.toEqual({
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
    await expect(operations.move(root, source, destination, sha256(content))).resolves.toEqual({
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
    expect(await readFile(destination, "utf8")).toBe(content);
    await expect(operations.delete(root, destination, sha256(content))).resolves.toEqual({
      bytes: Buffer.byteLength(content),
      sha256: sha256(content),
    });
    expect(await readdir(root)).toEqual([]);
  });

  nativeIt("does not overwrite an existing destination or leave a create temporary file", async () => {
    const { root, operations } = await fixture();
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "source", { flag: "wx" });
    await writeFile(destination, "destination", { flag: "wx" });

    await expect(
      operations.create(root, destination, Buffer.from("replacement")),
    ).rejects.toMatchObject({ code: "FILE_EXISTS" });
    await expect(
      operations.move(root, source, destination, sha256("source")),
    ).rejects.toMatchObject({ code: "FILE_EXISTS" });

    expect(await readFile(source, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("destination");
    expect((await readdir(root)).sort()).toEqual(["destination.txt", "source.txt"]);
  });

  nativeIt("preserves files when a move or delete hash is stale", async () => {
    const { root, operations } = await fixture();
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "current", { flag: "wx" });

    await expect(
      operations.move(root, source, destination, sha256("old")),
    ).rejects.toMatchObject({ code: "STALE_HASH" });
    await expect(
      operations.delete(root, source, sha256("old")),
    ).rejects.toMatchObject({ code: "STALE_HASH" });

    expect(await readFile(source, "utf8")).toBe("current");
    expect(await readdir(root)).toEqual(["source.txt"]);
  });

  nativeIt("rejects multiply linked source files", async () => {
    const { root, operations } = await fixture();
    const source = join(root, "source.txt");
    const alias = join(root, "alias.txt");
    await writeFile(source, "linked", { flag: "wx" });
    await link(source, alias);

    await expect(
      operations.delete(root, source, sha256("linked")),
    ).rejects.toMatchObject({ code: "FILE_LINKED" });
    await expect(
      operations.move(root, source, join(root, "moved.txt"), sha256("linked")),
    ).rejects.toMatchObject({ code: "FILE_LINKED" });

    expect(await readFile(source, "utf8")).toBe("linked");
    expect(await readFile(alias, "utf8")).toBe("linked");
  });

  nativeIt("honors a configured create limit without a hidden one-megabyte ceiling", async () => {
    const { root, operations } = await fixture();
    const rejected = join(root, "rejected.txt");
    await expect(
      operations.create(root, rejected, Buffer.from("12345"), 4),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(existsSync(rejected)).toBe(false);

    const accepted = join(root, "accepted.bin");
    const data = Buffer.alloc(1_048_577, 0x61);
    await expect(operations.create(root, accepted, data, data.byteLength)).resolves.toMatchObject({
      bytes: data.byteLength,
      sha256: sha256(data),
    });
  });
  nativeIt("preserves oversized files when move or delete exceeds the guarded-read limit", async () => {
    const { root, operations } = await fixture();
    const source = join(root, "source.txt");
    const destination = join(root, "destination.txt");
    await writeFile(source, "12345", { flag: "wx" });

    await expect(
      operations.move(root, source, destination, sha256("12345"), 4),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    await expect(
      operations.delete(root, source, sha256("12345"), 4),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    expect(await readFile(source, "utf8")).toBe("12345");
    expect(existsSync(destination)).toBe(false);
  });

  nativeIt.each(["..\\escape.txt", "C:\\escape.txt", "note.txt:stream", "CON", "trailing."])(
    "rejects an invalid native leaf %j without leaving a temporary file",
    async (leaf) => {
      const { root } = await fixture();
      const encode = (value: string): string => Buffer.from(value, "utf8").toString("base64");
      await expect(
        runNativeFileOperation(
          nativeAgentPath,
          ["file-create", encode(root), encode(root), encode(leaf), "7", "7"],
          Buffer.from("blocked"),
          30_000,
        ),
      ).rejects.toMatchObject({ code: "PATH_REJECTED" });
      expect(await readdir(root)).toEqual([]);
    },
  );

  nativeIt("rejects a junction parent without writing outside the workspace", async () => {
    const { root, operations } = await fixture();
    const outsideRequested = await mkdtemp(join(tmpdir(), "scr-native-file-outside-"));
    const outside = await realpath(outsideRequested);
    cleanupRoots.push(outside);
    await symlink(outside, join(root, "escape"), "junction");

    await expect(
      operations.create(root, join(root, "escape", "outside.txt"), Buffer.from("blocked")),
    ).rejects.toMatchObject({ code: "PATH_SYMLINK" });

    expect(await readdir(outside)).toEqual([]);
  });
});
