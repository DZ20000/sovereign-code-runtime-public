import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertSafeInstallerRelativePath,
  sha256InstallerFile,
  verifyInstalledExecutable,
  verifyInstallerPackage,
} from "./installer-package.mjs";
import { escapePowerShellLiteral, runPowerShell } from "./portable-launcher.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifestPath = resolve(
  projectRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  "installer-package.json",
);
const PROFILE_VALUES = new Set(["observe", "workspace", "consequential", "bypass"]);
const FALLBACK_VALUES = new Set(["observe", "workspace", "consequential"]);

function parseBooleanArgument(value, label) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be true or false.`);
}

function parseArguments(argv) {
  const options = {
    manifestPath: defaultManifestPath,
    requireRunning: false,
    permissionModelVersion: null,
    expectedProfile: null,
    expectedFallback: null,
    expectedWorkspaceRestore: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--require-running") {
      options.requireRunning = true;
      continue;
    }
    if (
      value === "--manifest" ||
      value === "--permission-model-version" ||
      value === "--expect-profile" ||
      value === "--expect-fallback" ||
      value === "--expect-workspace-restore"
    ) {
      const next = argv[index + 1];
      if (typeof next !== "string" || next.length === 0) {
        throw new Error(`${value} requires a value.`);
      }
      index += 1;
      if (value === "--manifest") options.manifestPath = resolve(next);
      if (value === "--permission-model-version") {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error("--permission-model-version must be a positive integer.");
        }
        options.permissionModelVersion = parsed;
      }
      if (value === "--expect-profile") {
        if (!PROFILE_VALUES.has(next)) throw new Error(`Unknown permission profile: ${next}`);
        options.expectedProfile = next;
      }
      if (value === "--expect-fallback") {
        if (!FALLBACK_VALUES.has(next)) throw new Error(`Unknown permission fallback: ${next}`);
        options.expectedFallback = next;
      }
      if (value === "--expect-workspace-restore") {
        options.expectedWorkspaceRestore = parseBooleanArgument(next, value);
      }
      continue;
    }
    throw new Error(`Unknown installed-package verification argument: ${value}`);
  }
  return options;
}

function normalizeArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeQuotedPath(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (unquoted.length === 0) return null;
  return resolve(unquoted).toLocaleLowerCase("en-US");
}

function sameWindowsPath(left, right) {
  const normalizedLeft = normalizeQuotedPath(left);
  const normalizedRight = normalizeQuotedPath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

async function requireDirectRegularFile(path, label) {
  const info = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (info === null || !info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error(`${label} must be one unshared direct regular file: ${path}`);
  }
  return info;
}

function containedInstalledPath(installRoot, logicalPath, label) {
  const safePath = assertSafeInstallerRelativePath(logicalPath, label);
  const candidate = resolve(installRoot, ...safePath.replaceAll("\\", "/").split("/"));
  const relation = relative(installRoot, candidate);
  if (
    relation === "" ||
    relation === ".." ||
    relation.startsWith(`..${sep}`) ||
    isAbsolute(relation)
  ) {
    throw new Error(`${label} resolves outside the installed application root.`);
  }
  return candidate;
}

function parseRuntimeDescriptor(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing from runtime-manifest.json.`);
  }
  const path = value.path ?? value.executable;
  if (typeof path !== "string" || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? "")) {
    throw new Error(`${label} has an invalid path or SHA-256 digest.`);
  }
  return { path, sha256: value.sha256 };
}

