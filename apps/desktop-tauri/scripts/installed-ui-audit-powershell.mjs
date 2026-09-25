import { escapePowerShellLiteral } from "./portable-launcher.mjs";

function powershellLiteralOrNull(value) {
  return value === null ? "$null" : escapePowerShellLiteral(value);
}

export function buildInstalledUiAuditPowerShell(options) {
  const executable = escapePowerShellLiteral(options.executablePath);
  const expectedWebViewData = escapePowerShellLiteral(
    options.expectedWebViewDataPath,
  );
  const screenshotPath = powershellLiteralOrNull(options.screenshotPath);
  const maxElements = options.maxAccessibilityElements;
  const accessibilityDeadlineMs = options.accessibilityDeadlineMs;
  if (
    !Number.isSafeInteger(accessibilityDeadlineMs) ||
    accessibilityDeadlineMs < 1_000 ||
    accessibilityDeadlineMs > 25_000
  ) {
    throw new Error(
      "Installed UI accessibility deadline must be from 1000 through 25000 milliseconds.",
    );
  }

  return String.raw`
$expectedExecutable = [IO.Path]::GetFullPath(${executable})
$expectedWebViewData = [IO.Path]::GetFullPath(${expectedWebViewData})
$screenshotPath = ${screenshotPath}
$maxAccessibilityElements = ${maxElements}
$accessibilityDeadlineMs = ${accessibilityDeadlineMs}
$probeStopwatch = [Diagnostics.Stopwatch]::StartNew()

function Get-BoundedAuditText([object]$value) {
  $text = [string]$value
  if ($text.Length -le 512) { return $text }
  return $text.Substring(0, 512)
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class ScrInstalledUiAuditNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT {
    public int Left; public int Top; public int Right; public int Bottom;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
  public static IntPtr[] TopLevelWindowsForProcess(uint expectedProcessId) {
    var result = new List<IntPtr>();
    EnumWindows((hWnd, _) => {
      uint processId;
      GetWindowThreadProcessId(hWnd, out processId);
      if (processId == expectedProcessId) result.Add(hWnd);
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static string ClassName(IntPtr hWnd) {
    var text = new StringBuilder(512);
    GetClassName(hWnd, text, text.Capacity);
    return text.ToString();
  }
  public static string Title(IntPtr hWnd) {
    var text = new StringBuilder(2048);
    GetWindowText(hWnd, text, text.Capacity);
    return text.ToString();
  }
  public static int Cloaked(IntPtr hWnd) {
    int value = 0;
    return DwmGetWindowAttribute(hWnd, 14, out value, 4) == 0 ? value : -1;
  }
}
'@ -ErrorAction SilentlyContinue

$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
$appProcesses = @(
  $allProcesses |
    Where-Object {
      $_.Name -ieq 'sovereign-desktop-tauri.exe' -and
      -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
      [IO.Path]::GetFullPath($_.ExecutablePath).Equals($expectedExecutable, [StringComparison]::OrdinalIgnoreCase)
    } |
    Sort-Object CreationDate -Descending
)
$selected = $appProcesses | Select-Object -First 1

if ($null -eq $selected) {
  [pscustomobject]@{
    processCount = 0
    process = $null
    window = $null
    webView = $null
    accessibility = $null
    screenshot = $null
  } | ConvertTo-Json -Depth 8 -Compress
  return
}

$nativeProcess = Get-Process -Id $selected.ProcessId -ErrorAction Stop
$windowCandidates = @()
foreach ($candidateHandle in [ScrInstalledUiAuditNative]::TopLevelWindowsForProcess([uint32]$selected.ProcessId)) {
  $candidateRect = New-Object ScrInstalledUiAuditNative+RECT
  if (-not [ScrInstalledUiAuditNative]::GetWindowRect($candidateHandle, [ref]$candidateRect)) {
    continue
  }
  $candidateWidth = [Math]::Max(0, $candidateRect.Right - $candidateRect.Left)
  $candidateHeight = [Math]::Max(0, $candidateRect.Bottom - $candidateRect.Top)
  $candidateArea = [long]$candidateWidth * [long]$candidateHeight
  $candidateClass = [ScrInstalledUiAuditNative]::ClassName($candidateHandle)
  $candidatePriority = if ($candidateClass -eq 'Tauri Window') {
    2
  } elseif ($candidateClass -eq 'tray_icon_app') {
    0
  } else {
    1
  }
  $windowCandidates += [pscustomobject]@{
    handle = $candidateHandle
    className = $candidateClass
    title = [ScrInstalledUiAuditNative]::Title($candidateHandle)
    priority = $candidatePriority
    area = $candidateArea
    rect = $candidateRect
  }
}
$selectedWindow = $windowCandidates |
  Sort-Object @{ Expression = { $_.priority }; Descending = $true }, @{ Expression = { $_.area }; Descending = $true } |
  Select-Object -First 1
$windowHandle = if ($null -ne $selectedWindow) {
  [IntPtr]$selectedWindow.handle
} else {
  [IntPtr]$nativeProcess.MainWindowHandle
}
$window = $null
if ($windowHandle -ne [IntPtr]::Zero) {
  $rect = New-Object ScrInstalledUiAuditNative+RECT
  $rectAvailable = [ScrInstalledUiAuditNative]::GetWindowRect($windowHandle, [ref]$rect)
  $width = if ($rectAvailable) { [Math]::Max(0, $rect.Right - $rect.Left) } else { 0 }
  $height = if ($rectAvailable) { [Math]::Max(0, $rect.Bottom - $rect.Top) } else { 0 }
  $virtualLeft = [ScrInstalledUiAuditNative]::GetSystemMetrics(76)
  $virtualTop = [ScrInstalledUiAuditNative]::GetSystemMetrics(77)
  $virtualWidth = [ScrInstalledUiAuditNative]::GetSystemMetrics(78)
  $virtualHeight = [ScrInstalledUiAuditNative]::GetSystemMetrics(79)
  $intersectionWidth = [Math]::Max(0, [Math]::Min($rect.Right, $virtualLeft + $virtualWidth) - [Math]::Max($rect.Left, $virtualLeft))
  $intersectionHeight = [Math]::Max(0, [Math]::Min($rect.Bottom, $virtualTop + $virtualHeight) - [Math]::Max($rect.Top, $virtualTop))
  $window = [pscustomobject]@{
    handle = ('0x{0:X}' -f $windowHandle.ToInt64())
    className = if ($null -ne $selectedWindow) { $selectedWindow.className } else { [ScrInstalledUiAuditNative]::ClassName($windowHandle) }
    title = if ($null -ne $selectedWindow) { $selectedWindow.title } else { [ScrInstalledUiAuditNative]::Title($windowHandle) }
    visible = [ScrInstalledUiAuditNative]::IsWindowVisible($windowHandle)
    minimized = [ScrInstalledUiAuditNative]::IsIconic($windowHandle)
    hung = [ScrInstalledUiAuditNative]::IsHungAppWindow($windowHandle)
    cloaked = [ScrInstalledUiAuditNative]::Cloaked($windowHandle)
    foreground = [ScrInstalledUiAuditNative]::GetForegroundWindow() -eq $windowHandle
    bounds = [pscustomobject]@{
      left = $rect.Left
      top = $rect.Top
      width = $width
      height = $height
    }
    virtualScreenIntersection = [pscustomobject]@{
      width = $intersectionWidth
      height = $intersectionHeight
    }
  }
}

function Get-DescendantProcesses([int]$rootProcessId, [object[]]$processes) {
  $queue = New-Object 'System.Collections.Generic.Queue[int]'
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  $rows = @()
  $queue.Enqueue($rootProcessId)
  while ($queue.Count -gt 0 -and $rows.Count -lt 128) {
    $parent = $queue.Dequeue()
    if (-not $seen.Add($parent)) { continue }
    foreach ($child in @($processes | Where-Object { $_.ParentProcessId -eq $parent })) {
      $rows += $child
      $queue.Enqueue([int]$child.ProcessId)
    }
  }
  return $rows
}

$descendants = @(Get-DescendantProcesses ([int]$selected.ProcessId) $allProcesses)
$webViewProcesses = @($descendants | Where-Object { $_.Name -ieq 'msedgewebview2.exe' })
$webViewRows = @()
foreach ($entry in $webViewProcesses) {
  $commandLine = [string]$entry.CommandLine
  $role = 'browser'
  $typeMatch = [regex]::Match($commandLine, '--type=([^\s]+)')
  if ($typeMatch.Success) { $role = $typeMatch.Groups[1].Value }
  if ($role -eq 'utility') {
    $utilityMatch = [regex]::Match($commandLine, '--utility-sub-type=([^\s]+)')
    if ($utilityMatch.Success) { $role = 'utility:' + $utilityMatch.Groups[1].Value }
  }
  $userData = $null
  $userDataMatch = [regex]::Match($commandLine, '--user-data-dir=(?:"([^"]+)"|([^\s]+))')
  if ($userDataMatch.Success) {
    $userData = if ($userDataMatch.Groups[1].Value.Length -gt 0) {
      $userDataMatch.Groups[1].Value
    } else {
      $userDataMatch.Groups[2].Value
    }
  }
  $version = $null
  if (-not [string]::IsNullOrWhiteSpace($entry.ExecutablePath)) {
    $version = (Get-Item -LiteralPath $entry.ExecutablePath -ErrorAction SilentlyContinue).VersionInfo.FileVersion
  }
  $webViewRows += [pscustomobject]@{
    processId = [int]$entry.ProcessId
    parentProcessId = [int]$entry.ParentProcessId
    role = $role
    version = $version
    userDataPathMatches =
      $null -ne $userData -and
      [IO.Path]::GetFullPath($userData).Equals($expectedWebViewData, [StringComparison]::OrdinalIgnoreCase)
  }
}
$webView = [pscustomobject]@{
  processCount = $webViewRows.Count
  browserCount = @($webViewRows | Where-Object { $_.role -eq 'browser' }).Count
  rendererCount = @($webViewRows | Where-Object { $_.role -eq 'renderer' }).Count
  gpuCount = @($webViewRows | Where-Object { $_.role -eq 'gpu-process' }).Count
  networkServiceCount = @($webViewRows | Where-Object { $_.role -like 'utility:network.mojom.NetworkService*' }).Count
  allUserDataPathsMatch =
    $webViewRows.Count -gt 0 -and
    @($webViewRows | Where-Object { -not $_.userDataPathMatches }).Count -eq 0
  versions = @($webViewRows.version | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
  roles = @($webViewRows | Select-Object processId, parentProcessId, role)
}

$recognizedNames = @(
  'Overview', 'Tasks', 'Agent', 'Runs', 'Terminal', 'Python', 'Browser',
  'Computer', 'Workflows', 'Settings', '概览', '任务', '智能体', '运行',
  '终端', '浏览器', '计算机', '桌面', '工作流', '设置'
)
$accessibilityProcessIds = [int[]]@(
  (@([int]$selected.ProcessId) + @($webViewRows.processId)) |
    Sort-Object -Unique
)
$accessibilityState = [hashtable]::Synchronized(@{
  stage = 'accessibility-bootstrap'
  cancelled = $false
  elementCount = 0
  limited = $false
  limitStage = $null
  diagnostic = $null
  recognizedNavigation = [System.Collections.Concurrent.ConcurrentDictionary[string, byte]]::new()
  problem = $null
})
$accessibilityScript = @'
param(
  [int[]]$processIds,
  [string[]]$recognizedNames,
  [int]$maxElements,
  [hashtable]$state
)
try {
  Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
  Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
  $state.stage = 'automation-root'
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($processId in $processIds) {
    if ([bool]$state.cancelled) { return }
    if ([int]$state.elementCount -ge $maxElements) {
      $state.limited = $true
      $state.limitStage = 'element-limit'
      $state.diagnostic = "UI Automation reached the configured element limit of $maxElements."
      return
    }
    $state.stage = 'process-descendants'
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
      [int]$processId
    )
    $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
    $state.stage = 'element-properties'
    for ($index = 0; $index -lt $elements.Count; $index += 1) {
      if ([bool]$state.cancelled) { return }
      if ([int]$state.elementCount -ge $maxElements) {
        $state.limited = $true
        $state.limitStage = 'element-limit'
        $state.diagnostic = "UI Automation reached the configured element limit of $maxElements."
        return
      }
      try {
        $element = $elements.Item($index)
        $state.elementCount = [int]$state.elementCount + 1
        $name = [string]$element.Current.Name
        if ($recognizedNames -contains $name) {
          [void]$state.recognizedNavigation.TryAdd($name, [byte]0)
        }
      } catch {
      }
    }
  }
} catch {
  $message = [string]$_.Exception.Message
  if ($message.Length -gt 512) { $message = $message.Substring(0, 512) }
  $state.problem = $message
}
'@
$accessibilityRunspace = $null
$accessibilityRunner = $null
$accessibilityAsync = $null
$accessibilityCompleted = $false
$accessibilityStopWaitMs = 2000
try {
  $remainingAccessibilityMs = [Math]::Max(
    0,
    $accessibilityDeadlineMs - [int]$probeStopwatch.ElapsedMilliseconds
  )
  if ($remainingAccessibilityMs -lt 1) {
    $accessibilityState.limited = $true
    $accessibilityState.limitStage = 'accessibility-budget'
    $accessibilityState.diagnostic = "UI Automation accessibility-budget exceeded the internal $accessibilityDeadlineMs ms deadline."
  } else {
    $accessibilityRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $accessibilityRunspace.ApartmentState = [System.Threading.ApartmentState]::STA
    $accessibilityRunspace.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
    $accessibilityRunspace.Open()
    $accessibilityRunner = [System.Management.Automation.PowerShell]::Create()
    $accessibilityRunner.Runspace = $accessibilityRunspace
    [void]$accessibilityRunner.AddScript($accessibilityScript)
    [void]$accessibilityRunner.AddArgument($accessibilityProcessIds)
    [void]$accessibilityRunner.AddArgument([string[]]$recognizedNames)
    [void]$accessibilityRunner.AddArgument([int]$maxAccessibilityElements)
    [void]$accessibilityRunner.AddArgument($accessibilityState)
    $accessibilityAsync = $accessibilityRunner.BeginInvoke()
    $remainingAccessibilityMs = [Math]::Max(
      0,
      $accessibilityDeadlineMs - [int]$probeStopwatch.ElapsedMilliseconds
    )
    $accessibilityCompleted =
      $remainingAccessibilityMs -gt 0 -and
      $accessibilityAsync.AsyncWaitHandle.WaitOne($remainingAccessibilityMs)
    if ($accessibilityCompleted) {
      try {
        [void]$accessibilityRunner.EndInvoke($accessibilityAsync)
      } catch {
        $accessibilityState.problem = Get-BoundedAuditText $_.Exception.Message
      }
    } else {
      $accessibilityState.cancelled = $true
      $accessibilityState.limited = $true
      $stage = [string]$accessibilityState.stage
      if ([string]::IsNullOrWhiteSpace($stage)) {
        $stage = 'accessibility-budget'
      }
      $accessibilityState.limitStage = $stage
      $accessibilityState.diagnostic = "UI Automation $stage exceeded the internal $accessibilityDeadlineMs ms deadline."
      try {
        $accessibilityStop = $accessibilityRunner.BeginStop($null, $null)
        $accessibilityStopCompleted =
          $accessibilityStop.AsyncWaitHandle.WaitOne($accessibilityStopWaitMs)
        if ($accessibilityStopCompleted) {
          [void]$accessibilityRunner.EndStop($accessibilityStop)
        } else {
          $accessibilityState.diagnostic += " Stop did not complete within $accessibilityStopWaitMs ms."
        }
      } catch {
      }
    }
  }
} catch {
  $accessibilityState.problem = Get-BoundedAuditText $_.Exception.Message
} finally {
  if ($null -ne $accessibilityRunner) { $accessibilityRunner.Dispose() }
  if ($null -ne $accessibilityRunspace) { $accessibilityRunspace.Dispose() }
}
$accessibility = [pscustomobject]@{
  elementCount = [int]$accessibilityState.elementCount
  limited = [bool]$accessibilityState.limited
  limitStage = if ([string]::IsNullOrWhiteSpace([string]$accessibilityState.limitStage)) {
    $null
  } else {
    [string]$accessibilityState.limitStage
  }
  diagnostic = if ([string]::IsNullOrWhiteSpace([string]$accessibilityState.diagnostic)) {
    $null
  } else {
    Get-BoundedAuditText $accessibilityState.diagnostic
  }
  elapsedMs = [long]$probeStopwatch.ElapsedMilliseconds
  recognizedNavigation = @($accessibilityState.recognizedNavigation.Keys | Sort-Object)
  providerAvailable = [int]$accessibilityState.elementCount -gt 2
  problem = if ([string]::IsNullOrWhiteSpace([string]$accessibilityState.problem)) {
    $null
  } else {
    Get-BoundedAuditText $accessibilityState.problem
  }
}

$screenshot = $null
if ($null -ne $screenshotPath) {
  if (Test-Path -LiteralPath $screenshotPath) {
    throw "Screenshot destination already exists: $screenshotPath"
  }
  if ($null -eq $window -or $window.bounds.width -lt 1 -or $window.bounds.height -lt 1) {
    $screenshot = [pscustomobject]@{
      requested = $true
      captured = $false
      path = $screenshotPath
      width = 0
      height = 0
      sampledColorCount = 0
    }
  } elseif ($window.bounds.width -gt 16384 -or $window.bounds.height -gt 16384) {
    throw 'Installed UI window is too large for bounded screenshot capture.'
  } else {
    Add-Type -AssemblyName System.Drawing
    $bitmap = New-Object System.Drawing.Bitmap(
      $window.bounds.width,
      $window.bounds.height,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $hdc = $graphics.GetHdc()
    try {
      $captured = [ScrInstalledUiAuditNative]::PrintWindow($windowHandle, $hdc, 2)
    } finally {
      $graphics.ReleaseHdc($hdc)
      $graphics.Dispose()
    }
    $sampledColors = New-Object 'System.Collections.Generic.HashSet[int]'
    if ($captured) {
      $xStep = [Math]::Max(1, [Math]::Floor($bitmap.Width / 16))
      $yStep = [Math]::Max(1, [Math]::Floor($bitmap.Height / 16))
      for ($x = 0; $x -lt $bitmap.Width; $x += $xStep) {
        for ($y = 0; $y -lt $bitmap.Height; $y += $yStep) {
          [void]$sampledColors.Add($bitmap.GetPixel($x, $y).ToArgb())
        }
      }
      if ($sampledColors.Count -ge 4) {
        $bitmap.Save($screenshotPath, [System.Drawing.Imaging.ImageFormat]::Png)
      } else {
        $captured = $false
      }
    }
    $bitmap.Dispose()
    $screenshot = [pscustomobject]@{
      requested = $true
      captured = [bool]$captured
      path = $screenshotPath
      width = $window.bounds.width
      height = $window.bounds.height
      sampledColorCount = $sampledColors.Count
    }
  }
}

[pscustomobject]@{
  processCount = $appProcesses.Count
  process = [pscustomobject]@{
    processId = [int]$selected.ProcessId
    parentProcessId = [int]$selected.ParentProcessId
    executablePath = [IO.Path]::GetFullPath($selected.ExecutablePath)
    creationTime = ([DateTime]$selected.CreationDate).ToUniversalTime().ToString('o')
    responding = [bool]$nativeProcess.Responding
  }
  window = $window
  webView = $webView
  accessibility = $accessibility
  screenshot = $screenshot
} | ConvertTo-Json -Depth 8 -Compress
`;
}
