# Dot-source this helper. It builds an auditable per-user GUI launcher and returns
# an action only: it never registers, stops, or starts a scheduled task.
function New-NoConsoleTaskAction {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$TaskName,
        [Parameter(Mandatory)][string]$StorageRoot,
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Arguments,
        [AllowEmptyString()][string]$WorkingDirectory = '',
        [Parameter(Mandatory)][string]$LogPath
    )
    $ErrorActionPreference = 'Stop'
    if ($PSVersionTable.PSEdition -ne 'Desktop') {
        throw 'Build this launcher with Windows PowerShell 5.1 (Desktop edition).'
    }
    foreach ($path in @($StorageRoot, $Executable, $LogPath)) {
        if (-not [IO.Path]::IsPathRooted($path)) { throw "Expected an absolute path: $path" }
    }
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Executable missing: $Executable" }
    if ($WorkingDirectory -and -not (Test-Path -LiteralPath $WorkingDirectory -PathType Container)) {
        throw "Working directory missing: $WorkingDirectory"
    }
    $source = Join-Path $PSScriptRoot 'no-console-task-launcher.cs'
    $sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    New-Item -ItemType Directory -Path $StorageRoot -Force | Out-Null
    # Content-addressed binaries avoid overwriting a launcher that is in use.
    $launcher = Join-Path $StorageRoot ("NoConsoleTaskLauncher-{0}.exe" -f $sourceHash.Substring(0, 16))
    if (-not (Test-Path -LiteralPath $launcher)) {
        $temporary = Join-Path $StorageRoot (([guid]::NewGuid().ToString('N')) + '.exe')
        try {
            Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -Language CSharp `
                -OutputAssembly $temporary -OutputType WindowsApplication `
                -ReferencedAssemblies @('System.dll', 'System.Xml.dll')
            if (-not (Test-Path -LiteralPath $launcher)) {
                Move-Item -LiteralPath $temporary -Destination $launcher
            }
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        }
    }
    $document = New-Object System.Xml.XmlDocument
    $root = $document.CreateElement('NoConsoleTask')
    [void]$document.AppendChild($root)
    foreach ($pair in @(
        @('Executable', $Executable), @('Arguments', $Arguments),
        @('WorkingDirectory', $WorkingDirectory), @('LogPath', $LogPath)
    )) {
        $element = $document.CreateElement($pair[0])
        $element.InnerText = $pair[1]
        [void]$root.AppendChild($element)
    }
    $xml = $document.OuterXml
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $configHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($xml)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    # Configurations are immutable too, so running tasks retain their arguments.
    $config = Join-Path $StorageRoot ("{0}-{1}.xml" -f $TaskName, $configHash.Substring(0, 16))
    if (-not (Test-Path -LiteralPath $config)) {
        [IO.File]::WriteAllText($config, $xml, [Text.UTF8Encoding]::new($false))
    }
    $parameters = @{ Execute = $launcher; Argument = ('"' + $config + '"') }
    if ($WorkingDirectory) { $parameters.WorkingDirectory = $WorkingDirectory }
    New-ScheduledTaskAction @parameters
}
