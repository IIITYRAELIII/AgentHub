$ErrorActionPreference = 'Stop'
$AgentHubRoot = $PSScriptRoot
$RuntimeLauncher = Join-Path $env:LOCALAPPDATA 'AgentHub\launch.ps1'
$RuntimeActive = Join-Path $env:LOCALAPPDATA 'AgentHub\active.json'
if ((Test-Path -LiteralPath $RuntimeLauncher) -and (Test-Path -LiteralPath $RuntimeActive)) {
    & $RuntimeLauncher
    exit $LASTEXITCODE
}
Set-Location $AgentHubRoot
node (Join-Path $PSScriptRoot 'agent-hub-server.mjs')
