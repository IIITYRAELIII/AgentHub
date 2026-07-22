param(
    [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$built = & (Join-Path $root "build.ps1") | Select-Object -Last 1
$installRoot = Join-Path $env:LOCALAPPDATA "Tyrael\TelegramIntegration\DesktopApp"
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
$target = Join-Path $installRoot "TyraelIntegration.exe"
Copy-Item -LiteralPath $built -Destination $target -Force

if (-not $NoShortcut) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Tyrael Integration.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $target
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.Description = "Tyrael Integration Server Windows client"
    $shortcut.Save()
}

Write-Output $target
