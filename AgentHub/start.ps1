$ErrorActionPreference = 'Stop'
$IntegrationRoot = $PSScriptRoot
$RuntimeLauncher = Join-Path $env:LOCALAPPDATA 'Tyrael\TelegramIntegration\launch.ps1'
$RuntimeActive = Join-Path $env:LOCALAPPDATA 'Tyrael\TelegramIntegration\active.json'
if ((Test-Path -LiteralPath $RuntimeLauncher) -and (Test-Path -LiteralPath $RuntimeActive)) {
    & $RuntimeLauncher
    exit $LASTEXITCODE
}
Set-Location $IntegrationRoot
node (Join-Path $PSScriptRoot 'agent-hub-server.mjs')
