# Idempotent deployment on Cloudflare's free tier (Windows PowerShell 5.1 compatible).
# Creates only what is missing, never deletes. Usage:
#   $env:ADMIN_TOKEN = "<random 32+ chars>"; .\scripts\deploy.ps1
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$config = "apps/worker/wrangler.jsonc"
$dbName = "pes-db"

function Step($n, $msg) { Write-Host "== $n $msg" -ForegroundColor Cyan }
function Run($cmd) { Write-Host "> $cmd" -ForegroundColor DarkGray; cmd /c $cmd; if ($LASTEXITCODE -ne 0) { throw "command failed: $cmd" } }

Step "1/7" "plan and model check (aborts on a paid plan)"
Run "node scripts/check-plan.mjs"

Step "2/7" "tests"
Run "npm run typecheck"
Run "npm run test:unit"
Run "npm run test:worker"

Step "3/7" "dashboard build"
Run "npm run build:dashboard"

Step "4/7" "D1 database"
$list = cmd /c "npx --no-install wrangler d1 list --json" | Out-String
$dbs = @()
if ($list.Trim().StartsWith("[")) { $dbs = $list | ConvertFrom-Json }
$db = $dbs | Where-Object { $_.name -eq $dbName } | Select-Object -First 1
if ($null -eq $db) {
  Write-Host "creating $dbName"
  Run "npx --no-install wrangler d1 create $dbName"
  $list = cmd /c "npx --no-install wrangler d1 list --json" | Out-String
  $db = ($list | ConvertFrom-Json) | Where-Object { $_.name -eq $dbName } | Select-Object -First 1
}
$dbId = $db.uuid
Write-Host "database_id=$dbId"
$text = Get-Content $config -Raw
$pattern = '("database_name": "' + $dbName + '",[\s\S]*?"database_id": ")[^"]*(")'
$text = [regex]::Replace($text, $pattern, ('${1}' + $dbId + '${2}'), 'None', [TimeSpan]::FromSeconds(5))
[System.IO.File]::WriteAllText((Resolve-Path $config), $text, (New-Object System.Text.UTF8Encoding($false)))

Step "5/7" "migrations (additive only)"
Run "npx --no-install wrangler d1 migrations apply $dbName --remote --config $config"

Step "6/7" "deploy worker + assets + cron"
Run "npx --no-install wrangler deploy --config $config"

if ($env:ADMIN_TOKEN) {
  Step "7/7" "admin secret"
  $env:ADMIN_TOKEN | cmd /c "npx --no-install wrangler secret put ADMIN_TOKEN --config $config"
} else {
  Step "7/7" "ADMIN_TOKEN not provided: admin routes stay disabled (503) until you run: npx wrangler secret put ADMIN_TOKEN --config $config"
}
Write-Host "done. Smoke test: `$env:BASE_URL='https://polymarket-edge-scanner.<subdomain>.workers.dev'; npm run test:prod"
