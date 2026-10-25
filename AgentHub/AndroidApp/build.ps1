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
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$mobileAssets = Join-Path (Split-Path -Parent $root) 'assets\mobile'
$publishedManifest = Join-Path $mobileAssets 'update.json'
$buildTime = [DateTimeOffset]::UtcNow
if ($ArtifactVersion) {
    $versionJson = & node (Join-Path (Split-Path -Parent $root) 'release-version.mjs') --android-artifact $ArtifactVersion
    if ($LASTEXITCODE -ne 0) { throw 'Invalid frozen Android artifact version.' }
    $frozen = $versionJson | ConvertFrom-Json
    if (($VersionCode -gt 0 -and $VersionCode -ne $frozen.versionCode) -or
        ($VersionName -and $VersionName -ne $frozen.versionName)) {
        throw 'Explicit Android version differs from frozen artifact.'
    }
    $VersionCode = [long]$frozen.versionCode
    $VersionName = [string]$frozen.versionName
} else {
    $package = [IO.File]::ReadAllText((Join-Path (Split-Path -Parent $root) 'package.json')) | ConvertFrom-Json
    if ($package.version -notmatch '^\d{4}\.\d{1,2}\.\d{1,2}$') {
        throw 'Semantic Android builds require -ArtifactVersion from the frozen release owner.'
    }
}
if ($VersionCode -le 0) {
    $VersionCode = [Math]::Floor($buildTime.ToUnixTimeSeconds() / 60)
    if (Test-Path -LiteralPath $publishedManifest) {
        $previousManifest = Get-Content -LiteralPath $publishedManifest -Raw -Encoding UTF8 | ConvertFrom-Json
        $previousVersionCode = [long]$previousManifest.versionCode
        if ($VersionCode -le $previousVersionCode) {
            $VersionCode = $previousVersionCode + 1
        }
    }
}
if ($VersionCode -lt 2 -or $VersionCode -gt 2100000000) {
    throw "VersionCode must be between 2 and 2100000000: $VersionCode"
}
if (-not $VersionName) {
    $VersionName = $buildTime.ToString('yyyy.MM.dd.HHmm')
}
if ($VersionName -notmatch '^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$') {
    throw "VersionName contains unsupported characters: $VersionName"
}
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT }
    elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME }
    else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }

if (-not (Test-Path -LiteralPath (Join-Path $sdk 'platforms\android-36\android.jar'))) {
    throw "Android SDK API 36 was not found: $sdk"
}

$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$localGradle = Join-Path $env:LOCALAPPDATA 'AgentHub\toolchains\gradle-8.13\bin\gradle.bat'
$gradle = if ($env:AGENT_HUB_GRADLE) { $env:AGENT_HUB_GRADLE }
    elseif (Test-Path -LiteralPath $localGradle) { $localGradle }
    else { Join-Path $root 'gradlew.bat' }

if (-not (Test-Path -LiteralPath $gradle)) {
    throw 'Gradle 8.13 was not found. Run gradlew.bat after installing the Android toolchain.'
}

$task = if ($Configuration -eq 'Release') { ':app:assembleRelease' } else { ':app:assembleDebug' }
$arguments = @(
    $task,
    '--no-daemon',
    "-PagentHubVersionCode=$VersionCode",
    "-PagentHubVersionName=$VersionName"
)
if ($HubUrl) {
    if ($HubUrl -notmatch '^https://') { throw 'HubUrl must use HTTPS.' }
    $arguments += "-PagentHubUrl=$($HubUrl.TrimEnd('/'))"
}

Push-Location $root
try {
    & $gradle @arguments
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$variant = $Configuration.ToLowerInvariant()
$apk = Join-Path $root "app\build\outputs\apk\$variant\app-$variant.apk"
if (-not (Test-Path -LiteralPath $apk)) { throw "APK was not created: $apk" }
$metadataFile = Join-Path $root "app\build\outputs\apk\$variant\output-metadata.json"
if (-not (Test-Path -LiteralPath $metadataFile)) { throw "Android output metadata was not created: $metadataFile" }
$metadata = Get-Content -LiteralPath $metadataFile -Raw -Encoding UTF8 | ConvertFrom-Json
$element = @($metadata.elements)[0]
if (-not $element.versionCode -or -not $element.versionName) {
    throw 'Android output metadata does not contain versionCode/versionName.'
}
if ([long]$element.versionCode -ne $VersionCode -or [string]$element.versionName -cne $VersionName) {
    throw 'Android output version differs from the requested frozen identity.'
}

$publishedApk = Join-Path $mobileAssets 'AgentHub-Mobile.apk'
$temporaryApk = "$publishedApk.$PID.tmp"
$temporaryManifest = "$publishedManifest.$PID.tmp"
$transferDirectory = Join-Path $root 'dist'
$transferApk = Join-Path $transferDirectory 'AgentHub-Mobile.apk'
$temporaryTransferApk = "$transferApk.$PID.tmp"
New-Item -ItemType Directory -Force -Path $mobileAssets | Out-Null
New-Item -ItemType Directory -Force -Path $transferDirectory | Out-Null

$sha = [Security.Cryptography.SHA256]::Create()
try {
    $stream = [IO.File]::OpenRead($apk)
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
    } finally {
        $stream.Dispose()
    }
} finally {
    $sha.Dispose()
}
$bytes = (Get-Item -LiteralPath $apk).Length
$manifest = [ordered]@{
    versionCode = [int]$element.versionCode
    versionName = [string]$element.versionName
    sha256 = $hash
    bytes = [long]$bytes
    builtAt = $buildTime.ToString('o')
}

try {
    Copy-Item -LiteralPath $apk -Destination $temporaryApk -Force
    [IO.File]::WriteAllText(
        $temporaryManifest,
        (($manifest | ConvertTo-Json) + [Environment]::NewLine),
        [Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryApk -Destination $publishedApk -Force
    Move-Item -LiteralPath $temporaryManifest -Destination $publishedManifest -Force
    Copy-Item -LiteralPath $publishedApk -Destination $temporaryTransferApk -Force
    Move-Item -LiteralPath $temporaryTransferApk -Destination $transferApk -Force
} finally {
    Remove-Item -LiteralPath $temporaryApk -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryManifest -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $temporaryTransferApk -Force -ErrorAction SilentlyContinue
}

Write-Output $publishedApk