async function readSettingsSnapshot(settingsPath) {
  const bytes = await readFile(settingsPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (bytes === null) return null;
  const value = JSON.parse(bytes.toString("utf8"));
  const workspaceRoot = typeof value.workspaceRoot === "string" ? value.workspaceRoot : null;
  const restoreRoot = typeof value.unattendedWorkspaceRoot === "string"
    ? value.unattendedWorkspaceRoot
    : null;
  return {
    permissionModelVersion: Number.isSafeInteger(value.permissionModelVersion)
      ? value.permissionModelVersion
      : null,
    permissionProfile: typeof value.permissionProfile === "string"
      ? value.permissionProfile
      : null,
    rememberedPermissionProfile: typeof value.rememberedPermissionProfile === "string"
      ? value.rememberedPermissionProfile
      : null,
    workspaceRestoreBound: workspaceRoot !== null && restoreRoot !== null &&
      sameWindowsPath(workspaceRoot, restoreRoot),
    autoStart: value.autoStart === true,
    bypassGrantPresent: typeof value.permissionBypassGrantEncrypted === "string" &&
      value.permissionBypassGrantEncrypted.length > 0,
  };
}

function settingsExpectationProblems(settings, options) {
  const problems = [];
  if (options.permissionModelVersion !== null && settings?.permissionModelVersion !== options.permissionModelVersion) {
    problems.push(
      `Permission model version is ${String(settings?.permissionModelVersion)}, expected ${options.permissionModelVersion}.`,
    );
  }
  if (options.expectedProfile !== null && settings?.permissionProfile !== options.expectedProfile) {
    problems.push(
      `Permission profile is ${String(settings?.permissionProfile)}, expected ${options.expectedProfile}.`,
    );
  }
  if (options.expectedFallback !== null && settings?.rememberedPermissionProfile !== options.expectedFallback) {
    problems.push(
      `Permission fallback is ${String(settings?.rememberedPermissionProfile)}, expected ${options.expectedFallback}.`,
    );
  }
  if (
    options.expectedWorkspaceRestore !== null &&
    settings?.workspaceRestoreBound !== options.expectedWorkspaceRestore
  ) {
    problems.push(
      `Workspace restore binding is ${String(settings?.workspaceRestoreBound)}, expected ${String(options.expectedWorkspaceRestore)}.`,
    );
  }
  return problems;
}

async function waitForExpectedSettings(settingsPath, options, timeoutMs = 20_000) {
  const hasExpectation = options.permissionModelVersion !== null ||
    options.expectedProfile !== null ||
    options.expectedFallback !== null ||
    options.expectedWorkspaceRestore !== null;
  if (!hasExpectation) return await readSettingsSnapshot(settingsPath);
  const deadline = Date.now() + timeoutMs;
  let settings = await readSettingsSnapshot(settingsPath);
  while (settingsExpectationProblems(settings, options).length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    settings = await readSettingsSnapshot(settingsPath);
  }
  return settings;
}

const options = parseArguments(process.argv.slice(2));
if (process.platform !== "win32") {
  throw new Error("Installed NSIS verification is Windows-only.");
}
const verification = await verifyInstallerPackage(options.manifestPath);
if (!verification.passed) {
  throw new Error(`Installer package verification failed: ${verification.problems.join("; ")}`);
}
if (verification.manifest.source.dirty) {
  throw new Error("Refusing to verify an installed package produced from dirty source.");
}

const localAppData = process.env.LOCALAPPDATA;
const appData = process.env.APPDATA;
if (typeof localAppData !== "string" || localAppData.length === 0) {
  throw new Error("LOCALAPPDATA is unavailable.");
}
if (typeof appData !== "string" || appData.length === 0) {
  throw new Error("APPDATA is unavailable.");
}

const manifest = verification.manifest;
const installRoot = resolve(localAppData, "Programs", manifest.product.name);
const installedExecutable = containedInstalledPath(
  installRoot,
  manifest.installedExecutable.path,
  "Installed executable path",
);
const uninstallExecutable = resolve(installRoot, "uninstall.exe");
const runtimeManifestPath = resolve(installRoot, "runtime-manifest.json");
const settingsPath = resolve(appData, manifest.product.identifier, "settings.json");
const problems = [];

const installedExecutableCheck = await verifyInstalledExecutable(
  installedExecutable,
  manifest.installedExecutable,
);
if (!installedExecutableCheck.matched) {
  problems.push(
    `Installed executable does not match the NSIS payload digest ${manifest.installedExecutable.sha256}.`,
  );
}
await requireDirectRegularFile(uninstallExecutable, "NSIS uninstaller").catch((error) => {
  problems.push(error instanceof Error ? error.message : String(error));
});

let runtimeManifest = null;
const runtimeComponentChecks = [];
try {
  await requireDirectRegularFile(runtimeManifestPath, "Runtime resource manifest");
  runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, "utf8"));
  if (runtimeManifest.schemaVersion !== "scr.runtime-resources/v1") {
    throw new Error(`Unexpected runtime resource schema: ${String(runtimeManifest.schemaVersion)}`);
  }
  const descriptors = [
    ["node", parseRuntimeDescriptor(runtimeManifest.node, "Bundled Node runtime")],
    ["runtime-host", parseRuntimeDescriptor(runtimeManifest.runtimeHost, "Runtime Host")],
    ["host-guardian", parseRuntimeDescriptor(runtimeManifest.hostGuardian, "Host Guardian")],
    ["native-agent", parseRuntimeDescriptor(runtimeManifest.nativeAgent, "Native Agent")],
  ];
  for (const [role, descriptor] of descriptors) {
    const path = containedInstalledPath(installRoot, descriptor.path, `${role} path`);
    const info = await requireDirectRegularFile(path, role);
    const actualSha256 = await sha256InstallerFile(path);
    const matched = actualSha256 === descriptor.sha256;
    runtimeComponentChecks.push({
      role,
      path,
      bytes: info.size,
      expectedSha256: descriptor.sha256,
      actualSha256,
      matched,
    });
    if (!matched) problems.push(`${role} does not match runtime-manifest.json.`);
  }
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
}

