param(
  [int]$LeadMinutes = 5
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
. "$root\focus-input-window.ps1"
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

function Run-NodeStep {
  param([string]$ScriptPath)

  $name = Split-Path $ScriptPath -Leaf
  $started = Get-Date
  Write-Host "[$($started.ToString('HH:mm:ss.fff'))] Starting $name ..."
  & $node $ScriptPath
  if ($LASTEXITCODE -ne 0) {
    throw "Node step failed: $ScriptPath"
  }
  $elapsed = [int]((Get-Date) - $started).TotalMilliseconds
  Write-Host "[$((Get-Date).ToString('HH:mm:ss.fff'))] Finished $name in ${elapsed}ms."
}

function Wait-Until {
  param(
    [datetime]$Target,
    [string]$Message
  )

  while ($true) {
    $remaining = [int][Math]::Ceiling(($Target - (Get-Date)).TotalSeconds)
    if ($remaining -le 0) {
      return
    }

    Write-Host "$Message Waiting $remaining seconds until $Target."
    Start-Sleep -Seconds ([Math]::Min($remaining, 30))
  }
}

$now = Get-Date
$noon = Get-Date -Hour 12 -Minute 0 -Second 0
if ($now -ge $noon) {
  Write-Host "It is already after noon; running immediately."
} else {
  $launchAt = $noon.AddMinutes(-1 * $LeadMinutes)
  Wait-Until -Target $launchAt -Message "Waiting before opening Edge."
}

Write-Host "Opening Edge. Complete SJTU login/captcha if prompted."
& "$root\launch-edge-sjtu.ps1"
Wait-EdgeDebugPort

if ((Get-Date) -lt $noon) {
  Wait-Until -Target $noon -Message "Edge is ready; waiting for noon booking time."
}

$env:TARGET_VENUE_ID = "9096787a-bc53-430a-9405-57dc46bc9e83"
$env:TARGET_DATE = ""
$env:TARGET_DATE_MODE = "last"
$env:TARGET_TYPE_CODE = "gym"
$env:TARGET_TYPE = "健身房"
$env:TIME_ROWS = "13,14"
$env:TARGET_FIELD = ""
$env:FORCE_REFRESH = "1"
$env:RELOAD_PAGE_BEFORE_PREPARE = "1"
$env:PAGE_RELOAD_WAIT_MS = "3500"
$env:RETRY_SECONDS = "25"
$env:RETRY_INTERVAL_MS = "600"
$env:POST_REFRESH_WAIT_MS = "400"

Run-NodeStep "$root\cdp-sjtu-prepare.js"
Run-NodeStep "$root\cdp-sjtu-open-order-dialog.js"

Set-InputWindowFocus
$answer = Read-Host "Final submit? Type 1 and press Enter to submit the order; anything else leaves it open"
if ($answer -eq "1") {
  Run-NodeStep "$root\cdp-sjtu-submit-debug.js"
} else {
  Write-Host "Skipped final submit. The order dialog remains open in Edge."
}

