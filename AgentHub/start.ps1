$ErrorActionPreference = 'Stop'
$AgentHubRoot = $PSScriptRoot
$RuntimeRoot = if ([string]::IsNullOrWhiteSpace($env:AGENT_HUB_RUNTIME_ROOT)) {
    Join-Path $env:LOCALAPPDATA 'AgentHub'
} else {
    if (-not [IO.Path]::IsPathRooted($env:AGENT_HUB_RUNTIME_ROOT)) {
        throw 'AGENT_HUB_RUNTIME_ROOT must be absolute'
    }
    [IO.Path]::GetFullPath($env:AGENT_HUB_RUNTIME_ROOT)
}
$RuntimeLauncher = Join-Path $RuntimeRoot 'AgentHub.RuntimeHost.exe'
$RuntimeActive = Join-Path $RuntimeRoot 'active.json'
if ((Test-Path -LiteralPath $RuntimeLauncher) -and (Test-Path -LiteralPath $RuntimeActive)) {
    & $RuntimeLauncher
    exit $LASTEXITCODE
}
Set-Location $AgentHubRoot
node (Join-Path $PSScriptRoot 'agent-hub-main.mjs')
