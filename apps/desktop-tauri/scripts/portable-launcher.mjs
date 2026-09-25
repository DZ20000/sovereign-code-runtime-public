import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyPortablePackage } from "./release-metadata.mjs";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const workspaceRoot = resolve(projectRoot, "..", "..");
export const artifactsRoot = resolve(projectRoot, "artifacts");

function powershellExecutable() {
  return resolve(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function escapePowerShellLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function runPowerShell(script, timeoutMs = 15_000) {
  const source = [
    "$ErrorActionPreference = 'Stop';",
    "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    script,
  ].join("\n");
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const result = spawnSync(
    powershellExecutable(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `PowerShell helper failed with exit code ${String(result.status)}.`,
    );
  }
  return result.stdout.trim();
}

function assertInsideArtifacts(candidate, root) {
  const normalizedRoot = `${resolve(root).toLocaleLowerCase("en-US")}${sep}`;
  const normalizedCandidate = resolve(candidate).toLocaleLowerCase("en-US");
  if (!normalizedCandidate.startsWith(normalizedRoot)) {
    throw new Error(`Recorded portable path is outside the artifacts directory: ${candidate}`);
  }
}

export async function resolveLatestPortableExecutable(root = artifactsRoot) {
  if (process.platform !== "win32") {
    throw new Error("The Sovereign portable desktop launcher is currently Windows-only.");
  }

  const latestFile = resolve(root, "latest-portable.txt");
  const latestPath = (await readFile(latestFile, "utf8")).trim();
  if (latestPath.length === 0) {
    throw new Error("No portable Tauri package is recorded. Run pnpm build first.");
  }
  assertInsideArtifacts(latestPath, root);
  assertInsideArtifacts(await realpath(latestPath), await realpath(root));

  return resolvePortableExecutable(latestPath);
}

export async function resolvePortableExecutable(path) {
  const portableRoot = resolve(path);
  const manifest = JSON.parse(await readFile(resolve(portableRoot, "portable-package.json"), "utf8"));
  const verification = await verifyPortablePackage(portableRoot, manifest);
  if (!verification.passed) {
    throw new Error(
      `Recorded portable package failed verification: ${verification.problems.join("; ")}`,
    );
  }

  const executableName = "SovereignCodeRuntime.exe";
  if (manifest.executable.path !== executableName ||
      !verification.componentChecks.some((component) => component.path === executableName && component.matched)) {
    throw new Error("Portable launch executable must be the verified SovereignCodeRuntime.exe component.");
  }
  return {
    latestPath: portableRoot,
    executable: resolve(portableRoot, executableName),
    manifestSha256: verification.manifestSha256,
    sourceCommit: verification.sourceCommit,
    sourceDirty: verification.sourceDirty,
    productVersion: verification.productVersion,
  };
}

export function launchPortable(executable) {
  // Hosted Windows runners can expose TEMP through a DOS 8.3 alias while
  // Win32_Process reports the launched image through its canonical long path.
  const canonicalExecutable = realpathSync.native(resolve(executable));
  const escapedExecutable = escapePowerShellLiteral(canonicalExecutable);
  const output = runPowerShell(String.raw`
$target = ${escapedExecutable}
if (-not [IO.File]::Exists($target)) { throw "Portable executable is missing: $target" }
$sessionId = (Get-Process -Id $PID).SessionId
function Find-Target {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.SessionId -eq $sessionId -and
      $_.ExecutablePath -ieq $target
    } | Select-Object -First 1
}
$process = Find-Target
if ($null -eq $process) {
  $explorer = Get-Process -Name explorer -ErrorAction SilentlyContinue |
    Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
  if ($null -eq $explorer) { throw "Windows Explorer must be running to launch Sovereign independently." }
  # Delegate creation to the desktop shell instead of inheriting the caller's Job Object.
  Start-Process -FilePath (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList ('"' + $target + '"') -WindowStyle Hidden
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $process = Find-Target
  } while ($null -eq $process -and [DateTime]::UtcNow -lt $deadline)
  if ($null -eq $process) { throw "Windows Explorer did not start the portable executable: $target" }
}
[Console]::Out.Write($process.ProcessId)
`, 15_000);
  const processId = Number(output);
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error(`Portable launcher returned an invalid process id: ${output}`);
  }
  return processId;
}
