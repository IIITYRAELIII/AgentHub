$ErrorActionPreference = 'Stop'
$RuntimeRoot = $PSScriptRoot
$Pointer = Get-Content -LiteralPath (Join-Path $RuntimeRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ReleaseRoot = Join-Path (Join-Path $RuntimeRoot 'releases') $Pointer.current
$ReleaseRoot = [IO.Path]::GetFullPath($ReleaseRoot)
$ManifestPath = Join-Path $ReleaseRoot 'runtime-manifest.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Agent Hub runtime manifest is missing: $ManifestPath"
}
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Manifest.releaseId -ne $Pointer.current) {
    throw "Agent Hub runtime manifest does not match current.json"
}
function Get-AgentHubSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $Stream = [IO.File]::OpenRead($LiteralPath)
    $Hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $Hasher.Dispose()
        $Stream.Dispose()
    }
}
$ReleasePrefix = $ReleaseRoot.TrimEnd('\') + '\'
foreach ($Entry in $Manifest.files) {
    $Relative = [string]$Entry.path
    if ([IO.Path]::IsPathRooted($Relative)) {
        throw "Agent Hub runtime manifest contains an absolute path: $Relative"
    }
    $Target = [IO.Path]::GetFullPath((Join-Path $ReleaseRoot ($Relative -replace '/', '\')))
    if (-not $Target.StartsWith($ReleasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Agent Hub runtime manifest escapes its release: $Relative"
    }
    if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) {
        throw "Agent Hub runtime file is missing: $Relative"
    }
    $Info = Get-Item -LiteralPath $Target
    if ($Info.Length -ne [int64]$Entry.bytes) {
        throw "Agent Hub runtime file size mismatch: $Relative"
    }
    $Hash = Get-AgentHubSha256 -LiteralPath $Target
    if ($Hash -ne ([string]$Entry.sha256).ToLowerInvariant()) {
        throw "Agent Hub runtime file hash mismatch: $Relative"
    }
}
$Server = Join-Path $ReleaseRoot 'agent-hub-server.mjs'
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
