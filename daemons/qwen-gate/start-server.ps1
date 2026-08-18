<#
.SYNOPSIS
  Qwen Gate — Windows watchdog server with auto-restart and crash logging.
.DESCRIPTION
  Starts the qwen-gate server, monitors it, and restarts on failure.
  Features: port pre-check, Playwright browser validation, Bun/Node auto-detect,
  stderr crash capture, clean restart loop with cooldown.
#>

$LogDir = "$env:USERPROFILE\qwen-gate"
mkdir -Force $LogDir | Out-Null
Start-Transcript -Path "$LogDir\startup.log" -Append

$ServerDir = "$env:USERPROFILE\qwen-gate\qwen-gate-latest"
$Port = 26405

# Auto-detect Bun vs Node
$UseBun = Get-Command bun -ErrorAction SilentlyContinue
if ($UseBun) {
  $NodeExe = "bun"
  $Entry = "$ServerDir\src\index.tsx"
  $RunArgs = @($Entry)
} else {
  $NodeExe = "node"
  $Entry = "$ServerDir\src\index.tsx"
  $RunArgs = @("--import", "tsx", $Entry)
}

Write-Host "[$(Get-Date)] Starting qwen-gate server using $NodeExe..."

# Kill any existing server on port
$existingProc = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -First 1
if ($existingProc -and $existingProc -ne '0') {
  Write-Host "[$(Get-Date)] Port $Port in use by PID $existingProc - killing..."
  Stop-Process -Id $existingProc -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

# Verify Playwright browsers exist
$playwrightPath = "$env:LOCALAPPDATA\ms-playwright"
if (-not (Test-Path $playwrightPath) -or (Get-ChildItem $playwrightPath -ErrorAction SilentlyContinue).Count -eq 0) {
  Write-Host "[$(Get-Date)] Playwright browsers not found - installing..."
  Set-Location $ServerDir
  npx playwright install 2>&1 | Write-Host
}

# Start server loop (restart on crash)
$env:HOST = "0.0.0.0"
while ($true) {
  # Pre-check port availability
  $portInUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($portInUse) {
    $blockingPid = $portInUse.OwningProcess
    Write-Host "[$(Get-Date)] Port $Port still in use by PID $blockingPid - killing..."
    Stop-Process -Id $blockingPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }

  Write-Host "[$(Get-Date)] Starting server..."
  $proc = Start-Process -FilePath $NodeExe -ArgumentList $RunArgs -WorkingDirectory $ServerDir -PassThru -NoNewWindow -RedirectStandardOutput "$LogDir\server-stdout.log" -RedirectStandardError "$LogDir\server-stderr.log"
  Write-Host "[$(Get-Date)] Server started (PID: $($proc.Id))"

  # Wait for server to exit
  $proc.WaitForExit()
  $exitCode = $proc.ExitCode

  # Check stderr for crash details
  $stderrContent = Get-Content "$LogDir\server-stderr.log" -ErrorAction SilentlyContinue
  if ($stderrContent) {
    Write-Host "[$(Get-Date)] Server crashed with errors:"
    $stderrContent | Select-Object -First 10 | Write-Host
  }

  Write-Host "[$(Get-Date)] Server exited with code $exitCode - restarting in 5s..."
  Start-Sleep -Seconds 5
}
