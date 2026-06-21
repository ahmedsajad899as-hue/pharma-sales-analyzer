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
$key    = "C:\Users\Marhaba\.ssh\vultr_pharma"
$server = "root@199.247.0.207"
$dir    = "/var/www/pharma-sales-analyzer"
$proc   = "pharma-sales"
Set-Location "D:\my code\marketing\pharma-sales-analyzer"

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

# 3) transfer code + dist
Step "3/5 scp -> $server"
scp -i $key -r server prisma package.json package-lock.json "${server}:${dir}/"
if ($LASTEXITCODE -ne 0) { throw "code transfer failed" }
scp -i $key -r dist/* "${server}:${dir}/dist/"
if ($LASTEXITCODE -ne 0) { throw "dist transfer failed" }

# 4) optional deps / schema on server
$remote = "cd $dir"
if ($Install) { $remote = "$remote; npm install --omit=dev" }
if ($Schema)  { $remote = "$remote; npx prisma generate --schema prisma/schema.postgresql.prisma; npx prisma db push --schema prisma/schema.postgresql.prisma --accept-data-loss" }
if ($Install -or $Schema) {
  Step "4/5 server install/schema"
  ssh -i $key $server $remote
  if ($LASTEXITCODE -ne 0) { throw "server install/schema failed" }
} else { Write-Host "4/5 skip install/schema (no flags)" }

# 5) restart + health
Step "5/5 pm2 restart + health"
ssh -i $key $server "pm2 restart $proc --update-env; sleep 2; pm2 describe $proc | grep -E 'status|restarts' | head -2"
if ($LASTEXITCODE -ne 0) { throw "pm2 restart failed" }

Write-Host "`nDEPLOY OK - production updated" -ForegroundColor Green
