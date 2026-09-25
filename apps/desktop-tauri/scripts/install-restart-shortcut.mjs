import { resolve } from "node:path";

import {
  escapePowerShellLiteral,
  runPowerShell,
  workspaceRoot,
} from "./portable-launcher.mjs";
import { listRestartProcesses, resolveRestartTarget } from "./restart-portable.mjs";

const dryRun = process.argv.slice(2).includes("--dry-run");
const commandPath = resolve(workspaceRoot, "restart-sovereign.cmd");
const { executable } = await resolveRestartTarget(listRestartProcesses());
const commandLiteral = escapePowerShellLiteral(commandPath);
const executableLiteral = escapePowerShellLiteral(executable);

const destinationOutput = runPowerShell(String.raw`
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = [Environment]::GetFolderPath('Programs')
$startMenuDirectory = Join-Path $programs 'Sovereign Code Runtime'
[pscustomobject]@{
  desktop = Join-Path $desktop 'Restart Sovereign.lnk'
  startMenu = Join-Path $startMenuDirectory 'Restart Sovereign.lnk'
  startMenuDirectory = $startMenuDirectory
} | ConvertTo-Json -Compress
`);
const destinations = JSON.parse(destinationOutput);

if (dryRun) {
  console.log(JSON.stringify({
    dryRun: true,
    commandPath,
    executable,
    destinations,
  }, null, 2));
  process.exit(0);
}

const destinationLiteral = escapePowerShellLiteral(JSON.stringify(destinations));
runPowerShell(String.raw`
$destinations = ConvertFrom-Json ${destinationLiteral}
$commandPath = ${commandLiteral}
$iconPath = ${executableLiteral}
$cmdPath = Join-Path $env:SystemRoot 'System32\cmd.exe'
$arguments = '/d /c ""' + $commandPath + '""'
$description = 'Restart the current Sovereign version, or start the installed version when it is closed.'

New-Item -ItemType Directory -Path $destinations.startMenuDirectory -Force | Out-Null
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcutPath in @($destinations.desktop, $destinations.startMenu)) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $cmdPath
  $shortcut.Arguments = $arguments
  $shortcut.WorkingDirectory = ${escapePowerShellLiteral(workspaceRoot)}
  $shortcut.IconLocation = $iconPath + ',0'
  $shortcut.Description = $description
  $shortcut.Save()
}
`);

console.log(JSON.stringify({
  installed: true,
  commandPath,
  executable,
  shortcuts: [destinations.desktop, destinations.startMenu],
}, null, 2));
