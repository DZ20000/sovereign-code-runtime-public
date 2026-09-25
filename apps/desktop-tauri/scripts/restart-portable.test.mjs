import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import {
  assertRestartTargetUnchanged,
  listRestartProcesses,
  selectRestartTarget,
  stopRestartTree,
  trackRestartTree,
} from "./restart-portable.mjs";

function processRecord(ProcessId, ParentProcessId = 0, extra = {}) {
  return {
    ProcessId, ParentProcessId, SessionId: 2, Name: "node.exe",
    StartedAt: `2026-09-22T01:00:${String(ProcessId).padStart(2, "0")}.000000Z`,
    ExecutablePath: "C:\\SO\\node.exe", ...extra,
  };
}

const shell = processRecord(10, 0, { Name: "sovereign-desktop-tauri.exe", ExecutablePath: "C:\\Installed\\sovereign-desktop-tauri.exe" });
const installed = [{ executable: shell.ExecutablePath, version: "0.1.0" }];
const snapshot = (processes) => ({ sessionId: 2, processes });

test("ordinary restart preserves the running version and uses installed SO when closed", () => {
  const otherSession = { ...shell, ProcessId: 9, SessionId: 3 };
  assert.equal(selectRestartTarget(snapshot([shell, otherSession]), []).executable, shell.ExecutablePath);
  assert.equal(selectRestartTarget(snapshot([otherSession]), installed).mode, "installed");
  const portable = { executable: "C:\\Portable\\SovereignCodeRuntime.exe" };
  assert.equal(selectRestartTarget(snapshot([shell]), installed, portable).executable, portable.executable);
  assert.throws(() => selectRestartTarget(snapshot([]), []), /No running or installed/);
  assert.throws(() => selectRestartTarget(snapshot([]), [...installed, { executable: "C:\\Other\\SO.exe" }]), /Several Sovereign installations/);
  assert.throws(() => selectRestartTarget(snapshot([shell, { ...shell, ProcessId: 12 }]), installed), /Several Sovereign instances/);
  assert.throws(() => selectRestartTarget(snapshot([{ ...shell, ExecutablePath: null }]), installed), /Cannot identify/);
});

test("restart tracking follows only the selected session tree, rejects recycled PIDs, and retains orphans", () => {
  const child = processRecord(12, shell.ProcessId);
  const grandchild = processRecord(14, child.ProcessId);
  const unrelated = processRecord(15, 0);
  const foreign = processRecord(16, shell.ProcessId, { SessionId: 3 });
  const older = processRecord(8, shell.ProcessId);
  const tree = trackRestartTree(snapshot([grandchild, child, unrelated, foreign, older, shell]), [shell]);
  assert.deepEqual(tree.map((item) => item.ProcessId).sort(), [10, 12, 14]);
  const recycled = { ...shell, StartedAt: "2026-09-22T02:00:00.000000Z" };
  const unrelatedChild = processRecord(17, shell.ProcessId);
  assert.deepEqual(trackRestartTree(snapshot([recycled, child, grandchild, unrelatedChild]), tree).map((item) => item.ProcessId).sort(), [12, 14]);
});

test("restart refuses an instance that appeared, exited, or changed during preparation", () => {
  const target = selectRestartTarget(snapshot([shell]), installed);
  assert.doesNotThrow(() => assertRestartTargetUnchanged(snapshot([shell]), target));
  assert.throws(() => assertRestartTargetUnchanged(snapshot([]), target), /changed while preparing/);
  assert.throws(() => assertRestartTargetUnchanged(snapshot([{ ...shell, StartedAt: "new" }]), target), /changed while preparing/);
  assert.throws(() => assertRestartTargetUnchanged(snapshot([shell]), { shell: null }), /changed while preparing/);
});

test("Windows stop rejects mismatched identities and terminates only its identified test process", {
  skip: process.platform !== "win32", timeout: 30_000,
}, async () => {
  const target = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  const untouched = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
  try {
    await Promise.all([once(target, "spawn"), once(untouched, "spawn")]);
    const record = listRestartProcesses().processes.find((item) => item.ProcessId === target.pid);
    assert.ok(record, "test child must be visible in the current session");
    assert.deepEqual(stopRestartTree([{ ...record, StartedAt: "2000-01-01T00:00:00.000000Z" }]), []);
    assert.deepEqual(stopRestartTree([{ ...record, SessionId: record.SessionId + 1 }]), []);
    assert.deepEqual(stopRestartTree([{ ...record, ExecutablePath: "C:\\unrelated.exe" }]), []);
    assert.doesNotThrow(() => process.kill(target.pid, 0));
    const exited = once(target, "exit");
    assert.deepEqual(stopRestartTree([record]), [target.pid]);
    await exited;
    assert.doesNotThrow(() => process.kill(untouched.pid, 0), "unrelated test process must survive");
  } finally {
    if (target.exitCode === null && target.signalCode === null) target.kill();
    if (untouched.exitCode === null && untouched.signalCode === null) untouched.kill();
  }
});
