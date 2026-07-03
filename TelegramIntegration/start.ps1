$ErrorActionPreference = 'Stop'
$IntegrationRoot = $PSScriptRoot
Set-Location $IntegrationRoot
node (Join-Path $PSScriptRoot 'bot.mjs')
