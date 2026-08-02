param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId
)

$ErrorActionPreference = 'Stop'

$allProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$byId = @{}
foreach ($item in $allProcesses) {
    $byId[[int]$item.ProcessId] = $item
}

$selected = @()
$currentProcessId = $ProcessId
$visited = @{}
$depth = 0
while ($currentProcessId -gt 0 -and $depth -lt 32 -and $byId.ContainsKey($currentProcessId)) {
    if ($visited.ContainsKey($currentProcessId)) { break }
    $visited[$currentProcessId] = $true
    $item = $byId[$currentProcessId]
    $selected += [ordered]@{
        processId = [int]$item.ProcessId
        parentProcessId = [int]$item.ParentProcessId
        name = [string]$item.Name
        commandLine = [string]$item.CommandLine
    }
    $currentProcessId = [int]$item.ParentProcessId
    $depth += 1
}

[ordered]@{
    rootProcessIds = @($ProcessId)
    processes = @($selected)
} | ConvertTo-Json -Compress -Depth 4
