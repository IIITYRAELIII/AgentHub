$ErrorActionPreference = 'Stop'

$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'AgentHub'
$RuntimeConfig = Join-Path $RuntimeRoot 'config.json'
if (Test-Path -LiteralPath $RuntimeConfig) {
    $ProjectRoot = (Get-Content -LiteralPath $RuntimeConfig -Raw -Encoding UTF8 | ConvertFrom-Json).projectRoot
} else {
    $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
$Startup = [Environment]::GetFolderPath('Startup')
$Shell = New-Object -ComObject WScript.Shell
$RuntimeLauncher = Join-Path $RuntimeRoot 'launch.ps1'
$RuntimeGuiLauncher = Join-Path $RuntimeRoot 'launch.vbs'
$BotEntryPoint = if (Test-Path -LiteralPath $RuntimeLauncher) {
    $RuntimeLauncher
} else {
    Join-Path $PSScriptRoot 'start.ps1'
}

$BotShortcutPath = Join-Path $Startup 'Agent Hub.lnk'
$BotShortcut = $Shell.CreateShortcut($BotShortcutPath)
if (Test-Path -LiteralPath $RuntimeGuiLauncher) {
    $BotShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $BotShortcut.Arguments = "//B //Nologo `"$RuntimeGuiLauncher`""
} else {
    $BotShortcut.TargetPath = (Get-Command powershell.exe).Source
    $BotShortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$BotEntryPoint`""
}
$BotShortcut.WorkingDirectory = Split-Path -Parent $BotEntryPoint
$BotShortcut.WindowStyle = 7
$BotShortcut.Description = 'Agent Hub runtime'
$BotShortcut.Save()

$CodeCandidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe')
)
$CodeExe = $CodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $CodeExe) {
    $CodeCommand = Get-Command code.exe -ErrorAction SilentlyContinue
    if ($CodeCommand) { $CodeExe = $CodeCommand.Source }
}
if ($CodeExe) {
    $WorkspaceFile = Get-ChildItem -LiteralPath $ProjectRoot -Filter '*.code-workspace' -File |
        Select-Object -First 1
    if ($WorkspaceFile) {
        $CodeShortcutPath = Join-Path $Startup "$($WorkspaceFile.BaseName) - VS Code.lnk"
        $CodeShortcut = $Shell.CreateShortcut($CodeShortcutPath)
        $CodeShortcut.TargetPath = $CodeExe
        $CodeShortcut.Arguments = "`"$($WorkspaceFile.FullName)`""
        $CodeShortcut.WorkingDirectory = $ProjectRoot
        $CodeShortcut.WindowStyle = 1
        $CodeShortcut.Description = "Open $($WorkspaceFile.BaseName) in Visual Studio Code"
        $CodeShortcut.Save()
        Write-Output "Created: $CodeShortcutPath"
    }
} else {
    Write-Warning 'VS Code executable was not found; the workspace shortcut was skipped.'
}

Write-Output "Created: $BotShortcutPath"
