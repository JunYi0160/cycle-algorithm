# Cycle Algorithm Local Helper Launcher
$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  Cycle Algorithm Local Helper (Antigravity Bridge)" -ForegroundColor Cyan
Write-Host "===================================================" -ForegroundColor Cyan

$env:ELECTRON_RUN_AS_NODE = "1"
$env:PATH = "$env:APPDATA\Antigravity\bin;$env:LOCALAPPDATA\agy\bin;" + $env:PATH

# Check if port 8789 is available
$conn = Test-NetConnection -ComputerName 127.0.0.1 -Port 8789 -InformationLevel Quiet -WarningAction SilentlyContinue
if ($conn) {
    Write-Host "Notice: Port 8789 is already in use. Opening existing instance..." -ForegroundColor Yellow
    Start-Process "http://127.0.0.1:8789/cycle-algorithm/"
    exit 0
}

# Run build
node scripts/build.mjs

Write-Host "Starting helper at http://127.0.0.1:8789/cycle-algorithm/ ..." -ForegroundColor Green
node scripts/helper.mjs
