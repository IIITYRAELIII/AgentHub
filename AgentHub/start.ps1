$ErrorActionPreference = 'Stop'
$AgentHubRoot = $PSScriptRoot
$RuntimeLauncher = Join-Path $env:LOCALAPPDATA 'AgentHub\AgentHub.RuntimeHost.exe'
$RuntimeActive = Join-Path $env:LOCALAPPDATA 'AgentHub\active.json'
if ((Test-Path -LiteralPath $RuntimeLauncher) -and (Test-Path -LiteralPath $RuntimeActive)) {
    & $RuntimeLauncher
    exit $LASTEXITCODE
}
Set-Location $AgentHubRoot
node (Join-Path $PSScriptRoot 'agent-hub-main.mjs')
