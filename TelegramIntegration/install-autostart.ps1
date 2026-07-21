$ErrorActionPreference = 'Stop'

$RuntimeRoot = Join-Path $env:LOCALAPPDATA 'Tyrael\TelegramIntegration'
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

$BotShortcut = $Shell.CreateShortcut((Join-Path $Startup 'Codex Telegram Bot.lnk'))
if (Test-Path -LiteralPath $RuntimeGuiLauncher) {
    $BotShortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $BotShortcut.Arguments = "//B //Nologo `"$RuntimeGuiLauncher`""
} else {
    $BotShortcut.TargetPath = (Get-Command powershell.exe).Source
    $BotShortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$BotEntryPoint`""
}
$BotShortcut.WorkingDirectory = Split-Path -Parent $BotEntryPoint
$BotShortcut.WindowStyle = 7
$BotShortcut.Description = 'Telegram bridge for local Codex'
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
if (-not $CodeExe) {
    throw 'VS Code executable was not found.'
}

$CodeShortcut = $Shell.CreateShortcut((Join-Path $Startup 'VSC_Tyrael - VS Code.lnk'))
$CodeShortcut.TargetPath = $CodeExe
$CodeShortcut.Arguments = "`"$ProjectRoot`""
$CodeShortcut.WorkingDirectory = $ProjectRoot
$CodeShortcut.WindowStyle = 1
$CodeShortcut.Description = 'Open VSC_Tyrael in Visual Studio Code'
$CodeShortcut.Save()

Write-Output "Created: $(Join-Path $Startup 'Codex Telegram Bot.lnk')"
Write-Output "Created: $(Join-Path $Startup 'VSC_Tyrael - VS Code.lnk')"
