import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { runPowerShell } from "./portable-launcher.mjs";

function installedRecords() {
  if (process.platform !== "win32") return [];
  // Match the current-user NSIS registration used by verify-installed-nsis.mjs.
  const raw = runPowerShell(String.raw`
@(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -eq 'Sovereign Code Runtime' } |
  Select-Object DisplayName, DisplayVersion, InstallLocation) | ConvertTo-Json -Compress
`);
  const value = raw ? JSON.parse(raw) : [];
  return Array.isArray(value) ? value : [value];
}

// Discovery establishes an existing registered path, not package integrity.
export async function findInstalledApplications(records = installedRecords()) {
  const applications = new Map();
  for (const entry of records) {
    if (entry?.DisplayName !== "Sovereign Code Runtime" || typeof entry.InstallLocation !== "string") continue;
    const location = entry.InstallLocation.trim().replace(/^"(.*)"$/u, "$1");
    if (!isAbsolute(location)) continue;
    const executable = resolve(location, "sovereign-desktop-tauri.exe");
    try {
      const locationInfo = await lstat(location);
      const info = await lstat(executable);
      if (!locationInfo.isDirectory() || locationInfo.isSymbolicLink()
        || !info.isFile() || info.isSymbolicLink() || info.nlink > 1) continue;
      // Windows may return the same registered path in DOS 8.3 form while
      // realpath exposes its long form. Compare canonical containment instead
      // of rejecting that safe spelling difference, and return one stable path.
      const canonicalLocation = await realpath(location);
      const canonicalExecutable = await realpath(executable);
      if (resolve(canonicalLocation, "sovereign-desktop-tauri.exe").toLowerCase()
        !== canonicalExecutable.toLowerCase()) continue;
      applications.set(canonicalExecutable.toLowerCase(), {
        executable: canonicalExecutable,
        version: typeof entry.DisplayVersion === "string" ? entry.DisplayVersion : null,
      });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }
  return [...applications.values()];
}
