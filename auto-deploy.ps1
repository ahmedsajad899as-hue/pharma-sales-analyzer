# ═══════════════════════════════════════════════════════════════
#  auto-deploy.ps1  —  Auto Git push loop for pharma-sales-analyzer
#  Runs as a background Windows Scheduled Task at every logon.
#  Every 5 minutes: if there are uncommitted changes → commit & push.
# ═══════════════════════════════════════════════════════════════

$projectPath = "d:\my code\marketing\pharma-sales-analyzer"
$logFile     = "$projectPath\auto-deploy.log"
$maxLogKB    = 512   # rotate log when it exceeds 512 KB

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    Write-Host $line
    try {
        # Rotate log if too large
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt ($maxLogKB * 1024))) {
            Move-Item $logFile "$logFile.bak" -Force
        }
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { <# ignore log write errors #> }
}

Log "=== Auto-deploy watcher started (interval: 5 min) ==="

while ($true) {
    try {
        # Check for any uncommitted changes (untracked + modified + staged)
        $status = & git -C $projectPath status --porcelain 2>&1
        if ($status -and ($status | Where-Object { $_.Trim() -ne '' })) {
            Log "Changes detected — committing..."
            & git -C $projectPath add -A 2>&1 | ForEach-Object { Log "  add: $_" }
            $commitMsg = "auto: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
            $commitOut = & git -C $projectPath commit -m $commitMsg 2>&1
            $commitOut | ForEach-Object { Log "  commit: $_" }
            $pushOut = & git -C $projectPath push origin main 2>&1
            $pushOut | ForEach-Object { Log "  push: $_" }
            Log "Done — pushed: $commitMsg"
        }
    } catch {
        Log "ERROR: $_"
    }

    # Wait 5 minutes before next check
    Start-Sleep -Seconds 300
}
