import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITIES, MemoryAuditStore, PolicyEngine, createPrincipal, sha256 } from "@sovereign/runtime-core";
import { WindowsAdapter } from "../src/index.js";

const fault = vi.hoisted(() => ({
  target: "", calls: 0, mode: "partial" as "partial" | "zero" | "fail-second",
}));

// All filesystem/path checks remain real. Only writes to this test's exact file
// are shortened or failed to exercise the operating-system API's result contract.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).toLowerCase() === fault.target.toLowerCase() && args[1] === "r+") {
        const originalWrite = handle.write.bind(handle);
        handle.write = (async (buffer: Buffer, offset: number, length: number, position: number) => {
          fault.calls += 1;
          if (fault.mode === "zero") return { bytesWritten: 0, buffer };
          if (fault.mode === "fail-second" && fault.calls > 1) {
            throw Object.assign(new Error("Synthetic write failure"), { code: "ENOSPC" });
          }
          return await originalWrite(buffer, offset, Math.min(3, length), position);
        }) as typeof handle.write;
      }
      return handle;
    },
  };
});

const owner = createPrincipal("partial-write-owner", CAPABILITIES, ["workspace"]);
const fixtures: Array<{ root: string; parent: string; adapter: WindowsAdapter }> = [];

afterEach(async () => {
  fault.target = "";
  for (const { root, parent, adapter } of fixtures.splice(0)) {
    await adapter.shutdown();
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    const canonical = await realpath(root);
    expect(dirname(canonical)).toBe(parent);
    await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function fixture(mode: typeof fault.mode, initial = "old-content-remains-until-replaced") {
  const requestedParent = resolve(".sovereign/scratch/partial-write-tests");
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent);
  const root = await mkdtemp(join(parent, "case-"));
  const audit = new MemoryAuditStore();
  const adapter = new WindowsAdapter({ workspaces: [{ id: "workspace", root }], policy: new PolicyEngine(), audit });
  fixtures.push({ root, parent, adapter });
  const path = join(root, "note.txt");
  await writeFile(path, initial, { flag: "wx" });
  fault.target = path;
  fault.calls = 0;
  fault.mode = mode;
  return { path, adapter, audit, initial, initialHash: sha256(initial) };
}

describe.skipIf(process.platform !== "win32")("replacement short-write handling", () => {
  it.each(["small", "long-content-".repeat(10), "\u4e2d\u6587\ud83d\ude80\nbytes"])("completes partial writes before returning a successful receipt: %j", async (content) => {
    const { path, adapter, audit, initialHash } = await fixture("partial");
    const result = await adapter.replaceTextFile(owner, "workspace", "note.txt", content, initialHash);
    const actual = await readFile(path);
    expect(actual).toEqual(Buffer.from(content));
    expect(fault.calls).toBe(Math.ceil(Buffer.byteLength(content) / 3));
    expect(result).toMatchObject({ bytes: actual.byteLength, sha256: sha256(actual) });
    expect(audit.list(10).find((receipt) => receipt.id === result.receiptId)).toMatchObject({ outcome: "succeeded", afterSha256: sha256(actual) });
  });

  it("rejects a zero-progress write without truncating or reporting success", async () => {
    const { path, adapter, audit, initial, initialHash } = await fixture("zero");
    await expect(adapter.replaceTextFile(owner, "workspace", "note.txt", "next", initialHash)).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(fault.calls).toBe(1);
    expect(await readFile(path, "utf8")).toBe(initial);
    expect(audit.list(10)).toHaveLength(1);
    expect(audit.list(10)[0]).toMatchObject({ toolName: "files.replace", outcome: "failed" });
    expect(audit.list(10)[0]).not.toHaveProperty("afterSha256");
  });

  it("propagates a later write error without a successful receipt; partial data may remain", async () => {
    const { path, adapter, audit, initial, initialHash } = await fixture("fail-second");
    await expect(adapter.replaceTextFile(owner, "workspace", "note.txt", "NEW-content", initialHash)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(fault.calls).toBe(2);
    expect(await readFile(path, "utf8")).toBe(`NEW${initial.slice(3)}`);
    expect(audit.list(10)).toHaveLength(1);
    expect(audit.list(10)[0]).toMatchObject({ outcome: "failed" });
    expect(audit.list(10)[0]).not.toHaveProperty("afterSha256");
  });

  it("supports truncation to empty content without issuing a write", async () => {
    const { path, adapter, initialHash } = await fixture("zero");
    const result = await adapter.replaceTextFile(owner, "workspace", "note.txt", "", initialHash);
    expect(fault.calls).toBe(0);
    expect(await readFile(path, "utf8")).toBe("");
    expect(result).toMatchObject({ bytes: 0, sha256: sha256("") });
  });
});
