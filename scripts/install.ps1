#Requires -Version 5.1
$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js 18+ is required. Install Node from https://nodejs.org/ and rerun this script."
    exit 1
}

$nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 18) {
    Write-Error "Node.js 18+ is required."
    exit 1
}

$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) { $npm = Get-Command npm -ErrorAction Stop }

Push-Location $Root
try {
    & $npm.Source install
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $npm.Source run build:gui
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $npm.Source install -g .
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

$ocx = Get-Command ocx.cmd -ErrorAction SilentlyContinue
if (-not $ocx) { $ocx = Get-Command ocx -ErrorAction SilentlyContinue }
if (-not $ocx) {
    Write-Error "The package was installed, but 'ocx' is unavailable. Check your npm global PATH."
    exit 1
}

& $ocx.Source help *> $null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Installed cline-codex-app-proxy from $Root" -ForegroundColor Green
Write-Host "Next: ocx cline setup"
