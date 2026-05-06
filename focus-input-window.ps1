if (-not ("WindowFocusHelper" -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WindowFocusHelper {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetConsoleWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);
}
"@
}

function Set-InputWindowFocus {
  $handles = New-Object System.Collections.Generic.List[IntPtr]

  $consoleHandle = [WindowFocusHelper]::GetConsoleWindow()
  if ($consoleHandle -ne [IntPtr]::Zero) {
    $handles.Add($consoleHandle)
  }

  try {
    $current = Get-Process -Id $PID -ErrorAction Stop
    if ($current.MainWindowHandle -and $current.MainWindowHandle -ne 0) {
      $handles.Add([IntPtr]$current.MainWindowHandle)
    }
  } catch {}

  $cursor = $PID
  for ($i = 0; $i -lt 8; $i++) {
    try {
      $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction Stop
      if (-not $procInfo.ParentProcessId) { break }
      $cursor = [int]$procInfo.ParentProcessId
      $parent = Get-Process -Id $cursor -ErrorAction Stop
      if ($parent.MainWindowHandle -and $parent.MainWindowHandle -ne 0) {
        $handles.Add([IntPtr]$parent.MainWindowHandle)
      }
    } catch {
      break
    }
  }

  foreach ($handle in ($handles | Select-Object -Unique)) {
    if ($handle -eq [IntPtr]::Zero) { continue }
    try {
      if ([WindowFocusHelper]::IsIconic($handle)) {
        [WindowFocusHelper]::ShowWindowAsync($handle, 9) | Out-Null
      }
      [WindowFocusHelper]::SetForegroundWindow($handle) | Out-Null
      Start-Sleep -Milliseconds 150
      return
    } catch {}
  }
}
