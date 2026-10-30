using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("Agent Hub Server")]
[assembly: AssemblyDescription("Agent Hub local server and process host")]
[assembly: AssemblyCompany("Dark Sanctuary Utilities")]
[assembly: AssemblyProduct("Agent Hub")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace AgentHub.RuntimeHost
{
    internal static class Program
    {
        private const string AutostartShortcutName = "Agent Hub.lnk";
        private const string AppUserModelId = "IIITYRAELIII.AgentHub";
        private static readonly Regex ReleaseIdPattern = new Regex(
            "^[A-Za-z0-9][A-Za-z0-9._-]*$",
            RegexOptions.CultureInvariant);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr OpenJobObject(uint access, bool inheritHandle, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(string application, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation information);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct StartupInfo
        {
            public uint Size; public string Reserved, Desktop, Title;
            public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
            public short ShowWindow, ReservedSize; public IntPtr ReservedPointer, Input, Output, Error;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ProcessInformation
        {
            public IntPtr Process, Thread; public uint ProcessId, ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct StartupInfoEx
        {
            public StartupInfo Startup; public IntPtr Attributes;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW", SetLastError = true)]
        private static extern bool CreateProcessExtended(string application, StringBuilder commandLine,
            IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags,
            IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation information);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute,
            IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returnedBytes);
        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool ProcessIdToSessionId(uint pid, out uint session);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr information, int bytes, out int needed);
        [DllImport("advapi32.dll")]
        private static extern bool IsTokenRestricted(IntPtr token);
        [DllImport("user32.dll")]
        private static extern IntPtr GetShellWindow();
        [DllImport("user32.dll", SetLastError = true)]
        private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        private static long ProcessLogonIdentity(IntPtr process)
        {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr buffer = IntPtr.Zero;
            try
            {
                int bytes;
                GetTokenInformation(token, 10, IntPtr.Zero, 0, out bytes); // TOKEN_STATISTICS
                if (bytes < 16 || bytes > 4096) throw new InvalidOperationException("Unknown process logon identity");
                buffer = Marshal.AllocHGlobal(bytes);
                if (!GetTokenInformation(token, 10, buffer, bytes, out bytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                return Marshal.ReadInt64(buffer, 8); // AuthenticationId, not token ID
            }
            finally { if (buffer != IntPtr.Zero) Marshal.FreeHGlobal(buffer); CloseHandle(token); }
        }

        private static string ProcessSecurityContext(IntPtr process)
        {
            IntPtr token;
            if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                List<string> parts = new List<string>();
                using (WindowsIdentity identity = new WindowsIdentity(token)) parts.Add(identity.User.Value);
                parts.Add(ProcessLogonIdentity(process).ToString(CultureInfo.InvariantCulture));
                parts.Add(IsTokenRestricted(token).ToString());
                // Effective group/privilege attributes matter even at the same
                // user/logon and integrity level. Pointer addresses never bind.
                foreach (int kind in new int[] { 2, 3, 11, 18, 20, 25, 26, 29 })
                {
                    int bytes; GetTokenInformation(token, kind, IntPtr.Zero, 0, out bytes);
                    if (bytes < 4 || bytes > 1048576) throw new InvalidOperationException(
                        "Unknown process security context field " + kind + " (" + Marshal.GetLastWin32Error() + ")");
                    IntPtr buffer = Marshal.AllocHGlobal(bytes);
                    try
                    {
                        if (!GetTokenInformation(token, kind, buffer, bytes, out bytes))
                            throw new Win32Exception(Marshal.GetLastWin32Error());
                        List<string> values = new List<string>();
                        if (kind == 25) values.Add(new SecurityIdentifier(Marshal.ReadIntPtr(buffer)).Value);
                        else if (kind == 2 || kind == 11 || kind == 3)
                        {
                            int count = Marshal.ReadInt32(buffer);
                            int offset = kind == 3 ? 4 : IntPtr.Size;
                            int stride = kind == 3 ? 12 : IntPtr.Size * 2;
                            if (count < 0 || count > (bytes - offset) / stride)
                                throw new InvalidOperationException("Malformed process security context");
                            for (int index = 0; index < count; index++)
                            {
                                IntPtr item = IntPtr.Add(buffer, offset + index * stride);
                                values.Add(kind == 3
                                    ? Marshal.ReadInt64(item).ToString(CultureInfo.InvariantCulture) + ":" + Marshal.ReadInt32(item, 8)
                                    : new SecurityIdentifier(Marshal.ReadIntPtr(item)).Value + ":" + Marshal.ReadInt32(item, IntPtr.Size));
                            }
                            values.Sort(StringComparer.Ordinal);
                        }
                        else values.Add(Marshal.ReadInt32(buffer).ToString(CultureInfo.InvariantCulture));
                        parts.Add(kind.ToString(CultureInfo.InvariantCulture) + "=" + String.Join(",", values.ToArray()));
                    }
                    finally { Marshal.FreeHGlobal(buffer); }
                }
                return String.Join(";", parts.ToArray());
            }
            finally { CloseHandle(token); }
        }

        private static void VerifyShellParent(IntPtr parent, uint pid)
        {
            uint actualPid, parentSession, currentSession;
            IntPtr shell = GetShellWindow();
            if (shell == IntPtr.Zero || GetWindowThreadProcessId(shell, out actualPid) == 0 || actualPid != pid
                || WaitForSingleObject(parent, 0) != 258
                || !ProcessIdToSessionId(pid, out parentSession)
                || !ProcessIdToSessionId((uint)Process.GetCurrentProcess().Id, out currentSession)
                || parentSession != currentSession)
                throw new InvalidOperationException("Desktop shell parent identity changed or is unavailable");
            StringBuilder image = new StringBuilder(32768); uint length = (uint)image.Capacity;
            if (!QueryFullProcessImageName(parent, 0, image, ref length)
                || !String.Equals(Path.GetFullPath(image.ToString()),
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"),
                    StringComparison.OrdinalIgnoreCase)
                || ProcessLogonIdentity(parent) != ProcessLogonIdentity(GetCurrentProcess()))
                throw new InvalidOperationException("Desktop shell belongs to a foreign image or logon");
            bool inJob;
            if (!IsProcessInJob(parent, IntPtr.Zero, out inJob) || inJob)
                throw new InvalidOperationException("Desktop shell is not outside all process jobs");
        }

        // Used only by the existing Host launch owner. No arbitrary parent PID,
        // shell command, token switch or fallback is accepted at the public entry.
        private static ProcessInformation CreateIndependentProcess(string executable, string arguments,
            string directory, out uint parentPid)
        {
            IntPtr shell = GetShellWindow();
            if (shell == IntPtr.Zero || GetWindowThreadProcessId(shell, out parentPid) == 0)
                throw new InvalidOperationException("Interactive desktop shell is unavailable");
            IntPtr parent = OpenProcess(0x00100000 | 0x1000 | 0x80, false, parentPid);
            if (parent == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot pin desktop shell");
            IntPtr list = IntPtr.Zero, value = IntPtr.Zero;
            bool initialized = false, resumed = false;
            ProcessInformation child = new ProcessInformation();
            try
            {
                VerifyShellParent(parent, parentPid);
                IntPtr bytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes);
                if (bytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                list = Marshal.AllocHGlobal(bytes);
                if (!InitializeProcThreadAttributeList(list, 1, 0, ref bytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                initialized = true;
                value = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(value, parent);
                if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x00020000), value,
                    new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                StartupInfoEx startup = new StartupInfoEx();
                startup.Startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx));
                startup.Startup.Flags = 1; startup.Startup.ShowWindow = 0; startup.Attributes = list;
                VerifyShellParent(parent, parentPid);
                if (!CreateProcessExtended(executable, new StringBuilder(QuoteArgument(executable) + arguments),
                    IntPtr.Zero, IntPtr.Zero, false, 0x00080000 | 0x08000000 | 0x00000200 | 4,
                    IntPtr.Zero, directory, ref startup, out child))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "Independent RuntimeHost creation failed");
                bool childInJob;
                if (!IsProcessInJob(child.Process, IntPtr.Zero, out childInJob) || childInJob)
                    throw new InvalidOperationException("New RuntimeHost inherited a process job before execution");
                if (!String.Equals(ProcessSecurityContext(child.Process), ProcessSecurityContext(GetCurrentProcess()),
                    StringComparison.Ordinal))
                    throw new InvalidOperationException("New RuntimeHost security context differs from its requesting owner");
                VerifyShellParent(parent, parentPid);
                if (ResumeThread(child.Thread) != 1) throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resume owned RuntimeHost");
                resumed = true;
                return child;
            }
            finally
            {
                bool cleanupUnknown = false;
                if (!resumed && child.Process != IntPtr.Zero)
                {
                    // Only this exact, newly created suspended child; never a
                    // PID lookup or cleanup of an existing runtime/foreign job.
                    cleanupUnknown = !TerminateProcess(child.Process, 1) || WaitForSingleObject(child.Process, 10000) != 0;
                    CloseHandle(child.Thread); CloseHandle(child.Process);
                }
                if (initialized) DeleteProcThreadAttributeList(list);
                if (list != IntPtr.Zero) Marshal.FreeHGlobal(list);
                if (value != IntPtr.Zero) Marshal.FreeHGlobal(value);
                CloseHandle(parent);
                if (cleanupUnknown) throw new InvalidOperationException("Suspended child cleanup remains unknown");
            }
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int informationClass,
            out JobAccounting information, uint length, IntPtr returnLength);

        [StructLayout(LayoutKind.Sequential)]
        private struct JobAccounting
        {
            public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [STAThread]
        private static int Main(string[] args)
        {
            string runtimeRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            try
            {
                if (args.Length == 6 && args[0] == "--package-handoff")
                {
                    bool inherited;
                    if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inherited))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    if (!inherited) return PackageHandoff(args);
                    Environment.SetEnvironmentVariable("AGENT_HUB_PACKAGE_LAUNCHER_PID",
                        Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture));
                    StringBuilder forwarded = new StringBuilder();
                    foreach (string argument in args) forwarded.Append(" ").Append(QuoteArgument(argument));
                    uint parentPid;
                    ProcessInformation continuation = CreateIndependentProcess(Assembly.GetExecutingAssembly().Location,
                        forwarded.ToString(), AppDomain.CurrentDomain.BaseDirectory, out parentPid);
                    CloseHandle(continuation.Thread); CloseHandle(continuation.Process);
                    return 0;
                }
                if (!(args.Length == 1 && args[0] == "--check"))
                {
                    bool inheritedJob;
                    IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inheritedJob);
                    WriteLifetime(runtimeRoot, "host-entry", 0, null, inheritedJob);
                }
                if (args.Length == 1 && args[0] == "--close-release-acceptance")
                {
                    CloseReleaseAcceptance(runtimeRoot);
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--install-autostart")
                {
                    InstallAutostart(runtimeRoot);
                    return 0;
                }
                if (args.Length == 1 && args[0] == "--spawn-independent")
                {
                    return StartIndependent(runtimeRoot);
                }

                bool checkOnly = args.Length == 1 && args[0] == "--check";
                if (args.Length > 0 && !checkOnly)
                {
                    throw new InvalidOperationException("Unsupported RuntimeHost arguments");
                }
                return Run(runtimeRoot, checkOnly);
            }
            catch (Exception error)
            {
                bool inJob;
                IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob);
                WriteLifetime(runtimeRoot, "host-failed", 0, 1, inJob);
                WriteFailure(runtimeRoot, error);
                return 1;
            }
        }

        private static int Run(string runtimeRoot, bool checkOnly)
        {
            Mutex packageGate = EnterPackageGate(runtimeRoot);
            Mutex acceptanceGate = EnterAcceptanceGate(runtimeRoot);
            IntPtr runtimeJob = IntPtr.Zero;
            try
            {
            if (acceptanceGate != null)
            {
                if (File.Exists(Path.Combine(runtimeRoot, ".agent-hub-release-acceptance.closed")))
                    throw new InvalidOperationException("Release acceptance is closed; no later runtime may start");
                // Register before hashing/validation: cleanup also owns a WMI
                // launcher that has not reached Node or the instance lock yet.
                runtimeJob = CreateRuntimeJob(AcceptanceObjectName(runtimeRoot));
                LeaveAcceptanceGate(ref acceptanceGate);
            }
            string currentFile = Path.Combine(runtimeRoot, "current.json");
            EnsureRegularFile(currentFile, "Agent Hub current.json is missing or unsafe");
            Dictionary<string, object> pointer = ReadJsonObject(currentFile);
            string current = RequiredString(pointer, "current");
            if (current == "." || current == ".." || !ReleaseIdPattern.IsMatch(current))
            {
                throw new InvalidOperationException("Agent Hub has no valid current runtime release");
            }

            string releasesRoot = Path.GetFullPath(Path.Combine(runtimeRoot, "releases"));
            EnsureDirectoryWithoutReparsePoint(releasesRoot, "Agent Hub releases directory is missing or unsafe");
            string releaseRoot = Path.GetFullPath(Path.Combine(releasesRoot, current));
            string releasePrefix = releasesRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!releaseRoot.StartsWith(releasePrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Agent Hub runtime release resolves outside releases");
            }
            EnsureDirectoryWithoutReparsePoint(releaseRoot, "Agent Hub runtime release is missing or unsafe");
            VerifyManifest(releaseRoot, current);

            string packageEntry = Path.Combine(releaseRoot, "src", "runtime", "runtime-package-handoff.mjs");
            if (ManifestDeclares(releaseRoot, "src/runtime/runtime-package-handoff.mjs"))
                ProbePackageAdmission(packageEntry, runtimeRoot);

            string server = Path.Combine(releaseRoot, "agent-hub-main.mjs");
            EnsureRegularFile(server, "Agent Hub runtime entry point is missing or unsafe");
            string node = FindNodeExecutable();
            if (checkOnly)
            {
                return 0;
            }

            SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            acceptanceGate = EnterAcceptanceGate(runtimeRoot);
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = QuoteArgument(server);
            start.WorkingDirectory = releaseRoot;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            ApplyReleaseAcceptanceEnvironment(runtimeRoot, start);
            if (runtimeJob == IntPtr.Zero) runtimeJob = CreateRuntimeJob();
            start.EnvironmentVariables["AGENT_HUB_CONFIG"] = Path.Combine(runtimeRoot, "config.json");
            start.EnvironmentVariables["AGENT_HUB_LAUNCHER"] = Assembly.GetExecutingAssembly().Location;
            start.EnvironmentVariables["AGENT_HUB_RUNTIME_ROOT"] = runtimeRoot;
            start.EnvironmentVariables["AGENT_HUB_RELEASE_ID"] = current;
            start.EnvironmentVariables["AGENT_HUB_HOST_PID"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            // The one-use native launch capability is not an application secret
            // and must not be inherited by provider children or public snapshots.
            start.EnvironmentVariables.Remove("AGENT_HUB_PACKAGE_LAUNCH_TOKEN");

                using (Process process = Process.Start(start))
                {
                    if (process == null)
                    {
                        throw new InvalidOperationException("Node.js did not start");
                    }
                    bool inJob;
                    IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob);
                    WriteLifetime(runtimeRoot, "node-start", process.Id, null, inJob);
                    LeaveAcceptanceGate(ref acceptanceGate);
                    LeaveAcceptanceGate(ref packageGate);
                    DeleteLegacyLaunchers(runtimeRoot);
                    process.WaitForExit();
                    WriteLifetime(runtimeRoot, "node-exit", process.Id, process.ExitCode, inJob);
                    return process.ExitCode;
                }
            }
            finally
            {
                LeaveAcceptanceGate(ref acceptanceGate);
                LeaveAcceptanceGate(ref packageGate);
                if (runtimeJob != IntPtr.Zero) CloseHandle(runtimeJob);
            }
        }

        private static Mutex EnterPackageGate(string root)
        {
            Mutex gate = new Mutex(false, AcceptanceObjectName(root) + ".package");
            try
            {
                try { if (!gate.WaitOne(0)) throw new InvalidOperationException("An exact package handoff owns runtime admission"); }
                catch (AbandonedMutexException) { /* Original operation is still checked by its continuation. */ }
                return gate;
            }
            catch { gate.Dispose(); throw; }
        }

        private static bool ManifestDeclares(string releaseRoot, string relative)
        {
            IEnumerable files = ReadJsonObject(Path.Combine(releaseRoot, "runtime-manifest.json"))["files"] as IEnumerable;
            if (files == null) return false;
            foreach (object value in files)
            {
                Dictionary<string, object> item = value as Dictionary<string, object>;
                if (item != null && RequiredString(item, "path") == relative) return true;
            }
            return false;
        }

        private static void ProbePackageAdmission(string entry, string root)
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = FindNodeExecutable();
            start.Arguments = QuoteArgument(entry) + " probe " + QuoteArgument(root);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardOutput = true;
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_BOOTSTRAP_HOST_PID"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_BOOTSTRAP_HOST_STARTED"] = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("Package admission readback did not start");
                child.StandardOutput.ReadToEnd();
                child.WaitForExit();
                if (child.ExitCode != 0) throw new InvalidOperationException("Original package operation refuses runtime admission");
            }
        }

        private static int PackageHandoff(string[] args)
        {
            string root = Path.GetFullPath(args[1]);
            string releaseId = args[2], operationId = args[3];
            if (!ReleaseIdPattern.IsMatch(releaseId) || releaseId == "." || releaseId == ".."
                || !Regex.IsMatch(operationId, "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"))
                throw new InvalidOperationException("Invalid package handoff identity");
            int nodePid = Int32.Parse(args[4], CultureInfo.InvariantCulture);
            int hostPid = Int32.Parse(args[5], CultureInfo.InvariantCulture);
            string releaseRoot = Path.Combine(root, "releases", releaseId);
            EnsureDirectoryWithoutReparsePoint(root, "Unsafe package runtime root");
            EnsureDirectoryWithoutReparsePoint(Path.Combine(root, "releases"), "Unsafe releases root");
            EnsureDirectoryWithoutReparsePoint(releaseRoot, "Unsafe package source release");
            VerifyManifest(releaseRoot, releaseId);
            string copyHash = ComputeSha256(Assembly.GetExecutingAssembly().Location);
            if (copyHash != ComputeSha256(Path.Combine(releaseRoot, "AgentHub.RuntimeHost.exe")))
                throw new InvalidOperationException("Package continuation is not the manifested Host");
            string entry = Path.Combine(releaseRoot, "src", "runtime", "runtime-package-handoff.mjs");
            if (!ManifestDeclares(releaseRoot, "src/runtime/runtime-package-handoff.mjs"))
                throw new InvalidOperationException("Package handoff entry is not manifested");
            EnsureRegularFile(entry, "Installed package handoff entry is unavailable");
            Mutex gate = EnterPackageGate(root);
            IntPtr job = IntPtr.Zero;
            try
            {
                job = OpenJobObject(4, false, "Local\\IIITYRAELIII.AgentHub." + hostPid.ToString(CultureInfo.InvariantCulture));
                if (job == IntPtr.Zero) throw new InvalidOperationException("Original Host job identity is unknown");
                bool continuationInJob;
                if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out continuationInJob) || continuationInJob)
                    throw new InvalidOperationException("Package continuation must be outside every old process job");
                long nodeStarted, hostStarted;
                using (Process oldNode = Process.GetProcessById(nodePid))
                using (Process oldHost = Process.GetProcessById(hostPid))
                {
                    foreach (IntPtr process in new IntPtr[] { oldNode.Handle, oldHost.Handle })
                    {
                        bool member;
                        if (!IsProcessInJob(process, job, out member) || !member)
                            throw new InvalidOperationException("Foreign or unknown package cohort");
                    }
                    // Force the handles and birth identities before the old owner
                    // is allowed to release admission. PID reuse cannot replace them.
                    nodeStarted = oldNode.StartTime.ToUniversalTime().Ticks;
                    hostStarted = oldHost.StartTime.ToUniversalTime().Ticks;
                    if (RunPackageStage(entry, root, operationId, "arm", nodePid, hostPid,
                        nodeStarted, hostStarted, ref gate) != 0) return 1;
                    if (!oldNode.WaitForExit(120000) || !oldHost.WaitForExit(120000))
                        throw new InvalidOperationException("Original cohort retirement remains unknown");
                }
                // Job accounting retains exited members while our own process
                // references remain open. Dispose them before observing zero;
                // keep the original Job handle and never re-open either PID.
                Stopwatch retirement = Stopwatch.StartNew();
                while (true)
                {
                    JobAccounting accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting,
                        (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero))
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "Original job retirement is unknown");
                    if (accounting.ActiveProcesses == 0) break;
                    if (retirement.ElapsedMilliseconds >= 45000)
                        throw new InvalidOperationException("Original job still contains writers or unknown references");
                    Thread.Sleep(25);
                }
                return RunPackageStage(entry, root, operationId, "continue", nodePid, hostPid,
                    nodeStarted, hostStarted, ref gate);
            }
            finally
            {
                if (job != IntPtr.Zero) CloseHandle(job);
                LeaveAcceptanceGate(ref gate);
            }
        }

        private static int RunPackageStage(string entry, string root, string operationId, string stage,
            int nodePid, int hostPid, long nodeStarted, long hostStarted, ref Mutex gate)
        {
            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = FindNodeExecutable();
            start.Arguments = QuoteArgument(entry) + " " + stage + " " + QuoteArgument(root) + " " + QuoteArgument(operationId);
            start.WorkingDirectory = Path.GetDirectoryName(entry);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_HOST_PID"] = Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_HOST_STARTED"] = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_OLD_NODE_PID"] = nodePid.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_OLD_HOST_PID"] = hostPid.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_OLD_NODE_STARTED"] = nodeStarted.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_OLD_HOST_STARTED"] = hostStarted.ToString(CultureInfo.InvariantCulture);
            start.EnvironmentVariables["AGENT_HUB_PACKAGE_COHORT_RETIRED"] = stage == "continue" ? "1" : "0";
            using (Process child = Process.Start(start))
            {
                if (child == null) throw new InvalidOperationException("Package continuation did not start");
                string line;
                bool released = false;
                while ((line = child.StandardOutput.ReadLine()) != null)
                {
                    if (line == "AGENT_HUB_PACKAGE_LAUNCH")
                    {
                        if (stage != "continue" || released || gate == null)
                            throw new InvalidOperationException("Duplicate package launch boundary");
                        LeaveAcceptanceGate(ref gate);
                        released = true;
                        child.StandardInput.WriteLine("AGENT_HUB_PACKAGE_GATE_RELEASED");
                        child.StandardInput.Flush();
                    }
                }
                child.WaitForExit();
                return child.ExitCode;
            }
        }

        private static int StartIndependent(string runtimeRoot)
        {
            // Cold start only. Controlled replacements must remain owned until
            // their exact lock/ready proof, using the direct detached invocation.
            if (!String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("AGENT_HUB_RESTART_OPERATION_ID")))
                throw new InvalidOperationException("Independent cold start cannot replace a managed restart operation");
            string executable = Assembly.GetExecutingAssembly().Location;
            uint parentPid;
            ProcessInformation child = CreateIndependentProcess(executable, "", runtimeRoot, out parentPid);
            bool inJob;
            if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob)) inJob = true;
            try { WriteLifetime(runtimeRoot, "independent-created", (int)child.ProcessId, null, inJob, parentPid, false); }
            finally { CloseHandle(child.Thread); CloseHandle(child.Process); }
            return 0;
        }

        private static void WriteLifetime(string runtimeRoot, string stage, int childPid, int? exitCode, bool inJob,
            uint? externalParentPid = null, bool? childInJobBeforeResume = null)
        {
            try
            {
                string directory = Path.Combine(runtimeRoot, "data");
                Directory.CreateDirectory(directory);
                var record = new Dictionary<string, object> {
                    { "at", DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) },
                    { "stage", stage }, { "hostPid", Process.GetCurrentProcess().Id },
                    { "childPid", childPid }, { "exitCode", exitCode }, { "hostInJob", inJob }
                };
                if (externalParentPid.HasValue) record["externalParentPid"] = externalParentPid.Value;
                if (childInJobBeforeResume.HasValue) record["childInJobBeforeResume"] = childInJobBeforeResume.Value;
                File.AppendAllText(Path.Combine(directory, "runtime-host-lifetime.jsonl"),
                    new JavaScriptSerializer().Serialize(record) + Environment.NewLine, new UTF8Encoding(false));
            }
            catch { /* Diagnostics must not change runtime ownership or outcome. */ }
        }

        // WMI replacement does not inherit the caller's environment. Persist the
        // opt-in in the isolated root so every generation receives the same
        // empty provider homes and cannot inherit production config overrides.
        private static Dictionary<string, object> ReadAcceptanceMarker(string runtimeRoot)
        {
            string markerFile = Path.Combine(runtimeRoot, ".agent-hub-release-acceptance.json");
            if (!File.Exists(markerFile)) return null;
            EnsurePathWithoutReparsePoints(runtimeRoot, markerFile);
            Dictionary<string, object> marker = ReadJsonObject(markerFile);
            object version;
            object ownerRoot;
            object id;
            if (!marker.TryGetValue("schemaVersion", out version) || (Convert.ToInt32(version) != 1 && Convert.ToInt32(version) != 2)
                || !marker.TryGetValue("root", out ownerRoot)
                || !String.Equals(Path.GetFullPath(Convert.ToString(ownerRoot)), Path.GetFullPath(runtimeRoot), StringComparison.OrdinalIgnoreCase)
                || !marker.TryGetValue("id", out id) || String.IsNullOrWhiteSpace(Convert.ToString(id)))
            {
                throw new InvalidOperationException("Release acceptance root identity mismatch");
            }
            if (Convert.ToInt32(version) == 2)
            {
                EnsureAcceptanceFile(runtimeRoot, markerFile);
                RequireAcceptanceRoot(marker, "root", runtimeRoot);
                if (RequiredString(marker, "profile") != "recording") throw new InvalidOperationException("Unknown release acceptance profile");
                RequireAcceptanceRoot(marker, "recordingRoot", Path.Combine(runtimeRoot, "recording"));
            }
            string productionRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentHub");
            if (String.Equals(Path.GetFullPath(runtimeRoot), Path.GetFullPath(productionRoot), StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Release acceptance cannot use the production root");
            }
            return marker;
        }

        private static void RequireAcceptanceRoot(Dictionary<string, object> value, string key, string expected)
        {
            string actual = RequiredString(value, key);
            if (!Path.IsPathRooted(actual)
                || !String.Equals(Path.GetPathRoot(actual), Path.GetPathRoot(expected), StringComparison.OrdinalIgnoreCase)
                || !String.Equals(Path.GetFullPath(actual), Path.GetFullPath(expected), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("Recording acceptance root identity mismatch: " + key);
        }

        private static void EnsureAcceptanceDirectory(string directory)
        {
            for (DirectoryInfo current = new DirectoryInfo(directory); current != null; current = current.Parent)
                EnsureDirectoryWithoutReparsePoint(current.FullName, "Recording acceptance directory contains a reparse point or is missing");
        }

        private static void EnsureAcceptanceFile(string root, string file)
        {
            string prefix = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!Path.GetFullPath(file).StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Recording acceptance file escapes its root");
            EnsureAcceptanceDirectory(Path.GetDirectoryName(file));
            EnsureRegularFile(file, "Recording acceptance file is missing or contains a reparse point");
        }

        private static Dictionary<string, object> ReadVerifiedAcceptanceJson(string root, string file, string expectedHash)
        {
            if (!Regex.IsMatch(expectedHash, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)) throw new InvalidOperationException("Invalid recording acceptance hash");
            EnsureAcceptanceFile(root, file);
            byte[] bytes = File.ReadAllBytes(file);
            using (SHA256 sha = SHA256.Create())
            {
                string actual = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
                if (actual != expectedHash) throw new InvalidOperationException("Recording acceptance hash mismatch: " + Path.GetFileName(file));
            }
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            Dictionary<string, object> value = serializer.DeserializeObject(Encoding.UTF8.GetString(bytes)) as Dictionary<string, object>;
            if (value == null) throw new InvalidOperationException("Invalid recording acceptance JSON object");
            return value;
        }

        private static string VerifyRecordingAcceptance(string runtimeRoot, Dictionary<string, object> acceptance)
        {
            string recordingRoot = Path.Combine(runtimeRoot, "recording");
            EnsureAcceptanceDirectory(recordingRoot);
            string providerHash = RequiredString(acceptance, "recordingMarkerSha256");
            string projectsHash = RequiredString(acceptance, "projectConfigurationSha256");
            Dictionary<string, object> provider = ReadVerifiedAcceptanceJson(runtimeRoot, Path.Combine(recordingRoot, "recording-provider.json"), providerHash);
            Dictionary<string, object> preparation = ReadVerifiedAcceptanceJson(runtimeRoot, Path.Combine(runtimeRoot, "contour-preparation.json"), RequiredString(acceptance, "preparationSha256"));
            Dictionary<string, object> projects = ReadVerifiedAcceptanceJson(runtimeRoot, Path.Combine(recordingRoot, "recording-projects.json"), projectsHash);
            Dictionary<string, object> config = ReadVerifiedAcceptanceJson(runtimeRoot, Path.Combine(runtimeRoot, "config.json"), RequiredString(acceptance, "configSha256"));
            RequireAcceptanceRoot(provider, "root", recordingRoot);
            RequireAcceptanceRoot(preparation, "root", runtimeRoot);
            RequireAcceptanceRoot(projects, "root", recordingRoot);
            RequireAcceptanceRoot(config, "dataDir", Path.Combine(runtimeRoot, "data"));
            object raw;
            Dictionary<string, object> profile = config.TryGetValue("testContourRecording", out raw) ? raw as Dictionary<string, object> : null;
            if (profile == null) throw new InvalidOperationException("Recording acceptance config has no profile");
            RequireAcceptanceRoot(profile, "root", recordingRoot);
            if (!profile.TryGetValue("schemaVersion", out raw) || Convert.ToInt32(raw) != 1
                || !provider.TryGetValue("schemaVersion", out raw) || Convert.ToInt32(raw) != 1
                || RequiredString(provider, "kind") != "literal-recording-provider" || RequiredString(provider, "externalEffects") != "deny"
                || !preparation.TryGetValue("schemaVersion", out raw) || Convert.ToInt32(raw) != 1
                || RequiredString(preparation, "kind") != "owned-contour-preparation" || RequiredString(preparation, "phase") != "prepared"
                || !preparation.TryGetValue("bootable", out raw) || !(raw is bool) || (bool)raw
                || RequiredString(preparation, "recordingMarkerSha256") != providerHash || RequiredString(preparation, "configSha256") != projectsHash
                || !projects.TryGetValue("schemaVersion", out raw) || Convert.ToInt32(raw) != 1
                || RequiredString(projects, "kind") != "recording-project-configuration" || RequiredString(projects, "markerSha256") != providerHash)
                throw new InvalidOperationException("Recording acceptance profile identity mismatch");
            foreach (string database in new[] { "journal.sqlite", "runtime.sqlite", "message-command-ledger.sqlite" })
                EnsureAcceptanceFile(runtimeRoot, Path.Combine(runtimeRoot, "data", database));
            return recordingRoot;
        }

        private static void ApplyReleaseAcceptanceEnvironment(string runtimeRoot, ProcessStartInfo start)
        {
            Dictionary<string, object> acceptance = ReadAcceptanceMarker(runtimeRoot);
            if (acceptance == null) return;
            if (File.Exists(Path.Combine(runtimeRoot, ".agent-hub-release-acceptance.closed")))
                throw new InvalidOperationException("Release acceptance is closed; no later runtime may start");
            bool recording = Convert.ToInt32(acceptance["schemaVersion"]) == 2;
            string recordingRoot = recording ? VerifyRecordingAcceptance(runtimeRoot, acceptance) : null;
            Dictionary<string, string> system = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in new[] { "SystemRoot", "WINDIR", "SystemDrive", "PATH", "PATHEXT", "COMSPEC", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE" })
            {
                if (recording && (key == "PATH" || key == "SystemDrive")) continue;
                string value = start.EnvironmentVariables[key];
                if (value != null) system[key] = value;
            }
            start.EnvironmentVariables.Clear();
            foreach (KeyValuePair<string, string> entry in system) start.EnvironmentVariables[entry.Key] = entry.Value;
            if (recording)
            {
                // Node's Windows ACL/process owners invoke OS utilities by name.
                // Resolve their search path from Windows, never ambient PATH or homes.
                string systemDirectory = Environment.GetFolderPath(Environment.SpecialFolder.System);
                if (String.IsNullOrWhiteSpace(systemDirectory) || !Path.IsPathRooted(systemDirectory))
                    throw new InvalidOperationException("Windows system directory is unavailable for recording acceptance");
                string powershellDirectory = Path.Combine(systemDirectory, "WindowsPowerShell", "v1.0");
                EnsureAcceptanceDirectory(systemDirectory);
                EnsureAcceptanceDirectory(powershellDirectory);
                start.EnvironmentVariables["PATH"] = systemDirectory + Path.PathSeparator + powershellDirectory;
            }
            // ACL ownership is the actual process identity, independent of the
            // isolated profile paths and of caller-provided identity variables.
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                string owner = identity.Name;
                if (String.IsNullOrWhiteSpace(owner)) throw new InvalidOperationException("Acceptance runtime has no Windows owner identity");
                int separator = owner.LastIndexOf('\\');
                start.EnvironmentVariables["USERDOMAIN"] = separator >= 0 ? owner.Substring(0, separator) : "";
                start.EnvironmentVariables["USERNAME"] = separator >= 0 ? owner.Substring(separator + 1) : owner;
            }
            string home = Path.Combine(recordingRoot ?? runtimeRoot, "home");
            string temporary = Path.Combine(recordingRoot ?? runtimeRoot, recording ? "tmp" : "temp");
            if (recording)
            {
                foreach (string name in new[] { "home", "appdata", "localappdata", "tmp", "codex-home", "claude-home" })
                {
                    string directory = Path.Combine(recordingRoot, name);
                    if (Directory.Exists(directory)) EnsureAcceptanceDirectory(directory);
                    Directory.CreateDirectory(directory);
                    EnsureAcceptanceDirectory(directory);
                }
            }
            Directory.CreateDirectory(home);
            Directory.CreateDirectory(temporary);
            start.EnvironmentVariables["USERPROFILE"] = home;
            start.EnvironmentVariables["HOME"] = home;
            start.EnvironmentVariables["LOCALAPPDATA"] = recording ? Path.Combine(recordingRoot, "localappdata") : Path.Combine(home, "AppData", "Local");
            start.EnvironmentVariables["APPDATA"] = recording ? Path.Combine(recordingRoot, "appdata") : Path.Combine(home, "AppData", "Roaming");
            start.EnvironmentVariables["CODEX_HOME"] = recording ? Path.Combine(recordingRoot, "codex-home") : Path.Combine(home, ".codex");
            start.EnvironmentVariables["CLAUDE_CONFIG_DIR"] = recording ? Path.Combine(recordingRoot, "claude-home") : Path.Combine(home, ".claude");
            start.EnvironmentVariables["TEMP"] = temporary;
            start.EnvironmentVariables["TMP"] = temporary;
            start.EnvironmentVariables["AGENT_HUB_TEST_CONTOUR"] = "1";
            start.EnvironmentVariables["AGENT_HUB_TEST_CONTOUR_PROFILE"] = recording ? "recording" : "fake-codex";
            if (recording) start.EnvironmentVariables["AGENT_HUB_RECORDING_PROVIDER_ROOT"] = recordingRoot;
        }

        private static string AcceptanceObjectName(string root)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant()));
                return "Local\\IIITYRAELIII.AgentHub.Acceptance." + BitConverter.ToString(digest).Replace("-", "");
            }
        }

        private static Mutex EnterAcceptanceGate(string root)
        {
            if (ReadAcceptanceMarker(root) == null) return null;
            Mutex gate = new Mutex(false, AcceptanceObjectName(root) + ".gate");
            try
            {
                try { if (!gate.WaitOne(5000)) throw new InvalidOperationException("Acceptance launch gate timed out"); }
                catch (AbandonedMutexException) { /* ownership is acquired */ }
                return gate;
            }
            catch { gate.Dispose(); throw; }
        }

        private static void LeaveAcceptanceGate(ref Mutex gate)
        {
            if (gate == null) return;
            gate.ReleaseMutex();
            gate.Dispose();
            gate = null;
        }

        private static void CloseReleaseAcceptance(string root)
        {
            Mutex gate = EnterAcceptanceGate(root);
            if (gate == null) throw new InvalidOperationException("Missing acceptance ownership marker");
            IntPtr job = IntPtr.Zero;
            try
            {
                using (FileStream fence = new FileStream(Path.Combine(root, ".agent-hub-release-acceptance.closed"), FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read))
                {
                    fence.WriteByte(1);
                    fence.Flush(true);
                }
                job = CreateJobObject(IntPtr.Zero, AcceptanceObjectName(root));
                if (job == IntPtr.Zero || !TerminateJobObject(job, 1))
                    throw new InvalidOperationException("Acceptance process job could not be stopped: " + Marshal.GetLastWin32Error());
                DateTime deadline = DateTime.UtcNow.AddSeconds(5);
                for (;;)
                {
                    JobAccounting accounting;
                    if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero))
                        throw new InvalidOperationException("Acceptance process job could not be verified");
                    if (accounting.ActiveProcesses == 0) break;
                    if (DateTime.UtcNow >= deadline) throw new InvalidOperationException("Acceptance process job still contains live processes");
                    Thread.Sleep(25);
                }
            }
            finally
            {
                if (job != IntPtr.Zero) CloseHandle(job);
                LeaveAcceptanceGate(ref gate);
            }
        }

        private static IntPtr CreateRuntimeJob(string acceptanceName = null)
        {
            string name = acceptanceName ?? "Local\\IIITYRAELIII.AgentHub." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture);
            IntPtr job = CreateJobObject(IntPtr.Zero, name);
            if (job == IntPtr.Zero)
            {
                throw new InvalidOperationException("Agent Hub process job could not be created: " + Marshal.GetLastWin32Error());
            }
            try
            {
                if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                {
                    if (acceptanceName != null) throw new InvalidOperationException("Acceptance launcher could not join its owned process job");
                    CloseHandle(job);
                    return IntPtr.Zero;
                }
                return job;
            }
            catch
            {
                CloseHandle(job);
                throw;
            }
        }

        private static void VerifyManifest(string releaseRoot, string releaseId)
        {
            string manifestFile = Path.Combine(releaseRoot, "runtime-manifest.json");
            EnsureRegularFile(manifestFile, "Agent Hub runtime manifest is missing or unsafe");
            Dictionary<string, object> manifest = ReadJsonObject(manifestFile);
            if (!String.Equals(RequiredString(manifest, "releaseId"), releaseId, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Agent Hub runtime manifest does not match current.json");
            }
            Dictionary<string, object> package = ReadJsonObject(Path.Combine(releaseRoot, "package.json"));
            if (!String.Equals(RequiredString(manifest, "version"), RequiredString(package, "version"), StringComparison.Ordinal))
            {
                throw new InvalidOperationException("Agent Hub runtime manifest version does not match package.json");
            }

            object filesValue;
            if (!manifest.TryGetValue("files", out filesValue))
            {
                throw new InvalidOperationException("Agent Hub runtime manifest has no files");
            }
            IEnumerable files = filesValue as IEnumerable;
            if (files == null)
            {
                throw new InvalidOperationException("Agent Hub runtime manifest files are invalid");
            }

            string releasePrefix = releaseRoot.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            int count = 0;
            foreach (object value in files)
            {
                Dictionary<string, object> item = value as Dictionary<string, object>;
                if (item == null)
                {
                    throw new InvalidOperationException("Agent Hub runtime manifest entry is invalid");
                }
                string relative = RequiredString(item, "path").Replace('/', Path.DirectorySeparatorChar);
                ValidateRelativePath(relative);
                string target = Path.GetFullPath(Path.Combine(releaseRoot, relative));
                if (!target.StartsWith(releasePrefix, StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException("Agent Hub runtime manifest path escapes the release");
                }
                EnsurePathWithoutReparsePoints(releaseRoot, target);
                EnsureRegularFile(target, "Agent Hub runtime file is missing or unsafe: " + relative);
                long expectedBytes = Convert.ToInt64(item["bytes"], CultureInfo.InvariantCulture);
                FileInfo info = new FileInfo(target);
                if (info.Length != expectedBytes)
                {
                    throw new InvalidOperationException("Agent Hub runtime size mismatch: " + relative);
                }
                string expectedHash = RequiredString(item, "sha256").ToLowerInvariant();
                string actualHash = ComputeSha256(target);
                if (!String.Equals(expectedHash, actualHash, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException("Agent Hub runtime hash mismatch: " + relative);
                }
                count += 1;
            }
            if (count == 0)
            {
                throw new InvalidOperationException("Agent Hub runtime manifest is empty");
            }
        }

        private static void ValidateRelativePath(string relative)
        {
            if (String.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative))
            {
                throw new InvalidOperationException("Agent Hub runtime manifest contains an invalid path");
            }
            string[] parts = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            foreach (string part in parts)
            {
                if (part.Length == 0 || part == "." || part == ".." || part.IndexOf(':') >= 0)
                {
                    throw new InvalidOperationException("Agent Hub runtime manifest contains an invalid path");
                }
            }
        }

        private static void EnsurePathWithoutReparsePoints(string root, string target)
        {
            string relative = target.Substring(root.TrimEnd(Path.DirectorySeparatorChar).Length)
                .TrimStart(Path.DirectorySeparatorChar);
            string current = root;
            string[] parts = relative.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            for (int index = 0; index < parts.Length - 1; index += 1)
            {
                current = Path.Combine(current, parts[index]);
                EnsureDirectoryWithoutReparsePoint(current, "Agent Hub runtime path contains a reparse point");
            }
        }

        private static void EnsureDirectoryWithoutReparsePoint(string path, string message)
        {
            if (!Directory.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static void EnsureRegularFile(string path, string message)
        {
            if (!File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidOperationException(message);
            }
        }

        private static Dictionary<string, object> ReadJsonObject(string path)
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = Int32.MaxValue;
            Dictionary<string, object> value = serializer.DeserializeObject(File.ReadAllText(path, Encoding.UTF8))
                as Dictionary<string, object>;
            if (value == null)
            {
                throw new InvalidOperationException("Invalid JSON object: " + Path.GetFileName(path));
            }
            return value;
        }

        private static string RequiredString(Dictionary<string, object> value, string key)
        {
            object raw;
            string result = value.TryGetValue(key, out raw) ? raw as string : null;
            if (String.IsNullOrWhiteSpace(result))
            {
                throw new InvalidOperationException("Missing JSON property: " + key);
            }
            return result;
        }

        private static string ComputeSha256(string path)
        {
            using (FileStream stream = File.OpenRead(path))
            using (SHA256 hash = SHA256.Create())
            {
                byte[] value = hash.ComputeHash(stream);
                StringBuilder result = new StringBuilder(value.Length * 2);
                foreach (byte item in value)
                {
                    result.Append(item.ToString("x2", CultureInfo.InvariantCulture));
                }
                return result.ToString();
            }
        }

        private static string FindNodeExecutable()
        {
            List<string> candidates = new List<string>();
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            foreach (string raw in pathValue.Split(Path.PathSeparator))
            {
                string directory = Environment.ExpandEnvironmentVariables(raw.Trim().Trim('"'));
                if (directory.Length > 0)
                {
                    candidates.Add(Path.Combine(directory, "node.exe"));
                }
            }
            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            if (!String.IsNullOrWhiteSpace(programFiles))
            {
                candidates.Add(Path.Combine(programFiles, "nodejs", "node.exe"));
            }
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (!String.IsNullOrWhiteSpace(localAppData))
            {
                candidates.Add(Path.Combine(localAppData, "Programs", "nodejs", "node.exe"));
            }
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            throw new FileNotFoundException("Node.js executable was not found");
        }

        private static void InstallAutostart(string runtimeRoot)
        {
            string executable = Assembly.GetExecutingAssembly().Location;
            if (!String.Equals(
                Path.GetDirectoryName(executable).TrimEnd(Path.DirectorySeparatorChar),
                runtimeRoot,
                StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("RuntimeHost must be installed before enabling autostart");
            }

            string startup = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
            string shortcutPath = Path.Combine(startup, AutostartShortcutName);
            Type shellType = Type.GetTypeFromProgID("WScript.Shell");
            if (shellType == null)
            {
                throw new InvalidOperationException("Windows shortcut service is unavailable");
            }
            object shell = null;
            object shortcut = null;
            try
            {
                shell = Activator.CreateInstance(shellType);
                shortcut = shellType.InvokeMember(
                    "CreateShortcut",
                    BindingFlags.InvokeMethod,
                    null,
                    shell,
                    new object[] { shortcutPath });
                Type shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { executable });
                shortcutType.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] { String.Empty });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { runtimeRoot });
                shortcutType.InvokeMember("WindowStyle", BindingFlags.SetProperty, null, shortcut, new object[] { 7 });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Agent Hub" });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { executable + ",0" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            finally
            {
                if (shortcut != null && Marshal.IsComObject(shortcut)) Marshal.FinalReleaseComObject(shortcut);
                if (shell != null && Marshal.IsComObject(shell)) Marshal.FinalReleaseComObject(shell);
            }
            if (!File.Exists(shortcutPath))
            {
                throw new InvalidOperationException("Agent Hub autostart shortcut was not created");
            }
        }

        private static void DeleteLegacyLaunchers(string runtimeRoot)
        {
            foreach (string legacy in new[] { "launch.vbs", "runtime-launch.vbs", "launch.ps1" })
            {
                string target = Path.Combine(runtimeRoot, legacy);
                if (File.Exists(target)) File.Delete(target);
            }
        }

        private static string QuoteArgument(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void WriteFailure(string runtimeRoot, Exception error)
        {
            try
            {
                Directory.CreateDirectory(runtimeRoot);
                File.AppendAllText(
                    Path.Combine(runtimeRoot, "launcher-error.log"),
                    DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture) + " " + error + Environment.NewLine,
                    Encoding.UTF8);
            }
            catch
            {
                // The launcher must fail closed even when diagnostics cannot be written.
            }
        }
    }
}
