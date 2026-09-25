import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MemoryRunStore,
  RUN_SCHEMA_VERSION,
  RuntimeError,
  type RunRecord,
} from "@sovereign/runtime-core";

import {
  followRunSnapshot,
  runFollowHasDelta,
} from "../src/run-follow.js";
import { ManagedRunManager } from "../src/run-manager.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: "run-1",
    kind: "terminal",
    label: "cursor test",
    workspaceId: "workspace",
    state: "running",
    createdAt: "2026-08-22T00:00:00.000Z",
    startedAt: "2026-08-22T00:00:00.100Z",
    completedAt: null,
    exitCode: null,
    signal: null,
    durationMs: null,
    stdout: "alpha\nβeta\ngamma\n",
    stderr: "warning\n",
    outputTruncated: false,
    cancelRequested: false,
    metadata: {},
    ...overrides,
  };
}

describe("run output cursors", () => {
  it("returns only output newer than the previous opaque cursor", () => {
    const first = followRunSnapshot(run(), undefined, 7);
    expect(first.stdout.text).toBe("alpha\n");
    expect(first.stdout.hasMore).toBe(true);
    expect(first.stderr.text).toBe("warning");
    expect(first.stderr.hasMore).toBe(true);
    expect(runFollowHasDelta(first)).toBe(true);

    const second = followRunSnapshot(run(), first.cursor, 7);
    expect(second.stdout.text).toBe("βeta\ng");
    expect(second.stdout.startOffset).toBe(first.stdout.endOffset);
    expect(second.stderr.text).toBe("\n");

    const third = followRunSnapshot(run(), second.cursor, 64);
    expect(third.stdout.text).toBe("amma\n");
    expect(third.stdout.hasMore).toBe(false);
    expect(third.stderr.text).toBe("");
  });

  it("rejects stale, cross-run, and non-boundary cursors", () => {
    const valid = followRunSnapshot(run(), undefined, 7);
    expect(() => followRunSnapshot(run({ id: "run-2" }), valid.cursor, 7))
      .toThrowError(RuntimeError);

    const malformed = Buffer.from(JSON.stringify({
      schemaVersion: "scr.run-cursor/v1",
      runId: "run-1",
      stdoutOffset: 7,
      stderrOffset: 0,
    }), "utf8").toString("base64url");
    expect(() => followRunSnapshot(run(), malformed, 7))
      .toThrow(/UTF-8 boundary/u);
  });

  it("surfaces terminal and retained-output truncation state", () => {
    const result = followRunSnapshot(run({
      state: "succeeded",
      completedAt: "2026-08-22T00:00:01.000Z",
      exitCode: 0,
      durationMs: 900,
      outputTruncated: true,
    }), undefined, 64);

    expect(result.terminal).toBe(true);
    expect(result.outputTruncated).toBe(true);
    expect(result.run.stdoutBytes).toBe(Buffer.byteLength(result.stdout.text, "utf8"));
  });
});

describe("managed-run output change waiting", () => {
  it("wakes on new output before the process completes", async () => {
    const root = await mkdtemp(join(tmpdir(), "scr-output-wakeup-"));
    const gate = join(root, "write-output");
    const manager = new ManagedRunManager(new MemoryRunStore(), 65_536);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const started = manager.start({
        kind: "terminal", label: "incremental-output-probe", workspaceId: "workspace",
        command: process.execPath,
        args: ["-e", [
          "const fs = require('node:fs'); process.stderr.write('READY');",
          "const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) {",
          "clearInterval(timer); process.stdout.write('first\\n'); setTimeout(() => {}, 10000); } }, 10);",
        ].join(" "), gate],
        cwd: root, timeoutMs: 15_000,
      });
      // Establish that the child has started before measuring output delivery.
      await vi.waitFor(() => expect(manager.get(started.id)?.stderr).toBe("READY"), { timeout: 5_000 });
      const initial = manager.get(started.id)!;
      const waited = manager.waitForChange(started.id, {
        state: initial.state, stdoutBytes: Buffer.byteLength(initial.stdout),
        stderrBytes: Buffer.byteLength(initial.stderr), outputTruncated: initial.outputTruncated,
        cancelRequested: initial.cancelRequested,
      }, 2_000);
      const deadline = new Promise<"timed-out">((resolve) => {
        watchdog = setTimeout(() => resolve("timed-out"), 1_500);
      });
      await writeFile(gate, "go");
      const changed = await Promise.race([waited, deadline]);
      expect(changed).not.toBe("timed-out");
      expect(changed).toMatchObject({ state: "running", stdout: "first\n" });
    } finally {
      clearTimeout(watchdog);
      await manager.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
});
