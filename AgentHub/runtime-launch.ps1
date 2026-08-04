$ErrorActionPreference = 'Stop'
$RuntimeRoot = $PSScriptRoot
$Pointer = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Current = [string]$Pointer.current
if ($Current -in @('.', '..') -or $Current -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
    throw 'Agent Hub has no valid current runtime release'
}
$ReleasesRoot = [IO.Path]::GetFullPath((Join-Path $RuntimeRoot 'releases'))
$ReleasesDirectory = Get-Item -LiteralPath $ReleasesRoot -Force
if (($ReleasesDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Agent Hub releases directory must not be a reparse point'
}
$ReleaseRoot = [IO.Path]::GetFullPath((Join-Path $ReleasesRoot $Current))
if (-not (Test-Path -LiteralPath $ReleaseRoot -PathType Container)) {
    throw "Agent Hub runtime release is incomplete: $ReleaseRoot"
}
$ReleaseDirectory = Get-Item -LiteralPath $ReleaseRoot -Force
if (($ReleaseDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Agent Hub runtime release must not be a reparse point'
}
$ReleasePrefix = $ReleasesRoot.TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)) + [IO.Path]::DirectorySeparatorChar
if (-not $ReleaseRoot.StartsWith($ReleasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Agent Hub runtime release resolves outside releases'
}
& node (Join-Path $ReleaseRoot 'runtime-manifest-verifier.mjs') $ReleaseRoot $Current
if ($LASTEXITCODE -ne 0) { throw 'Agent Hub runtime manifest verification failed' }
$Server = Join-Path $ReleaseRoot 'agent-hub-main.mjs'
if (-not (Test-Path -LiteralPath $Server)) {
    throw "Agent Hub runtime release is incomplete: $Server"
}
$env:AGENT_HUB_CONFIG = Join-Path $RuntimeRoot 'config.json'
$GuiLauncher = Join-Path $RuntimeRoot 'launch.vbs'
$env:AGENT_HUB_LAUNCHER = if (Test-Path -LiteralPath $GuiLauncher) { $GuiLauncher } else { $PSCommandPath }
$env:AGENT_HUB_RUNTIME_ROOT = $RuntimeRoot
Set-Location $ReleaseRoot
& node $Server
exit $LASTEXITCODE
