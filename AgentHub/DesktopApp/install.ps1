param(
    [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$built = & (Join-Path $root "build.ps1") | Select-Object -Last 1
$installRoot = Join-Path $env:LOCALAPPDATA "AgentHub\DesktopApp"
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
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$target = Join-Path $installRoot "AgentHub.exe"
$staged = Join-Path $installRoot "AgentHub.new.exe"
$backup = Join-Path $installRoot "AgentHub.previous.exe"

# Windows can keep the executable image locked while the desktop client is
# running. Stage the new build first, then replace the installed image only
# after every current client process has exited.
Copy-Item -LiteralPath $built -Destination $staged -Force
$running = @(
    @(Get-Process -Name "AgentHub" -ErrorAction SilentlyContinue)
)
foreach ($process in $running) {
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(5000) | Out-Null
}

if (Test-Path -LiteralPath $backup) {
    Remove-Item -LiteralPath $backup -Force
}
if (Test-Path -LiteralPath $target) {
    Move-Item -LiteralPath $target -Destination $backup -Force
}
Move-Item -LiteralPath $staged -Destination $target -Force

$builtHash = Get-AgentHubSha256 -LiteralPath $built
$installedHash = Get-AgentHubSha256 -LiteralPath $target
if ($builtHash -ne $installedHash) {
    throw "Installed AgentHub.exe does not match the built executable."
}
if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Agent Hub.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = "Agent Hub Server Windows client"
    $shortcut.Save()
}

if ($running.Count -gt 0) {
    Start-Process -FilePath $target -WorkingDirectory $installRoot
}

Write-Output $target
