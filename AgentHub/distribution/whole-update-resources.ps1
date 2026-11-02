# Read-only supplement to the existing test Job accounting. Detached native
# continuations deliberately escape that Job; only exact admitted birth-bound
# roots and their observed descendants enter this diagnostic sample.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line -eq 'close') { break }
    $request = $line | ConvertFrom-Json
    if ($request.roots.Count -gt 4) { throw 'Too many diagnostic roots' }
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
    $baseline = [System.Collections.Generic.HashSet[int]]::new()
    [void]$baseline.Add([int]$request.harnessPid)
    do {
        $prior = $baseline.Count
        foreach ($row in $rows) { if ($baseline.Contains([int]$row.ParentProcessId)) { [void]$baseline.Add([int]$row.ProcessId) } }
    } while ($prior -ne $baseline.Count)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $missing = @()
    foreach ($root in $request.roots) {
        try {
            $process = Get-Process -Id ([int]$root.pid) -ErrorAction Stop
            if ($process.StartTime.ToUniversalTime().Ticks.ToString() -ne [string]$root.started) { throw 'birth mismatch' }
            [void]$owned.Add([int]$root.pid)
        } catch { $missing += [int]$root.pid }
    }
    do {
        $prior = $owned.Count
        foreach ($row in $rows) { if ($owned.Contains([int]$row.ParentProcessId)) { [void]$owned.Add([int]$row.ProcessId) } }
    } while ($prior -ne $owned.Count)
    $observed = @()
    foreach ($processId in $owned) {
        if ($baseline.Contains($processId)) { continue }
        try {
            $process = Get-Process -Id $processId -ErrorAction Stop
            $row = $rows | Where-Object { [int]$_.ProcessId -eq $processId } | Select-Object -First 1
            if ($null -eq $row -or [Math]::Abs(($process.StartTime.ToUniversalTime() - $row.CreationDate.ToUniversalTime()).TotalMilliseconds) -gt 1) { continue }
            $observed += @{ pid=$processId; parentPid=[int]$row.ParentProcessId; name=$process.ProcessName; workingSetBytes=$process.WorkingSet64; peakWorkingSetBytes=$process.PeakWorkingSet64 }
        } catch { } # Exited between the two readonly observations, not zero usage.
    }
    [Console]::WriteLine((@{ processes=$observed; missingRoots=$missing } | ConvertTo-Json -Compress -Depth 4))
}
