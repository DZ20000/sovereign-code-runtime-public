import { resolve } from "node:path";

import {
  escapePowerShellLiteral,
  runPowerShell,
} from "./portable-launcher.mjs";

export function assertInstalledExecutableReplaceable(
  path,
  runPowerShellImpl = runPowerShell,
) {
  const executable = resolve(path);
  const literal = escapePowerShellLiteral(executable);
  let outcome;
  try {
    outcome = runPowerShellImpl(
      [
        `$path = ${literal};`,
        "if (-not [System.IO.File]::Exists($path)) { Write-Output 'absent'; exit 0 }",
        "$stream = $null;",
        "try {",
        "  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None);",
        "  Write-Output 'replaceable';",
        "} finally {",
        "  if ($null -ne $stream) { $stream.Dispose() }",
        "}",
      ].join("\n"),
      5_000,
    );
  } catch (error) {
    throw new Error(
      `Installed executable is not replaceable before NSIS cutover: ${executable}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (outcome !== "replaceable" && outcome !== "absent") {
    throw new Error(
      `Unexpected installed-executable replaceability probe result for ${executable}: ${String(outcome)}`,
    );
  }
  return {
    path: executable,
    existed: outcome === "replaceable",
    replaceable: true,
  };
}
