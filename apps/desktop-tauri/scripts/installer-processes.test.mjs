import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { selectInstallerTarget } from "./installer-processes.mjs";
import { trackRestartTree } from "./restart-portable.mjs";

test("installation selects only its installed session tree, preserving unrelated runtime hosts", () => {
  const executable = resolve("installed/sovereign-desktop-tauri.exe");
  const shell = { ProcessId: 1, SessionId: 2, ParentProcessId: 0, StartedAt: "2026-09-22T00:00:01Z", Name: "sovereign-desktop-tauri.exe", ExecutablePath: executable };
  const child = { ...shell, ProcessId: 2, ParentProcessId: 1, Name: "node.exe", ExecutablePath: resolve("installed/node.exe") };
  const unrelated = { ...child, ProcessId: 3, ParentProcessId: 0 };
  const snapshot = { sessionId: 2, processes: [shell, child, unrelated] };
  const target = selectInstallerTarget(snapshot, executable);
  assert.deepEqual(trackRestartTree(snapshot, [target.shell]).map(item => item.ProcessId), [1, 2]);
  assert.equal(selectInstallerTarget({ ...snapshot, processes: [unrelated] }, executable).shell, null);
  for (const conflict of [
    { ...shell, SessionId: 3 },
    { ...shell, ExecutablePath: resolve("development/sovereign-desktop-tauri.exe") },
    { ...shell, ExecutablePath: null },
    { ...shell, StartedAt: null },
  ]) {
    assert.throws(() => selectInstallerTarget({ ...snapshot, processes: [conflict] }, executable), /conflicts/);
  }
  assert.throws(() => selectInstallerTarget({ ...snapshot, processes: [shell, { ...shell, ProcessId: 4 }] }, executable), /Several instances/);
});
