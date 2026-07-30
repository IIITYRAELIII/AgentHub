param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$agentHubRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $agentHubRoot "DesktopApp"
$executable = Join-Path $desktopRoot "dist\AgentHub.exe"

function Get-AgentHubSha256 {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)
    $stream = [IO.File]::OpenRead($LiteralPath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

if (-not $IsWindows -and $PSVersionTable.PSEdition -eq "Core") {
    throw "Agent Hub Desktop smoke requires Windows."
}

if (-not $SkipBuild) {
    $buildScript = Join-Path $desktopRoot "build.ps1"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $buildScript | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Agent Hub Desktop build failed with exit code $LASTEXITCODE."
    }
}

if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Agent Hub Desktop executable was not produced: $executable"
}

$file = Get-Item -LiteralPath $executable
if ($file.Length -lt 4096) {
    throw "Agent Hub Desktop executable is unexpectedly small: $($file.Length) bytes."
}

$header = [System.IO.File]::ReadAllBytes($executable)
if ($header.Length -lt 2 -or $header[0] -ne 0x4D -or $header[1] -ne 0x5A) {
    throw "Agent Hub Desktop output is not a valid Windows PE executable."
}

$assemblyName = [System.Reflection.AssemblyName]::GetAssemblyName($executable)
if ($assemblyName.Name -ne "AgentHub") {
    throw "Unexpected Desktop assembly name: $($assemblyName.Name)"
}

$assembly = [System.Reflection.Assembly]::LoadFile($executable)
if ($null -eq $assembly.EntryPoint) {
    throw "Agent Hub Desktop executable has no entry point."
}
if ($assembly.EntryPoint.DeclaringType.FullName -ne "AgentHubDesktop.Program") {
    throw "Unexpected Desktop entry point: $($assembly.EntryPoint.DeclaringType.FullName)"
}

$requiredTypes = @(
    "AgentHubDesktop.AgentHubWindow",
    "AgentHubDesktop.AgentHubClient",
    "AgentHubDesktop.TaskItem"
)
$availableTypes = @($assembly.GetTypes() | ForEach-Object { $_.FullName })
foreach ($requiredType in $requiredTypes) {
    if ($availableTypes -notcontains $requiredType) {
        throw "Agent Hub Desktop assembly is missing required type: $requiredType"
    }
}

$hash = Get-AgentHubSha256 -LiteralPath $executable
Write-Output "Agent Hub Desktop smoke passed: $($file.Length) bytes, sha256=$hash"
