[CmdletBinding()]
param(
  [string]$HubOrigin = "",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$installRoot = Join-Path $env:LOCALAPPDATA "AgentHub\FileBridge"
$bridgeFile = Join-Path $installRoot "bridge.ps1"
$configFile = Join-Path $installRoot "config.json"
$protocolKey = "HKCU:\Software\Classes\agenthub-file"

if ($Uninstall) {
  if (Test-Path -LiteralPath $protocolKey) {
    Remove-Item -LiteralPath $protocolKey -Recurse -Force
  }
  if (Test-Path -LiteralPath $installRoot) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
  }
  Write-Host "Agent Hub File Bridge удалён."
  exit 0
}

if ([string]::IsNullOrWhiteSpace($HubOrigin)) {
  $HubOrigin = Read-Host "HTTPS-адрес Agent Hub, например https://hub.example.com"
}
$originUri = [Uri]$HubOrigin
if ($originUri.Scheme -ne "https" -or [string]::IsNullOrWhiteSpace($originUri.Host)) {
  throw "File Bridge принимает только HTTPS-адрес Agent Hub."
}
$normalizedOrigin = $originUri.GetLeftPart([System.UriPartial]::Authority).TrimEnd("/")

$bridgeScript = @'
param([Parameter(Mandatory = $true, Position = 0)][string]$RequestUri)

$ErrorActionPreference = "Stop"
$installRoot = Join-Path $env:LOCALAPPDATA "AgentHub\FileBridge"
$config = Get-Content -LiteralPath (Join-Path $installRoot "config.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$launchUri = [Uri]$RequestUri
if ($launchUri.Scheme -ne "agenthub-file") {
  throw "Некорректная схема File Bridge."
}
$action = $launchUri.Host.ToLowerInvariant()
if ($action -notin @("copy", "reveal")) {
  throw "Неизвестное действие File Bridge."
}

Add-Type -AssemblyName System.Web
$query = [System.Web.HttpUtility]::ParseQueryString($launchUri.Query)
$sourceUri = [Uri]$query.Get("source")
$name = [IO.Path]::GetFileName([string]$query.Get("name"))
$configuredOrigin = ([Uri][string]$config.hubOrigin).GetLeftPart([System.UriPartial]::Authority).TrimEnd("/")
$sourceOrigin = $sourceUri.GetLeftPart([System.UriPartial]::Authority).TrimEnd("/")
if ($sourceUri.Scheme -ne "https" -or $sourceOrigin -cne $configuredOrigin) {
  throw "Источник файла не совпадает с закреплённым Agent Hub."
}
if ($sourceUri.AbsolutePath -notmatch "^/api/workspace-file/transfer/[A-Za-z0-9_-]{43}$") {
  throw "Некорректный одноразовый билет File Bridge."
}
if ([string]::IsNullOrWhiteSpace($name)) {
  throw "Имя файла отсутствует."
}

$cacheRoot = Join-Path $env:LOCALAPPDATA "AgentHub\FileClipboardCache"
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) } |
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
$retained = @(Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTimeUtc -Descending)
if ($retained.Count -gt 7) {
  $retained | Select-Object -Skip 7 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
$ticket = [IO.Path]::GetFileName($sourceUri.AbsolutePath)
$ticketRoot = Join-Path $cacheRoot $ticket
New-Item -ItemType Directory -Path $ticketRoot -Force | Out-Null
$target = Join-Path $ticketRoot $name
$partial = "$target.part"
Invoke-WebRequest -UseBasicParsing -Uri $sourceUri.AbsoluteUri -OutFile $partial -MaximumRedirection 0
Move-Item -LiteralPath $partial -Destination $target -Force

if ($action -eq "copy") {
  Add-Type -AssemblyName System.Windows.Forms
  $files = New-Object System.Collections.Specialized.StringCollection
  [void]$files.Add($target)
  $lastError = $null
  foreach ($attempt in 1..5) {
    try {
      [System.Windows.Forms.Clipboard]::SetFileDropList($files)
      $lastError = $null
      break
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 100
    }
  }
  if ($null -ne $lastError) {
    throw $lastError
  }
} else {
  $process = New-Object System.Diagnostics.ProcessStartInfo
  $process.FileName = "explorer.exe"
  $process.Arguments = "/select,`"$target`""
  $process.UseShellExecute = $false
  [void][System.Diagnostics.Process]::Start($process)
}
'@

New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
Set-Content -LiteralPath $bridgeFile -Value $bridgeScript -Encoding UTF8
@{ version = 1; hubOrigin = $normalizedOrigin } |
  ConvertTo-Json -Compress |
  Set-Content -LiteralPath $configFile -Encoding UTF8

New-Item -Path $protocolKey -Force | Out-Null
Set-Item -LiteralPath $protocolKey -Value "URL:Agent Hub File Bridge"
New-ItemProperty -LiteralPath $protocolKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
$commandKey = Join-Path $protocolKey "shell\open\command"
New-Item -Path $commandKey -Force | Out-Null
$powershell = Join-Path $PSHOME "powershell.exe"
$command = "`"$powershell`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -STA -File `"$bridgeFile`" `"%1`""
Set-Item -LiteralPath $commandKey -Value $command

Write-Host "Agent Hub File Bridge установлен для $normalizedOrigin."
Write-Host "Удаление: powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
