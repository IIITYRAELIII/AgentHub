using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class CodexAppServerJobCustody {
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr value, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }

    static void Check(bool ok) {
        if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    static void ConfigureKillOnClose(IntPtr job) {
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Check(QueryInformationJobObject(job, 9, buffer, (uint)size, IntPtr.Zero));
            var limits = (ExtendedLimits)Marshal.PtrToStructure(buffer, typeof(ExtendedLimits));
            limits.Basic.Flags |= JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Marshal.StructureToPtr(limits, buffer, false);
            Check(SetInformationJobObject(job, 9, buffer, (uint)size));
            Check(QueryInformationJobObject(job, 9, buffer, (uint)size, IntPtr.Zero));
            limits = (ExtendedLimits)Marshal.PtrToStructure(buffer, typeof(ExtendedLimits));
            if ((limits.Basic.Flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0)
                throw new InvalidOperationException("Codex App Server job did not retain kill-on-close");
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    static uint ActiveProcesses(IntPtr job) {
        int size = Marshal.SizeOf(typeof(Accounting));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
            Check(QueryInformationJobObject(job, 1, buffer, (uint)size, IntPtr.Zero));
            return ((Accounting)Marshal.PtrToStructure(buffer, typeof(Accounting))).Active;
        } finally { Marshal.FreeHGlobal(buffer); }
    }

    public static void Run(int rootPid) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) Check(false);
        try {
            ConfigureKillOnClose(job);
            using (Process root = Process.GetProcessById(rootPid)) {
                Check(AssignProcessToJobObject(job, root.Handle));
            }
            Console.WriteLine("{\"state\":\"ready\",\"rootPid\":" + rootPid + ",\"active\":" + ActiveProcesses(job) + "}");
            Console.Out.Flush();
            string command;
            while ((command = Console.ReadLine()) != null && command != "close") {
                if (command != "status") throw new ArgumentException("Unknown custody command");
                Console.WriteLine("{\"state\":\"active\",\"rootPid\":" + rootPid + ",\"active\":" + ActiveProcesses(job) + "}");
                Console.Out.Flush();
            }
            Check(TerminateJobObject(job, 1));
            var deadline = DateTime.UtcNow.AddSeconds(5);
            uint active;
            do {
                active = ActiveProcesses(job);
                if (active == 0) break;
                System.Threading.Thread.Sleep(10);
            } while (DateTime.UtcNow < deadline);
            if (active != 0) throw new InvalidOperationException("Codex App Server job still has active processes");
            Console.WriteLine("{\"state\":\"closed\",\"rootPid\":" + rootPid + ",\"active\":0}");
            Console.Out.Flush();
        } finally {
            // Closing the last job handle is the final exact cohort fence. It
            // also runs when Agent Hub disappears and stdin reaches EOF.
            CloseHandle(job);
        }
    }
}
