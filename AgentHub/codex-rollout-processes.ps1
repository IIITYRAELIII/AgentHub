param(
    [Parameter(Mandatory = $true)]
    [string]$RolloutPath,
    [int]$AgentHubPid = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AgentHubRestartManager
{
    private const int MoreData = 234;
    private const int MaxAppName = 255;
    private const int MaxServiceName = 63;

    [StructLayout(LayoutKind.Sequential)]
    public struct UniqueProcess
    {
        public int ProcessId;
        public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
    }

    public enum AppType
    {
        Unknown = 0,
        MainWindow = 1,
        OtherWindow = 2,
        Service = 3,
        Explorer = 4,
        Console = 5,
        Critical = 1000
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxAppName + 1)]
        public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxServiceName + 1)]
        public string ServiceShortName;
        public AppType ApplicationType;
        public uint AppStatus;
        public uint TerminalSessionId;
        [MarshalAs(UnmanagedType.Bool)]
        public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint handle, int flags, string sessionKey);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(
        uint handle,
        uint fileCount,
        string[] fileNames,
        uint applicationCount,
        UniqueProcess[] applications,
        uint serviceCount,
        string[] serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(
        uint handle,
        out uint needed,
        ref uint count,
        [In, Out] ProcessInfo[] processInfo,
        ref uint rebootReasons);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint handle);

    public static int[] ProcessesUsing(string fileName)
    {
        uint handle;
        var key = Guid.NewGuid().ToString("N").Substring(0, 32);
        var result = RmStartSession(out handle, 0, key);
        if (result != 0) throw new InvalidOperationException("RmStartSession failed: " + result);
        try
        {
            result = RmRegisterResources(handle, 1, new[] { fileName }, 0, null, 0, null);
            if (result != 0) throw new InvalidOperationException("RmRegisterResources failed: " + result);
            uint needed = 0;
            uint count = 0;
            uint reasons = 0;
            result = RmGetList(handle, out needed, ref count, null, ref reasons);
            if (result == 0) return new int[0];
            if (result != MoreData) throw new InvalidOperationException("RmGetList failed: " + result);
            var info = new ProcessInfo[needed];
            count = needed;
            result = RmGetList(handle, out needed, ref count, info, ref reasons);
            if (result != 0) throw new InvalidOperationException("RmGetList failed: " + result);
            var processIds = new int[count];
            for (var index = 0; index < count; index++) processIds[index] = info[index].Process.ProcessId;
            return processIds;
        }
        finally
        {
            RmEndSession(handle);
        }
    }
}
'@

$rootProcessIds = @([AgentHubRestartManager]::ProcessesUsing($RolloutPath) | Where-Object { $_ -gt 0 })
$allProcesses = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
$byId = @{}
foreach ($process in $allProcesses) {
    $byId[[int]$process.ProcessId] = $process
}

$selected = @{}
foreach ($rootProcessId in $rootProcessIds) {
    $currentProcessId = [int]$rootProcessId
    $depth = 0
    while ($currentProcessId -gt 0 -and $depth -lt 32 -and $byId.ContainsKey($currentProcessId)) {
        if ($selected.ContainsKey($currentProcessId)) { break }
        $process = $byId[$currentProcessId]
        $selected[$currentProcessId] = [ordered]@{
            processId = [int]$process.ProcessId
            parentProcessId = [int]$process.ParentProcessId
            name = [string]$process.Name
            commandLine = [string]$process.CommandLine
        }
        $currentProcessId = [int]$process.ParentProcessId
        $depth += 1
    }
}

[ordered]@{
    rootProcessIds = @($rootProcessIds)
    agentHubPid = $AgentHubPid
    processes = @($selected.Values)
} | ConvertTo-Json -Compress -Depth 4
