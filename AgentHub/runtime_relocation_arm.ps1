param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{64}$')][string]$ConfigSha256,
    [Parameter(Mandatory)][string]$PythonwPath
)

$ErrorActionPreference = 'Stop'
$configFile = Get-Item -LiteralPath $ConfigPath
if ((Get-FileHash -LiteralPath $configFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ConfigSha256) {
    throw 'Exact reviewed invocation hash differs'
}
$config = [IO.File]::ReadAllText($configFile.FullName) | ConvertFrom-Json
$helper = Join-Path $PSScriptRoot 'runtime_relocation_cutover.py'
# Dotted JSON property names require indexed lookup.
$expected = $config.helper_sha256.PSObject.Properties['runtime_relocation_cutover.py'].Value
if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
    throw 'Frozen cutover entry differs'
}
$pythonw = Get-Item -LiteralPath $PythonwPath
if ($pythonw.Name -ne 'pythonw.exe' -or $pythonw.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'An exact ordinary Python windowless executable is required'
}
foreach ($argument in @($pythonw.FullName, $helper, $configFile.FullName)) {
    if ($argument.Contains('"') -or $argument.Contains("`r") -or $argument.Contains("`n")) {
        throw 'Unsupported Windows process argument'
    }
}
$command = '"{0}" -X utf8 -B "{1}" --config "{2}" --expected-config-sha256 {3}' -f $pythonw.FullName, $helper, $configFile.FullName, $ConfigSha256
# WMI owns the independent process. A normal AppServer child can remain in its
# job and disappear when the old runtime is stopped. The helper also verifies
# IsProcessInJob before any stop and refuses an unproven independent launch.
$created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $command
    CurrentDirectory = $PSScriptRoot
}
if ($created.ReturnValue -ne 0) {
    throw "Independent helper creation failed: $($created.ReturnValue)"
}
[pscustomobject]@{
    helperPid = $created.ProcessId
    configSha256 = $ConfigSha256
    effect = 'armed; no claim that terminal barrier or cutover has completed'
} | ConvertTo-Json -Compress
