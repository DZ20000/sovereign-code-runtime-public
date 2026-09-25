import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, createPrincipal, MemoryAuditStore, MemoryRunStore, PolicyEngine } from "@sovereign/runtime-core";
import { WindowsAdapter } from "../src/index.js";
import { ManagedRunManager } from "../src/run-manager.js";

describe("output configuration", () => {
  it("rejects invalid capacity before changing the ledger or starting processes", () => {
    const store = new MemoryRunStore();
    const interrupt = vi.spyOn(store, "interruptActive");
    expect(() => new ManagedRunManager(store, NaN)).toThrow(RangeError);
    expect(interrupt).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform !== "win32")("synchronous terminal output", () => {
  it("keeps final diagnostics and the nonzero exit code through the real PowerShell adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-terminal-output-"));
    const policy = new PolicyEngine();
    const audit = new MemoryAuditStore();
    const adapter = new WindowsAdapter({ workspaces: [{ id: "workspace", root }], policy, audit, maxProcessOutputBytes: 256 });
    try {
      const principal = createPrincipal("owner", CAPABILITIES, ["workspace"]);
      const result = await adapter.runTerminalCommand(principal, "workspace",
        "[Console]::Write(('x' * 100000)); [Console]::Write('最终输出_END'); [Console]::Error.Write(('y' * 100000)); [Console]::Error.Write('最终错误_END'); exit 7", "", 15000);
      expect(result).toMatchObject({ exitCode: 7, outputTruncated: true });
      expect(result.stdout).toContain("最终输出_END");
      expect(result.stderr).toContain("最终错误_END");
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(256);
      expect(result.outputRetention!.stdout.startOffset).toBeGreaterThan(0);
      expect(result.outputRetention!.stdout.endOffset - result.outputRetention!.stdout.startOffset).toBe(Buffer.byteLength(result.stdout));
    } finally { await adapter.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
});
