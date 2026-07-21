$ErrorActionPreference = 'Stop'
$RuntimeRoot = $PSScriptRoot
$Pointer = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ReleaseRoot = Join-Path (Join-Path $RuntimeRoot 'releases') $Pointer.current
$Bot = Join-Path $ReleaseRoot 'bot.mjs'
if (-not (Test-Path -LiteralPath $Bot)) {
    throw "TelegramIntegration runtime release is incomplete: $Bot"
}
$env:TELEGRAM_CODEX_CONFIG = Join-Path $RuntimeRoot 'config.json'
$env:TELEGRAM_INTEGRATION_LAUNCHER = $PSCommandPath
$env:TELEGRAM_INTEGRATION_RUNTIME_ROOT = $RuntimeRoot
Set-Location $ReleaseRoot
& node $Bot
exit $LASTEXITCODE
