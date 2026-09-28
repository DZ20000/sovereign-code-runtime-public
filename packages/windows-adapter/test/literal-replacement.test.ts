import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CAPABILITIES, MemoryAuditStore, PolicyEngine, createPrincipal, sha256 } from "@sovereign/runtime-core";
import { WindowsAdapter } from "../src/index.js";

const owner = createPrincipal("literal-owner", CAPABILITIES, ["workspace"]);
const reader = createPrincipal("literal-reader", ["files.read"], ["workspace"]);
const fixtures: Array<{ root: string; parent: string; adapter: WindowsAdapter }> = [];

afterEach(async () => {
  for (const { root, parent, adapter } of fixtures.splice(0)) {
    await adapter.shutdown();
    // Delete only fresh cases created by this test, never a checkout or link.
    const info = await lstat(root);
    expect(info.isSymbolicLink()).toBe(false);
    const canonical = await realpath(root);
    expect(dirname(canonical)).toBe(parent);
    await rm(canonical, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function fixture(content = "L TOKEN M TOKEN R\n") {
  const requestedParent = resolve(".sovereign/scratch/literal-replacement-tests");
  await mkdir(requestedParent, { recursive: true });
  const parent = await realpath(requestedParent);
  const root = await mkdtemp(join(parent, "case-"));
  const audit = new MemoryAuditStore();
  const adapter = new WindowsAdapter({ workspaces: [{ id: "workspace", root }], policy: new PolicyEngine(), audit });
  fixtures.push({ root, parent, adapter });
  await writeFile(join(root, "note.txt"), content, { flag: "wx" });
  return { root, adapter, audit, initialHash: sha256(content) };
}

const cases = [
  { label: "matched text", replacement: "$&" },
  { label: "dollar", replacement: "$$" },
  { label: "prefix", replacement: "$`" },
  { label: "suffix", replacement: "$'" },
  { label: "combinations", replacement: "$$|$&|$`|$'" },
  { label: "capture-looking text", replacement: "$1 $01 $99 $<name>" },
  { label: "ordinary text", replacement: "next" },
  { label: "empty text", replacement: "" },
  { label: "multiline", replacement: "first\n$&\nlast" },
  { label: "Unicode", replacement: "\u4e2d\u6587\ud83d\ude80$&" },
  { label: "backslashes", replacement: "C:\\text\\$&" },
  { label: "unchanged token", replacement: "TOKEN" },
];

// These exercise the real adapter, filesystem, path guard, and audit store on Windows.
describe.skipIf(process.platform !== "win32")("literal file replacement", () => {
  for (const mode of ["default", "first", "all"] as const) {
    it.each(cases)(`${mode} inserts $label literally and reports actual bytes`, async ({ replacement }) => {
      const { root, adapter, audit, initialHash } = await fixture();
      const result = mode === "default"
        ? await adapter.replaceTextInFile(owner, "workspace", "note.txt", "TOKEN", replacement, initialHash)
        : await adapter.replaceTextInFile(owner, "workspace", "note.txt", "TOKEN", replacement, initialHash, mode);
      const expected = mode === "all" ? `L ${replacement} M ${replacement} R\n` : `L ${replacement} M TOKEN R\n`;
      const actual = await readFile(join(root, "note.txt"));
      expect(actual.toString("utf8")).toBe(expected);
      expect(result).toMatchObject({ replacements: mode === "all" ? 2 : 1, bytes: actual.byteLength, sha256: sha256(actual) });
      expect(audit.list(10).find((receipt) => receipt.id === result.receiptId)).toMatchObject({
        toolName: "files.replace_text", outcome: "succeeded", beforeSha256: initialHash, afterSha256: sha256(actual),
      });
    });
  }

  it("treats regular-expression punctuation in the search text literally", async () => {
    const { root, adapter, initialHash } = await fixture("[a+b] and [a+b]");
    await adapter.replaceTextInFile(owner, "workspace", "note.txt", "[a+b]", "$&", initialHash);
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("$& and [a+b]");
  });

  it("preserves stale-hash rejection and file contents", async () => {
    const { root, adapter, audit } = await fixture();
    await expect(adapter.replaceTextInFile(owner, "workspace", "note.txt", "TOKEN", "$&", sha256("old"))).rejects.toMatchObject({ code: "STALE_HASH" });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("L TOKEN M TOKEN R\n");
    expect(audit.list(10).filter((receipt) => receipt.outcome === "succeeded")).toHaveLength(0);
  });

  it.each(["", "missing"])("rejects invalid search %j without changing the file", async (findText) => {
    const { root, adapter, initialHash } = await fixture();
    await expect(adapter.replaceTextInFile(owner, "workspace", "note.txt", findText, "$&", initialHash)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("L TOKEN M TOKEN R\n");
  });

  it("does not grant write access to a read-only principal", async () => {
    const { root, adapter, audit, initialHash } = await fixture();
    await expect(adapter.replaceTextInFile(reader, "workspace", "note.txt", "TOKEN", "$&", initialHash)).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(await readFile(join(root, "note.txt"), "utf8")).toBe("L TOKEN M TOKEN R\n");
    expect(audit.list(10).some((receipt) => receipt.toolName === "files.replace_text" && receipt.outcome === "denied")).toBe(true);
  });
});
