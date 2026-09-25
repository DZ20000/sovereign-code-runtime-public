import { basename, resolve } from "node:path";
import {
  assertRestartTargetUnchanged, listRestartProcesses, stopRestartTree,
  trackRestartTree, waitForTreeExit,
} from "./restart-portable.mjs";
import { requestGracefulRestartExit } from "./restart-exit-request.mjs";

export function selectInstallerTarget(snapshot, executable) {
  const shellNames = new Set(["sovereigncoderuntime.exe", "sovereign-desktop-tauri.exe"]);
  const shells = snapshot.processes.filter(item => shellNames.has(item.Name.toLowerCase()));
  const targetPath = resolve(executable).toLowerCase();
  for (const shell of shells) {
    const samePath = shell.ExecutablePath && resolve(shell.ExecutablePath).toLowerCase() === targetPath;
    // NSIS silently kills by executable name for the current user. Refuse a
    // conflicting instance before entering NSIS; never broaden our stop scope.
    if (!shell.ExecutablePath || !shell.StartedAt ||
        (samePath && shell.SessionId !== snapshot.sessionId) ||
        (!samePath && (shell.SessionId === snapshot.sessionId || shell.Name.toLowerCase() === basename(executable).toLowerCase()))) {
      throw new Error("Another or unidentified Sovereign instance conflicts with this installation; leave it running and close it before updating.");
    }
  }
  const matching = shells.filter(item => resolve(item.ExecutablePath).toLowerCase() === targetPath);
  if (matching.length > 1) throw new Error("Several instances use the installed executable; no shutdown was requested.");
  return { executable, shell: matching[0] ?? null };
}

export function installerProcessSnapshot(executable) {
  const snapshot = listRestartProcesses({ allSessions: true });
  const target = selectInstallerTarget(snapshot, executable);
  return { snapshot, target, processes: trackRestartTree(snapshot, target.shell ? [target.shell] : []) };
}

export async function stopInstalledApplication(executable, expected) {
  const current = installerProcessSnapshot(executable);
  assertRestartTargetUnchanged(current.snapshot, expected.target);
  const tree = trackRestartTree(current.snapshot, expected.processes);
  const gracefulRequest = current.target.shell === null ? null : await requestGracefulRestartExit(executable, { waitForExitMs: 15_000 });
  if (gracefulRequest?.requested && !gracefulRequest.exited) {
    throw new Error("The restart control process has not exited; installation did not start.");
  }
  let remaining = await waitForTreeExit(tree, 15_000);
  let forced = [];
  if (remaining.processes.length > 0) {
    forced = stopRestartTree(remaining.processes);
    remaining = await waitForTreeExit(remaining.processes, 10_000);
  }
  if (remaining.processes.length || installerProcessSnapshot(executable).target.shell !== null) {
    throw new Error("The selected installed process tree is still running; installation did not start.");
  }
  return { gracefulRequest, forced };
}
