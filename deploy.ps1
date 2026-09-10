# deploy.ps1 - one-step production deploy for pharma-sales-analyzer (Vultr).
#
# Workflow (see memory project_pharma_auto_deploy):
#   1) git add/commit/push to GitHub (source of truth).
#   2) build frontend locally (server is low-RAM, never builds there).
#   3) transfer code + dist/ to the server via scp.
#   4) (optional) npm install / prisma generate when deps/schema changed.
#   5) restart PM2 + quick health check.
#
# Usage:
#   ./deploy.ps1 "commit message"        # normal deploy (code + frontend)
#   ./deploy.ps1 "msg" -Install          # when package.json/deps changed
#   ./deploy.ps1 "msg" -Schema           # when prisma schema changed (generate + db push)
#   ./deploy.ps1 "msg" -SkipPush         # skip GitHub push (rare)

param(
  [string]$Message = "chore: deploy $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
  [switch]$Install,
  [switch]$Schema,
  [switch]$SkipPush
)

# NOTE: do NOT set ErrorActionPreference=Stop here. In Windows PowerShell 5.1 that
# turns harmless native-tool stderr (e.g. git's "LF will be replaced by CRLF") into a
# fatal error. We check $LASTEXITCODE explicitly after each native command instead.
$key    = "$env:USERPROFILE\.ssh\vultr_pharma"
$server = "root@199.247.0.207"
$dir    = "/var/www/pharma-sales-analyzer"
$proc   = "pharma-sales"
Set-Location $PSScriptRoot

function Step($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# 1) GitHub
if (-not $SkipPush) {
  Step "1/5 git push"
  git add -A
  $pending = git status --short
  if ($pending) { git commit -m $Message } else { Write-Host "no changes to commit" }
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push failed" }
} else { Write-Host "skip git push (-SkipPush)" }

# 2) build
Step "2/5 npm run build"
npm run build
if ($LASTEXITCODE -ne 0) { throw "build failed - deploy aborted" }
# Drop source maps — never shipped. They bloat dist and (with content-hashed
# names) would otherwise pile up on the server every deploy until the disk fills.
Get-ChildItem dist -Recurse -Filter *.map -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

# The box sits under constant SSH brute-force load (1300+ failed logins/hour from
# ~390 IPs). sshd's MaxStartups then refuses a share of NEW connections at random
# — "kex_exchange_identification: Connection reset". A single dropped hop used to
# abort the deploy, or worse land HALF of it: new server/*.js next to an old
# package.json, which took production down with ERR_MODULE_NOT_FOUND on a package
# the new code imports. So every hop retries, and every hop is checked.
$sshOpts = @('-o','ConnectTimeout=20','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=6','-o','ConnectionAttempts=3')

function Invoke-Retry([string]$what, [scriptblock]$action, [int]$tries = 4) {
  for ($i = 1; $i -le $tries; $i++) {
    & $action
    if ($LASTEXITCODE -eq 0) { return }
    if ($i -lt $tries) {
      Write-Host "  $what failed (try $i/$tries) - retrying in 6s..." -ForegroundColor Yellow
      Start-Sleep -Seconds 6
    }
  }
  throw "$what failed after $tries attempts"
}

# 3) transfer code + dist
Step "3/5 scp -> $server"
Invoke-Retry "code transfer" { scp -i $key @sshOpts -r server prisma package.json package-lock.json "${server}:${dir}/" }
# Clear stale hashed chunks first so old builds don't accumulate — each build
# emits new content-hash filenames, so without this dist/assets grows unbounded
# (it had reached 3110 files / 1.8 GB, which stalled scp and filled the disk).
# NOTE: this hop was previously unchecked — it failed silently and the deploy
# carried on to print "DEPLOY OK" over a half-transferred tree.
Invoke-Retry "stale-asset cleanup" { ssh -i $key @sshOpts $server "cd ${dir}/dist && find assets -type f -delete 2>/dev/null; mkdir -p assets" }
Invoke-Retry "dist transfer" { scp -i $key @sshOpts -r dist/* "${server}:${dir}/dist/" }

# 4) optional deps / schema on server
$remote = "cd $dir"
if ($Install) { $remote = "$remote; npm install --omit=dev" }
if ($Schema)  { $remote = "$remote; npx prisma generate --schema prisma/schema.postgresql.prisma; npx prisma db push --schema prisma/schema.postgresql.prisma --accept-data-loss" }
if ($Install -or $Schema) {
  Step "4/5 server install/schema"
  Invoke-Retry "server install/schema" { ssh -i $key @sshOpts $server $remote }
} else { Write-Host "4/5 skip install/schema (no flags)" }

# 5) restart + health
Step "5/5 pm2 restart + health"
Invoke-Retry "pm2 restart" { ssh -i $key @sshOpts $server "pm2 restart $proc --update-env; sleep 2; pm2 describe $proc | grep -E 'status|restarts' | head -2" }

# A real request, not just "pm2 says online". pm2 reports a process that died on
# an import error as online for a while; only an actual 200 proves the new code
# booted. Without this the script happily printed "DEPLOY OK" over a dead app.
Write-Host "health check..." -NoNewline
$code = ""
for ($i = 1; $i -le 6; $i++) {
  Start-Sleep -Seconds 5
  $code = (ssh -i $key @sshOpts $server "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/health") -join ""
  if ($code -match "200") { break }
  Write-Host "." -NoNewline
}
if ($code -notmatch "200") {
  ssh -i $key @sshOpts $server "tail -n 20 /root/.pm2/logs/$proc-error.log"
  throw "app did NOT come back up (health=$code) - see the error log above"
}
Write-Host " 200 OK"

Write-Host "`nDEPLOY OK - production updated" -ForegroundColor Green
