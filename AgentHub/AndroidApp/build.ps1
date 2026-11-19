[CmdletBinding()]
param(
    [string]$HubUrl = $env:AGENT_HUB_PUBLIC_URL,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [long]$VersionCode = 0,
    [string]$VersionName = '',
    [string]$ArtifactVersion = ''
)
$ErrorActionPreference = 'Stop'
$buildArguments = @()
foreach ($entry in $PSBoundParameters.GetEnumerator()) {
    $buildArguments += @('-' + $entry.Key, [string]$entry.Value)
}
& node (Join-Path (Split-Path -Parent $PSScriptRoot) 'android-build.mjs') @buildArguments
if ($LASTEXITCODE -ne 0) { throw 'External Android build failed.' }
