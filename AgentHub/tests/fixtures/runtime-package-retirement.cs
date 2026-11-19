using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

internal static class PackageRetirementProbe
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Startup
    {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X, Y, XS, YS, XC, YC, Fill, Flags;
        public short Show, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Created { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting { public long A, B, C, D; public uint Faults, Total, Active, Terminated; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string app, StringBuilder args, IntPtr pa, IntPtr ta,
        bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Created process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
        out Accounting accounting, uint length, IntPtr returned);
    [DllImport("kernel32.dll", EntryPoint = "QueryInformationJobObject", SetLastError = true)]
    private static extern bool QueryMembers(IntPtr job, int informationClass, IntPtr buffer, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Win32Exception(Marshal.GetLastWin32Error(), message);
    }
    private static Created Start(string node, IntPtr job, bool naturalExit)
    {
        Startup startup = new Startup(); startup.Size = (uint)Marshal.SizeOf(typeof(Startup));
        Created process;
        string body = naturalExit ? "setTimeout(()=>{},500)" : "setInterval(()=>{},1000)";
        Check(CreateProcess(node, new StringBuilder("\"" + node + "\" --eval \"" + body + "\""),
            IntPtr.Zero, IntPtr.Zero, false, 4 | 0x08000000, IntPtr.Zero, null, ref startup, out process), "create fixture member");
        try
        {
            Check(job == IntPtr.Zero || AssignProcessToJobObject(job, process.Process), "assign exact fixture Job");
            Check(ResumeThread(process.Thread) == 1, "resume fixture member");
            return process;
        }
        catch { Cleanup(process); throw; }
    }
    private static void Cleanup(Created process)
    {
        if (process.Process == IntPtr.Zero) return;
        if (WaitForSingleObject(process.Process, 0) == 258) Check(TerminateProcess(process.Process, 79), "stop own fixture member");
        Check(WaitForSingleObject(process.Process, 10000) == 0, "join own fixture member");
        CloseHandle(process.Thread); CloseHandle(process.Process);
    }
    private static uint[] Members(IntPtr job)
    {
        IntPtr buffer = Marshal.AllocHGlobal(8 + 64 * IntPtr.Size);
        try
        {
            uint returned;
            Check(QueryMembers(job, 3, buffer, (uint)(8 + 64 * IntPtr.Size), out returned), "complete four-process fixture membership");
            int assigned = Marshal.ReadInt32(buffer), count = Marshal.ReadInt32(buffer, 4);
            Check(count == assigned && count >= 0 && count <= 64, "whole fixture membership");
            uint[] result = new uint[count];
            for (int index = 0; index < count; index++) result[index] = (uint)Marshal.ReadIntPtr(buffer, 8 + index * IntPtr.Size).ToInt64();
            return result;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    public static int Main(string[] args)
    {
        if (args.Length == 5 && args[2] == "hold-owned") return HoldOwned(args);
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Created first = new Created(), second = new Created(), foreign = new Created();
        Process node = null, host = null, other = null;
        var heldMembers = new System.Collections.Generic.List<IntPtr>();
        try
        {
            Check(job != IntPtr.Zero, "create anonymous fixture Job");
            Type owner = Assembly.LoadFrom(args[0]).GetType("AgentHub.RuntimeHost.Program", true);
            MethodInfo empty = owner.GetMethod("PackageJobIsEmpty", BindingFlags.Static | BindingFlags.NonPublic);
            MethodInfo retire = owner.GetMethod("RetirePackageCohort", BindingFlags.Static | BindingFlags.NonPublic);
            first = Start(args[1], job, args[2] == "held-references");
            second = Start(args[1], job, args[2] == "held-references");
            foreign = Start(args[1], IntPtr.Zero, false);
            node = Process.GetProcessById((int)first.Pid); host = Process.GetProcessById((int)second.Pid);
            other = Process.GetProcessById((int)foreign.Pid);
            bool liveRefused = !(bool)empty.Invoke(null, new object[] { job });
            int forcedAdmissions = 0;
            if (args[2] == "held-references")
            {
                Check(WaitForSingleObject(first.Process, 10000) == 0 && WaitForSingleObject(second.Process, 10000) == 0, "join retired fixture Job");
                // Windows can keep an owned conhost alive briefly after Node
                // signals. Join the whole observed cohort, retaining every handle.
                foreach (uint pid in Members(job))
                {
                    IntPtr member = OpenProcess(0x00100000, false, pid);
                    if (member == IntPtr.Zero)
                    {
                        Check(Marshal.GetLastWin32Error() == 87, "observed fixture member absent");
                        continue;
                    }
                    heldMembers.Add(member);
                    Check(WaitForSingleObject(member, 10000) == 0, "whole fixture member joined");
                }
            }
            else
            {
                Action admit = () => {
                    forcedAdmissions++;
                    if (args[2] == "denied") throw new InvalidOperationException("controlled durable admission refusal");
                };
                try
                {
                    retire.Invoke(null, new object[] { job, args[2] == "foreign" ? other : node, host, admit, 50, 10000 });
                }
                catch (TargetInvocationException error)
                {
                    if (args[2] != "denied" && args[2] != "foreign") throw;
                    if (error.InnerException == null) throw;
                }
            }
            Accounting accounting;
            Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "retained Job accounting");
            uint firstExit, secondExit;
            bool heldReferencesValid = GetExitCodeProcess(first.Process, out firstExit)
                && GetExitCodeProcess(second.Process, out secondExit);
            uint[] members = Members(job);
            var memberStates = new System.Collections.Generic.List<object>();
            foreach (uint pid in members)
            {
                try
                {
                    using (Process member = Process.GetProcessById((int)pid))
                        memberStates.Add(new { pid, name = member.ProcessName, wait = WaitForSingleObject(member.Handle, 0) });
                }
                catch (Exception error) { memberStates.Add(new { pid, error = error.GetType().Name }); }
            }
            Console.WriteLine(new JavaScriptSerializer().Serialize(new {
                liveRefused, heldReferencesValid, activeAccountingWithHeldReferences = accounting.Active, memberStates,
                stoppedProof = (bool)empty.Invoke(null, new object[] { job }), forcedAdmissions,
                nodeExited = WaitForSingleObject(first.Process, 0) == 0,
                hostExited = WaitForSingleObject(second.Process, 0) == 0,
                foreignAlive = WaitForSingleObject(foreign.Process, 0) == 258,
                nullJobRefused = !(bool)empty.Invoke(null, new object[] { IntPtr.Zero })
            }));
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally
        {
            if (node != null) node.Dispose(); if (host != null) host.Dispose(); if (other != null) other.Dispose();
            foreach (IntPtr member in heldMembers) CloseHandle(member);
            Cleanup(first); Cleanup(second); Cleanup(foreign);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
    }

    private static int HoldOwned(string[] args)
    {
        IntPtr job = IntPtr.Zero;
        Created held = new Created();
        try
        {
            string root = System.IO.Path.GetFullPath(args[3]);
            Check(String.Equals(System.IO.Path.GetFullPath(args[0]), System.IO.Path.Combine(root, "AgentHub.RuntimeHost.exe"),
                StringComparison.OrdinalIgnoreCase), "exact private fixture Host");
            Type owner = Assembly.LoadFrom(args[0]).GetType("AgentHub.RuntimeHost.Program", true);
            Check(owner.GetMethod("ReadAcceptanceMarker", BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, new object[] { root }) != null, "explicit private acceptance authority");
            string name = (string)owner.GetMethod("PackageCohortJobName", BindingFlags.Static | BindingFlags.NonPublic)
                .Invoke(null, new object[] { root, Int32.Parse(args[4]) });
            job = OpenJobObject(4 | 1, false, name);
            Check(job != IntPtr.Zero, "open existing private installation Job");
            using (Process host = Process.GetProcessById(Int32.Parse(args[4])))
            {
                bool member;
                Check(String.Equals(System.IO.Path.GetFullPath(host.MainModule.FileName), System.IO.Path.GetFullPath(args[0]),
                    StringComparison.OrdinalIgnoreCase), "physical old fixture Host image");
                Check(IsProcessInJob(host.Handle, job, out member) && member, "old Host owns private fixture Job");
                Check(IsProcessInJob(GetCurrentProcess(), job, out member) && !member, "writer holder is outside old Job");
            }
            held = Start(args[1], job, false);
            using (Process process = Process.GetProcessById((int)held.Pid))
            {
                bool member;
                Check(IsProcessInJob(process.Handle, job, out member) && member, "held writer belongs to exact old Job");
                Console.WriteLine(new JavaScriptSerializer().Serialize(new { pid = held.Pid, parentPid = Process.GetCurrentProcess().Id,
                    started = process.StartTime.ToUniversalTime().Ticks.ToString(), jobMember = true }));
                Console.Out.Flush();
            }
            Console.ReadLine();
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { Cleanup(held); if (job != IntPtr.Zero) CloseHandle(job); }
    }
}
