[CmdletBinding()]
param(
    [string]$HubUrl = $env:AGENT_HUB_PUBLIC_URL,
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
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
$arguments = @($task, '--no-daemon')
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
Write-Output $apk
