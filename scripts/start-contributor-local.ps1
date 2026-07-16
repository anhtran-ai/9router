param(
  [int]$Port = 21128,
  [string]$InitialPassword = "contributor-local-test"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$env:DATA_DIR = Join-Path $repo "runtime-data"
$env:INITIAL_PASSWORD = $InitialPassword
$env:AUTH_COOKIE_SECURE = "false"

New-Item -ItemType Directory -Force -Path $env:DATA_DIR | Out-Null

$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "9Router Contributor is already listening at http://127.0.0.1:$Port"
  exit 0
}

$process = Start-Process `
  -FilePath "node.exe" `
  -ArgumentList @("node_modules/next/dist/bin/next", "start", "-p", $Port, "-H", "127.0.0.1") `
  -WorkingDirectory $repo `
  -WindowStyle Hidden `
  -PassThru

Write-Host "Starting 9Router Contributor (launcher PID $($process.Id))..."
Write-Host "Admin: http://127.0.0.1:$Port/dashboard/contributors"
Write-Host "Password: $InitialPassword"