const escapedExecutable = escapePowerShellLiteral(installedExecutable);
const escapedInstallRoot = escapePowerShellLiteral(installRoot);
const escapedUninstaller = escapePowerShellLiteral(uninstallExecutable);
const escapedProductName = escapePowerShellLiteral(manifest.product.name);
const windowsState = JSON.parse(runPowerShell(String.raw`
$expectedExecutable = [IO.Path]::GetFullPath(${escapedExecutable})
$expectedInstallRoot = [IO.Path]::GetFullPath(${escapedInstallRoot})
$expectedUninstaller = [IO.Path]::GetFullPath(${escapedUninstaller})
$productName = ${escapedProductName}
function Read-Shortcut([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($path)
  [pscustomobject]@{
    path = $path
    targetPath = $shortcut.TargetPath
    arguments = $shortcut.Arguments
    workingDirectory = $shortcut.WorkingDirectory
  }
}
$desktopShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) ($productName + '.lnk')
$startMenuShortcutPath = Join-Path ([Environment]::GetFolderPath('Programs')) ($productName + '.lnk')
$uninstall = @(
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq $productName } |
    Select-Object -First 1 DisplayName, DisplayVersion, InstallLocation, UninstallString, QuietUninstallString
)
$runValue = Get-ItemPropertyValue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $productName -ErrorAction SilentlyContinue
$processes = @(
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Name -in @('SovereignCodeRuntime.exe', 'sovereign-desktop-tauri.exe') -and
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      [IO.Path]::GetFullPath($_.ExecutablePath).Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    } |
    Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine
)
[pscustomobject]@{
  desktopShortcut = Read-Shortcut $desktopShortcutPath
  startMenuShortcut = Read-Shortcut $startMenuShortcutPath
  uninstall = $uninstall
  runValue = $runValue
  processes = $processes
} | ConvertTo-Json -Depth 6 -Compress
`));

const uninstallEntries = normalizeArray(windowsState.uninstall);
const uninstallEntry = uninstallEntries[0] ?? null;
if (uninstallEntry === null) {
  problems.push("Current-user uninstall registry entry is missing.");
} else {
  if (uninstallEntry.DisplayName !== manifest.product.name) {
    problems.push("Uninstall registry display name does not match the package manifest.");
  }
  if (uninstallEntry.DisplayVersion !== manifest.product.version) {
    problems.push(
      `Uninstall registry version is ${String(uninstallEntry.DisplayVersion)}, expected ${manifest.product.version}.`,
    );
  }
  if (!sameWindowsPath(uninstallEntry.InstallLocation, installRoot)) {
    problems.push("Uninstall registry install location does not match the verified install root.");
  }
  if (!sameWindowsPath(uninstallEntry.UninstallString, uninstallExecutable)) {
    problems.push("Uninstall registry command does not target the installed NSIS uninstaller.");
  }
}

for (const [label, shortcut] of [
  ["Desktop shortcut", windowsState.desktopShortcut],
  ["Start Menu shortcut", windowsState.startMenuShortcut],
]) {
  if (shortcut === null || shortcut === undefined) {
    problems.push(`${label} is missing.`);
  } else if (!sameWindowsPath(shortcut.targetPath, installedExecutable)) {
    problems.push(`${label} does not target the verified installed executable.`);
  }
}

const runningProcesses = normalizeArray(windowsState.processes);
if (options.requireRunning && runningProcesses.length === 0) {
  problems.push("The verified installed executable is not running.");
}

const settings = await waitForExpectedSettings(settingsPath, options);
problems.push(...settingsExpectationProblems(settings, options));
if (settings !== null) {
  const expectedRunValue = `"${installedExecutable}" --autostart`;
  if (settings.autoStart && windowsState.runValue !== expectedRunValue) {
    problems.push("Windows login startup does not target the verified installed executable.");
  }
  if (!settings.autoStart && windowsState.runValue !== null && windowsState.runValue !== undefined) {
    problems.push("Windows login startup is present even though autoStart is disabled.");
  }
}

const report = {
  passed: problems.length === 0,
  manifestPath: verification.manifestPath,
  manifestSha256: verification.manifestSha256,
  sourceCommit: manifest.source.commit,
  productVersion: manifest.product.version,
  installRoot,
  installedExecutable,
  installedExecutableCheck,
  runtimeManifestPath,
  runtimeComponentChecks,
  uninstallExecutable,
  shortcuts: {
    desktop: windowsState.desktopShortcut ?? null,
    startMenu: windowsState.startMenuShortcut ?? null,
  },
  uninstallRegistry: uninstallEntry,
  runningProcessCount: runningProcesses.length,
  settings,
  problems,
};
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
