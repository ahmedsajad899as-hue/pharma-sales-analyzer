# =================================================================
#  auto-deploy.ps1 - Auto Git push loop for pharma-sales-analyzer
#  Runs as a background process at every Windows logon (Startup).
#  Every 5 minutes: if there are uncommitted changes -> commit & push.
# =================================================================

$projectPath = "d:\my code\marketing\pharma-sales-analyzer"
$logFile     = "$projectPath\auto-deploy.log"
$lockFile    = "$projectPath\auto-deploy.lock"
$maxLogKB    = 512   # rotate log when it exceeds 512 KB

# Single-instance guard: exit if another instance is already running
if (Test-Path $lockFile) {
    $existingPid = Get-Content $lockFile -ErrorAction SilentlyContinue
    if ($existingPid -and (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)) {
        exit 0  # Another instance is alive, quit this one
    }
}
# Write our PID to lock file
$PID | Set-Content $lockFile

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt ($maxLogKB * 1024))) {
            Move-Item $logFile "$logFile.bak" -Force
        }
        Add-Content -Path $logFile -Value $line -Encoding ASCII
    } catch {}
}

# Cleanup lock on exit
Register-EngineEvent PowerShell.Exiting -Action { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } | Out-Null

Log "=== Auto-deploy watcher started (PID: $PID, interval: 5 min) ==="

while ($true) {
    try {
        $status = & git -C $projectPath status --porcelain 2>&1
        if ($status -and ($status | Where-Object { $_.Trim() -ne '' })) {
            Log "Changes detected - committing..."
            & git -C $projectPath add -A 2>&1 | Out-Null
            $commitMsg = "auto: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
            & git -C $projectPath commit -m $commitMsg 2>&1 | Out-Null
            $pushResult = & git -C $projectPath push origin main 2>&1
            $exitCode   = $LASTEXITCODE
            if ($exitCode -eq 0) {
                Log "OK - pushed: $commitMsg"
            } else {
                Log "PUSH FAILED (exit $exitCode): $pushResult"
            }
        }
    } catch {
        Log "ERROR: $_"
    }

    Start-Sleep -Seconds 300  # wait 5 minutes
}
