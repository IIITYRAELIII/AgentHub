$ErrorActionPreference = 'Stop'
$RuntimeRoot = $PSScriptRoot
$Pointer = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ReleaseRoot = Join-Path (Join-Path $RuntimeRoot 'releases') $Pointer.current
$Server = Join-Path $ReleaseRoot 'agent-hub-server.mjs'
if (-not (Test-Path -LiteralPath $Server)) {
    $Server = Join-Path $ReleaseRoot 'bot.mjs'
}
if (-not (Test-Path -LiteralPath $Server)) {
    throw "Agent Hub runtime release is incomplete: $Server"
}
$env:AGENT_HUB_CONFIG = Join-Path $RuntimeRoot 'config.json'
$env:TELEGRAM_CODEX_CONFIG = Join-Path $RuntimeRoot 'config.json'
$GuiLauncher = Join-Path $RuntimeRoot 'launch.vbs'
$env:AGENT_HUB_LAUNCHER = if (Test-Path -LiteralPath $GuiLauncher) { $GuiLauncher } else { $PSCommandPath }
$env:TELEGRAM_INTEGRATION_LAUNCHER = $env:AGENT_HUB_LAUNCHER
$env:AGENT_HUB_RUNTIME_ROOT = $RuntimeRoot
$env:TELEGRAM_INTEGRATION_RUNTIME_ROOT = $RuntimeRoot
Set-Location $ReleaseRoot
& node $Server
exit $LASTEXITCODE
