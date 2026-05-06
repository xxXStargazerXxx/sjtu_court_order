param(
  [int]$IntervalSeconds = 90,
  [string]$TimeRows = "",
  [int]$RequestDelayMs = 1500,
  [switch]$NoPopup,
  [switch]$TestPopup,
  [switch]$NoAutoLogin
)

$ErrorActionPreference = "Stop"

$root = $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\OpenAI\Codex\bin\node.exe"
}
if (-not (Test-Path $node)) {
  throw "node.exe not found. Install Node.js or update the node path in this script."
}

function Wait-EdgeDebugPort {
  param([int]$TimeoutSeconds = 30)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Edge debug port 9222 did not become ready."
}

& "$root\launch-edge-sjtu.ps1"
Wait-EdgeDebugPort

$env:MONITOR_INTERVAL_SECONDS = [string]$IntervalSeconds
$env:MONITOR_TIME_ROWS = $TimeRows
$env:MONITOR_REQUEST_DELAY_MS = [string]$RequestDelayMs
$env:MONITOR_POPUP = if ($NoPopup) { "0" } else { "1" }
$env:MONITOR_TEST_POPUP = if ($TestPopup) { "1" } else { "0" }
$env:MONITOR_AUTO_CLICK_LOGIN = if ($NoAutoLogin) { "0" } else { "1" }

Write-Host "Starting badminton monitor. This is a long-running process; press Ctrl+C to stop."
& $node "$root\cdp-sjtu-monitor-badminton.js"
if ($LASTEXITCODE -ne 0) {
  throw "Badminton monitor failed."
}
