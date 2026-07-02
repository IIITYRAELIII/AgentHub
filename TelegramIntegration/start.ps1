$ErrorActionPreference = 'Stop'
$IntegrationRoot = $PSScriptRoot
$ProjectRoot = (Resolve-Path (Join-Path $IntegrationRoot '..\..')).Path
$env:CODEX_PROJECT_ROOT = $ProjectRoot
$env:TELEGRAM_BOT_TOKEN_FILE = Join-Path $IntegrationRoot 'TGBotToken.txt'
$env:TELEGRAM_USER_ID = '859219009'
Set-Location $ProjectRoot
node (Join-Path $PSScriptRoot 'bot.mjs')

