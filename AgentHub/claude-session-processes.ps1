param(
    [int]$Generation = 0,
    [int]$AgentHubPid = 0,
    [string]$RuntimeSignature = ''
)

$ErrorActionPreference = 'Stop'
$OwnerLimit = 128

function ConvertFrom-WindowsCommandLine {
    param([Parameter(Mandatory = $true)][string]$CommandLine)
    if (-not ('AgentHub.CommandLineNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace AgentHub {
  public static class CommandLineNative {
    [DllImport("shell32.dll", SetLastError = true)]
    public static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argc);
    [DllImport("kernel32.dll")]
    public static extern IntPtr LocalFree(IntPtr value);
  }
}
'@
    }
    $argc = 0
    $argvPointer = [AgentHub.CommandLineNative]::CommandLineToArgvW($CommandLine, [ref]$argc)
    if ($argvPointer -eq [IntPtr]::Zero -or $argc -lt 1) { throw 'argv-parser-unavailable' }
    try {
        $arguments = for ($index = 0; $index -lt $argc; $index += 1) {
            $valuePointer = [Runtime.InteropServices.Marshal]::ReadIntPtr($argvPointer, $index * [IntPtr]::Size)
            [Runtime.InteropServices.Marshal]::PtrToStringUni($valuePointer)
        }
        return @($arguments)
    } finally {
        [void][AgentHub.CommandLineNative]::LocalFree($argvPointer)
    }
}

function Test-ExecutableIdentity {
    param([string]$Actual, [string]$Expected)
    if ([string]::IsNullOrWhiteSpace($Actual) -or [string]::IsNullOrWhiteSpace($Expected)) { return $false }
    $expectedHasPath = $Expected.Contains('\') -or $Expected.Contains('/')
    if ($expectedHasPath) {
        try { return [IO.Path]::GetFullPath($Actual).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Expected).TrimEnd('\') } catch { return $false }
    }
    return [IO.Path]::GetFileNameWithoutExtension($Actual) -ieq [IO.Path]::GetFileNameWithoutExtension($Expected)
}

function Get-ClaudeSessionArguments {
    param([string[]]$Arguments, [int]$StartIndex)
    $sessions = [Collections.Generic.List[string]]::new()
    for ($index = $StartIndex; $index -lt $Arguments.Count; $index += 1) {
        $argument = [string]$Arguments[$index]
        if ($argument -match '(?i)^--(?:resume|session-id)=(?<value>[A-Za-z0-9._:-]{1,200})$') {
            $sessions.Add($Matches.value)
        } elseif ($argument -match '(?i)^--(?:resume|session-id)$' -and $index + 1 -lt $Arguments.Count) {
            $value = [string]$Arguments[$index + 1]
            if ($value -match '^[A-Za-z0-9._:-]{1,200}$') { $sessions.Add($value) }
            $index += 1
        }
    }
    return @($sessions | Select-Object -Unique)
}

function Get-ClaudeOwnerSnapshot {
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][pscustomobject]$Signature,
        [int]$SnapshotGeneration = 0,
        [int]$ExcludedPid = 0
    )
    $owners = [Collections.Generic.List[object]]::new()
    $unreadable = 0
    $runtimeCommand = [string]$Signature.command
    $prefixArguments = @($Signature.prefixArgs | ForEach-Object { [string]$_ })
    $runtimeName = [IO.Path]::GetFileNameWithoutExtension($runtimeCommand)
    foreach ($process in $Processes) {
        $pidValue = [int]$process.ProcessId
        if ($pidValue -eq $ExcludedPid) { continue }
        $processName = [IO.Path]::GetFileNameWithoutExtension([string]$process.Name)
        $runtimeHasPath = $runtimeCommand.Contains('\') -or $runtimeCommand.Contains('/')
        $runtimePathMatches = -not $runtimeHasPath -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath) -or
            (Test-ExecutableIdentity ([string]$process.ExecutablePath) $runtimeCommand)
        $potential = $processName -ieq $runtimeName -and $runtimePathMatches
        if (-not $potential) { continue }
        if ([string]::IsNullOrWhiteSpace([string]$process.CommandLine)) {
            $unreadable += 1
            continue
        }
        try { $arguments = @(ConvertFrom-WindowsCommandLine -CommandLine ([string]$process.CommandLine)) } catch {
            $unreadable += 1
            continue
        }
        $configuredRuntime = Test-ExecutableIdentity $arguments[0] $runtimeCommand
        if (-not $configuredRuntime) { continue }
        $prefixStart = 1
        if ($configuredRuntime) {
            $matchesPrefix = $arguments.Count -ge 1 + $prefixArguments.Count
            for ($prefixIndex = 0; $matchesPrefix -and $prefixIndex -lt $prefixArguments.Count; $prefixIndex += 1) {
                $matchesPrefix = [string]$arguments[$prefixIndex + 1] -ieq $prefixArguments[$prefixIndex]
            }
            if (-not $matchesPrefix) { continue }
            $prefixStart = 1 + $prefixArguments.Count
        }
        foreach ($session in @(Get-ClaudeSessionArguments -Arguments $arguments -StartIndex $prefixStart)) {
            $startTime = $null
            if ($null -ne $process.CreationDate) {
                try {
                    $created = if ($process.CreationDate -is [DateTime]) {
                        [DateTime]$process.CreationDate
                    } else {
                        [Management.ManagementDateTimeConverter]::ToDateTime([string]$process.CreationDate)
                    }
                    $startTime = $created.ToUniversalTime().ToString('o')
                } catch { $startTime = $null }
            }
            $owners.Add([ordered]@{ pid = $pidValue; startTime = $startTime; sessionId = $session })
            if ($owners.Count -gt $OwnerLimit) { $unreadable += 1; break }
        }
        if ($owners.Count -gt $OwnerLimit) { break }
    }
    $boundedOwners = @($owners | Sort-Object pid, sessionId -Unique | Select-Object -First $OwnerLimit)
    return [ordered]@{
        complete = ($unreadable -eq 0 -and $owners.Count -le $OwnerLimit)
        generation = $SnapshotGeneration
        scannedAt = [DateTime]::UtcNow.ToString('o')
        owners = $boundedOwners
        unreadableCandidateCount = $unreadable
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        $signatureJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($RuntimeSignature))
        $signature = $signatureJson | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace([string]$signature.command)) { throw 'invalid-runtime-signature' }
        if ($signature.authoritative -ne $true) {
            [ordered]@{
                complete = $false
                generation = $Generation
                scannedAt = [DateTime]::UtcNow.ToString('o')
                owners = @()
                unreadableCandidateCount = 0
                errorCode = 'runtime-signature-unresolved'
            } | ConvertTo-Json -Compress -Depth 4
            return
        }
        $processes = @(Get-CimInstance Win32_Process -Property ProcessId,Name,ExecutablePath,CommandLine,CreationDate)
        Get-ClaudeOwnerSnapshot -Processes $processes -Signature $signature -SnapshotGeneration $Generation -ExcludedPid $AgentHubPid |
            ConvertTo-Json -Compress -Depth 5
    } catch {
        [ordered]@{
            complete = $false
            generation = $Generation
            scannedAt = [DateTime]::UtcNow.ToString('o')
            owners = @()
            unreadableCandidateCount = 0
            errorCode = 'enumeration-unavailable'
        } | ConvertTo-Json -Compress -Depth 4
    }
}
