// Accounting only: no CPU/memory/process limits and no kill-on-close flag.
// Job accounting retains CPU used by exited Git/browser/helper descendants.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class TestResourceAccounting {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr value, uint length, IntPtr returned);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User, Kernel, PeriodUser, PeriodKernel;
        public uint Faults, Total, Active, Terminated;
    }
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
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Sample(IntPtr job) {
        IntPtr buffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Accounting)));
        Accounting account;
        try {
            Check(QueryInformationJobObject(job, 1, buffer, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
            account = (Accounting)Marshal.PtrToStructure(buffer, typeof(Accounting));
        } finally { Marshal.FreeHGlobal(buffer); }
        long resident = 0;
        uint count = Math.Max(account.Active + 16, 64);
        while (true) {
            uint size = checked(8 + count * (uint)IntPtr.Size);
            buffer = Marshal.AllocHGlobal((int)size);
            try {
                if (!QueryInformationJobObject(job, 3, buffer, size, IntPtr.Zero)) {
                    if (Marshal.GetLastWin32Error() == 234) { count = checked(count * 2); continue; }
                    Check(false);
                }
                int listed = Marshal.ReadInt32(buffer, 4);
                for (int i = 0; i < listed; i++) {
                    int pid = checked((int)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64());
                    try { using (Process process = Process.GetProcessById(pid)) {
                        bool member;
                        Check(IsProcessInJob(process.Handle, job, out member));
                        if (member) resident += process.WorkingSet64;
                    } }
                    catch (ArgumentException) { /* Already exited; its CPU remains in job accounting. */ }
                    catch (InvalidOperationException) { /* Exited between enumeration and query. */ }
                }
                break;
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        uint flags;
        int limitsSize = Marshal.SizeOf(typeof(ExtendedLimits));
        buffer = Marshal.AllocHGlobal(limitsSize);
        try {
            Check(QueryInformationJobObject(job, 9, buffer, (uint)limitsSize, IntPtr.Zero));
            flags = ((ExtendedLimits)Marshal.PtrToStructure(buffer, typeof(ExtendedLimits))).Basic.Flags;
        } finally { Marshal.FreeHGlobal(buffer); }
        return "{\"cpuMs\":" + ((account.User + account.Kernel) / 10000.0).ToString("R", CultureInfo.InvariantCulture)
            + ",\"rssBytes\":" + resident + ",\"processes\":" + account.Active
            + ",\"totalProcesses\":" + account.Total + ",\"limitFlags\":" + flags + "}";
    }
    public static void Run(int rootPid) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) Check(false);
        try {
            using (Process root = Process.GetProcessById(rootPid)) Check(AssignProcessToJobObject(job, root.Handle));
            using (Process self = Process.GetCurrentProcess()) Check(AssignProcessToJobObject(job, self.Handle));
            Console.WriteLine(Sample(job));
            string command;
            while ((command = Console.ReadLine()) != null) {
                if (command == "close") break;
                if (command != "sample") throw new ArgumentException("Unknown accounting command");
                Console.WriteLine(Sample(job));
            }
        } finally { CloseHandle(job); }
    }
}
