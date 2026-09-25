import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ConPtySessionManager } from "../src/conpty-manager.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

describe.skipIf(process.platform !== "win32")("ConPTY retained output", () => {
  it("keeps a valid UTF-8 tail and reports its absolute range through the native protocol", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      pid: 12345, exitCode: null as number | null, signalCode: null, kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const manager = new ConPtySessionManager(process.execPath, 16_384);
    const session = manager.start({ workspaceId: "workspace", relativeCwd: "", absoluteCwd: process.cwd(), shellPath: process.execPath, columns: 100, rows: 30 });
    const send = (data: Buffer): void => { child.stdout.write(`DATA\t${data.toString("base64")}\n`); };
    try {
      child.stdout.write("READY\t12345\n");
      const emoji = Buffer.from("😀");
      send(emoji.subarray(0, 2));
      expect(manager.get(session.id)!.output).toBe("");
      send(emoji.subarray(2));
      expect(manager.get(session.id)!.output).toBe("😀");
      send(Buffer.from("中".repeat(20000)));
      send(Buffer.from("\n最终诊断_END"));
      child.stdout.write("EXIT\t0\n");
      child.exitCode = 0;
      child.emit("close", 0, null);
      const final = manager.get(session.id)!;
      expect(final).toMatchObject({ state: "exited", outputTruncated: true });
      expect(final.output).toContain("最终诊断_END");
      expect(final.output).not.toContain("\ufffd");
      expect(Buffer.byteLength(final.output)).toBeLessThanOrEqual(16_384);
      expect(final.outputEndOffset! - final.outputStartOffset!).toBe(Buffer.byteLength(final.output));
      expect(final.outputStartOffset).toBeGreaterThan(0);
    } finally {
      if (child.exitCode === null) { child.exitCode = 0; child.emit("close", 0, null); }
      await manager.shutdown();
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
    }
  });
});
