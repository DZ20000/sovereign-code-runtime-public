import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryRunStore, SqliteRunStore, RUN_SCHEMA_VERSION, type RunRecord } from "@sovereign/runtime-core";
import { BoundedOutputBuffer, outputRetention, runOutputRange } from "../src/output-buffer.js";
import { followRunSnapshot } from "../src/run-follow.js";
import { ManagedRunManager } from "../src/run-manager.js";

function record(stdout: BoundedOutputBuffer, stderr = new BoundedOutputBuffer(64)): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION, id: "retained-run", kind: "terminal", label: "retention",
    workspaceId: "workspace", state: "running", createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(), completedAt: null, exitCode: null, signal: null,
    durationMs: null, stdout: stdout.text(), stderr: stderr.text(),
    outputTruncated: stdout.truncated() || stderr.truncated(), cancelRequested: false,
    metadata: { outputRetention: outputRetention(stdout, stderr) },
  };
}

function cursor(stdoutOffset: number, stderrOffset = 0): string {
  return Buffer.from(JSON.stringify({ schemaVersion: "scr.run-cursor/v1", runId: "retained-run", stdoutOffset, stderrOffset })).toString("base64url");
}

describe("retained-output cursors", () => {
  it("resumes after eviction with absolute offsets and an explicit gap", () => {
    const output = new BoundedOutputBuffer(16);
    output.append(Buffer.from("abcdefgh"));
    const first = followRunSnapshot(record(output), undefined, 4);
    expect(first.stdout.text).toBe("abcd");
    output.append(Buffer.from("ijklmnopqrstuvwxyz"));
    const second = followRunSnapshot(record(output), first.cursor, 5);
    expect(second.stdout).toMatchObject({ text: "klmno", startOffset: 10, endOffset: 15, retainedStartOffset: 10, skippedBytes: 6, hasMore: true });
    const third = followRunSnapshot(record(output), second.cursor, 64);
    expect(third.stdout).toMatchObject({ text: "pqrstuvwxyz", skippedBytes: 0, hasMore: false, endOffset: 26 });
    expect(followRunSnapshot(record(output), third.cursor, 64).stdout.text).toBe("");
  });

  it("reports a gap for the first reader of already-evicted output", () => {
    const output = new BoundedOutputBuffer(8);
    output.append(Buffer.from("0123456789abcdef"));
    expect(followRunSnapshot(record(output), undefined, 32).stdout).toMatchObject({ text: "89abcdef", startOffset: 8, endOffset: 16, skippedBytes: 8 });
  });

  it("moves forward on Chinese and emoji boundaries after multiple evictions", () => {
    const output = new BoundedOutputBuffer(15);
    output.append(Buffer.from("中文😀abc中文😀"));
    const first = followRunSnapshot(record(output), undefined, 4);
    expect(first.stdout.text).not.toContain("\ufffd");
    expect(first.stdout.endOffset).toBeGreaterThan(first.stdout.startOffset);
    output.append(Buffer.from("最后😀"));
    const second = followRunSnapshot(record(output), first.cursor, 64);
    expect(second.stdout.text).toContain("最后😀");
    expect(second.stdout.text).not.toContain("\ufffd");
  });

  it("refuses a byte budget that cannot consume the next character", () => {
    const output = new BoundedOutputBuffer(16);
    output.append(Buffer.from("中"));
    expect(() => followRunSnapshot(record(output), undefined, 2)).toThrow(/too small/u);
  });

  it("rejects future offsets, split characters, and unsafe integers", () => {
    const output = new BoundedOutputBuffer(16);
    output.append(Buffer.from("中文"));
    expect(() => followRunSnapshot(record(output), cursor(7), 64)).toThrow(/beyond/u);
    expect(() => followRunSnapshot(record(output), cursor(1), 64)).toThrow(/boundary/u);
    expect(() => followRunSnapshot(record(output), cursor(Number.MAX_SAFE_INTEGER + 1), 64)).toThrow(/match/u);
  });

  it("keeps legacy ledgers readable and rejects corrupt retention metadata", () => {
    const output = new BoundedOutputBuffer(16);
    output.append(Buffer.from("legacy"));
    const legacy = { ...record(output), metadata: {} };
    expect(followRunSnapshot(legacy, undefined, 64).stdout.text).toBe("legacy");
    const bad = { ...record(output), metadata: { outputRetention: { schemaVersion: "scr.output-retention/v1", stdout: { startOffset: 4, endOffset: 5 }, stderr: { startOffset: 0, endOffset: 0 } } } };
    expect(() => followRunSnapshot(bad, undefined, 64)).toThrow(/retention metadata/u);
  });

  it("persists offsets in the existing SQLite ledger without a table migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-retention-ledger-"));
    const db = join(root, "runs.sqlite");
    const output = new BoundedOutputBuffer(8);
    output.append(Buffer.from("0123456789-final"));
    const run = { ...record(output), state: "succeeded" as const, exitCode: 0, completedAt: new Date().toISOString() };
    let store: SqliteRunStore | undefined;
    try {
      store = new SqliteRunStore(db);
      store.create(run);
      store.close();
      store = new SqliteRunStore(db);
      const reopened = store.get(run.id)!;
      expect(runOutputRange(reopened, "stdout")).toEqual(output.range());
      expect(followRunSnapshot(reopened, undefined, 64).stdout.text).toBe(output.text());
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("managed output and process failure", () => {
  it("retains final stdout and stderr diagnostics after a flood and preserves failure", async () => {
    const manager = new ManagedRunManager(new MemoryRunStore(), 256);
    try {
      const run = manager.start({ kind: "terminal", label: "finite-flood", workspaceId: "workspace", command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(100000));process.stdout.write('\\n最终输出_END');process.stderr.write('y'.repeat(100000));process.stderr.write('\\n最终错误_END');process.exitCode=7;"],
        cwd: process.cwd(), timeoutMs: 15000 });
      const final = await manager.wait(run.id, 15000);
      expect(final).toMatchObject({ state: "failed", exitCode: 7, outputTruncated: true });
      expect(final!.stdout).toContain("最终输出_END");
      expect(final!.stderr).toContain("最终错误_END");
      expect(Buffer.byteLength(final!.stdout)).toBeLessThanOrEqual(256);
      expect(Buffer.byteLength(final!.stderr)).toBeLessThanOrEqual(256);
      expect(followRunSnapshot(final!, undefined, 256).stdout.skippedBytes).toBeGreaterThan(0);
    } finally { await manager.shutdown(); }
  });

  it("does not sleep on an old observation when a full-size tail has already changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-retention-wait-"));
    const gate = join(root, "continue");
    const manager = new ManagedRunManager(new MemoryRunStore(), 64);
    try {
      const run = manager.start({ kind: "terminal", label: "tail-wait", workspaceId: "workspace", command: process.execPath,
        args: ["-e", "const fs=require('node:fs');process.stdout.write('a'.repeat(256));const t=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(t);process.stdout.write('NEXT_MARKER');setTimeout(()=>{},10000);}},10);", gate],
        cwd: root, timeoutMs: 15000 });
      await vi.waitFor(() => expect(manager.get(run.id)!.stdout).toHaveLength(64), { timeout: 5000 });
      const before = manager.get(run.id)!;
      const observed = { state: before.state, stdoutBytes: Buffer.byteLength(before.stdout), stderrBytes: Buffer.byteLength(before.stderr),
        stdoutEndOffset: runOutputRange(before, "stdout").endOffset, stderrEndOffset: runOutputRange(before, "stderr").endOffset,
        outputTruncated: before.outputTruncated, cancelRequested: before.cancelRequested };
      await writeFile(gate, "go");
      await vi.waitFor(() => expect(manager.get(run.id)!.stdout).toContain("NEXT_MARKER"), { timeout: 5000 });
      const started = performance.now();
      const current = await manager.waitForChange(run.id, observed, 4000);
      expect(current!.stdout).toHaveLength(64);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
  });

  it("fails a missing executable without crashing the manager and accepts a later run", async () => {
    const manager = new ManagedRunManager(new MemoryRunStore(), 256);
    try {
      const missing = manager.start({ kind: "terminal", label: "missing", workspaceId: "workspace", command: join(tmpdir(), "scr-nonexistent-executable"), args: [], cwd: process.cwd(), timeoutMs: 5000 });
      expect(await manager.wait(missing.id, 5000)).toMatchObject({ state: "failed" });
      const healthy = manager.start({ kind: "terminal", label: "healthy", workspaceId: "workspace", command: process.execPath, args: ["-e", "process.stdout.write('OK')"], cwd: process.cwd(), timeoutMs: 5000 });
      expect(await manager.wait(healthy.id, 5000)).toMatchObject({ state: "succeeded", stdout: "OK" });
    } finally { await manager.shutdown(); }
  });
});
