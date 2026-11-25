using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
public static class AgentHubReleaseLockPublisher {
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetProcessTimes(IntPtr process, out long birth, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool MoveFileExW(string source, string destination, uint flags);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern uint GetFileAttributesW(string name);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern IntPtr FindFirstFileW(string pattern, out LockFindData data);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool FindNextFileW(IntPtr find, out LockFindData data);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool FindClose(IntPtr find);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string name, uint access,
            uint sharing, IntPtr security, uint creation, uint flags, IntPtr template);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct LockFindData
        {
            public uint Attributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME Created, Accessed, Written;
            public uint SizeHigh, SizeLow, Reserved0, Reserved1;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Name;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string AlternateName;
        }

        private static string LockAbsolutePath(string raw)
        {
            if (String.IsNullOrWhiteSpace(raw) || raw.IndexOf('\0') >= 0) throw new InvalidOperationException();
            string value = raw.Replace('/', '\\');
            if (value.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) value = "\\\\" + value.Substring(8);
            else if (value.StartsWith("\\\\?\\", StringComparison.Ordinal)) value = value.Substring(4);
            bool drive = Regex.IsMatch(value, "^[A-Za-z]:\\\\", RegexOptions.CultureInvariant);
            bool unc = value.StartsWith("\\\\", StringComparison.Ordinal);
            if (!drive && !unc) throw new InvalidOperationException();
            string[] pieces = value.Split('\\');
            int first = unc ? 2 : 1;
            if (unc && pieces.Length < 5) throw new InvalidOperationException();
            for (int index = first; index < pieces.Length; index++)
                if (pieces[index].Length == 0 || pieces[index] == "." || pieces[index] == "..") throw new InvalidOperationException();
            return value;
        }

        private static string ExtendedLockPath(string value)
        {
            return value.StartsWith("\\\\", StringComparison.Ordinal) ? "\\\\?\\UNC\\" + value.Substring(2) : "\\\\?\\" + value;
        }

        private static void VerifyReadyLockOwner(string ready)
        {
            string nativeReady = ExtendedLockPath(ready);
            uint attributes = GetFileAttributesW(nativeReady);
            if (attributes == UInt32.MaxValue || (attributes & 0x10) == 0 || (attributes & 0x400) != 0)
                throw new InvalidOperationException();
            LockFindData data;
            IntPtr find = FindFirstFileW(nativeReady + "\\*", out data);
            if (find == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
            string ownerName = null;
            try
            {
                do
                {
                    if (data.Name == "." || data.Name == "..") continue;
                    if (ownerName != null || (data.Attributes & (0x10 | 0x400)) != 0
                        || !Regex.IsMatch(data.Name, "^owner-[a-f0-9]{64}\\.json$", RegexOptions.CultureInvariant))
                        throw new InvalidOperationException();
                    ownerName = data.Name;
                } while (FindNextFileW(find, out data));
                int last = Marshal.GetLastWin32Error();
                if (last != 18) throw new Win32Exception(last);
            }
            finally { FindClose(find); }
            if (ownerName == null) throw new InvalidOperationException();
            Dictionary<string, object> owner;
            using (var handle = CreateFileW(nativeReady + "\\" + ownerName, 0x80000000, 1, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                using (var stream = new FileStream(handle, FileAccess.Read))
                using (var reader = new StreamReader(stream, new UTF8Encoding(false, true)))
                {
                    var serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = Int32.MaxValue;
                    owner = serializer.DeserializeObject(reader.ReadToEnd()) as Dictionary<string, object>;
                }
            }
            if (owner == null || !owner.ContainsKey("pid") || Convert.ToInt64(owner["pid"]) < 1
                || !owner.ContainsKey("createdAt") || !owner.ContainsKey("leaseExpiresAt") || owner.ContainsKey("releasedAt"))
                throw new InvalidOperationException();
            RequiredString(owner, "processInstanceId");
            string token = RequiredString(owner, "token");
            using (SHA256 sha = SHA256.Create())
            {
                string digest = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(token))).Replace("-", "").ToLowerInvariant();
                if (ownerName != "owner-" + digest + ".json") throw new InvalidOperationException();
            }
        }

        private static int PublishLockDirectoryMode(string[] args)
        {
            var result = new Dictionary<string, object> { { "protocol", 1 }, { "status", "refused" } };
            int exit = 2;
            try
            {
                if (args.Length != 1) throw new InvalidOperationException();
                string input;
                using (var reader = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true))) input = reader.ReadToEnd();
                var serializer = new JavaScriptSerializer(); serializer.MaxJsonLength = Int32.MaxValue;
                var request = serializer.DeserializeObject(input) as Dictionary<string, object>;
                if (request == null || request.Count != 3 || !request.ContainsKey("protocol") || Convert.ToInt32(request["protocol"]) != 1)
                    throw new InvalidOperationException();
                string ready = LockAbsolutePath(RequiredString(request, "readyPath"));
                string canonical = LockAbsolutePath(RequiredString(request, "canonicalPath"));
                if (!canonical.EndsWith(".lock", StringComparison.OrdinalIgnoreCase)
                    || !ready.StartsWith(canonical + ".ready-", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException();
                Guid uuid;
                string suffix = ready.Substring(canonical.Length + 7);
                if (!Guid.TryParseExact(suffix, "D", out uuid)
                    || !String.Equals(ready.Substring(0, ready.LastIndexOf('\\')), canonical.Substring(0, canonical.LastIndexOf('\\')), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException();
                VerifyReadyLockOwner(ready);
                if (!MoveFileExW(ExtendedLockPath(ready), ExtendedLockPath(canonical), 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
                result["status"] = "published";
                exit = 0;
            }
            catch (Win32Exception error) { result["nativeError"] = error.NativeErrorCode; }
            catch { result["error"] = "INVALID_LOCK_PUBLICATION"; }
            // No lifetime/logger, host startup, mutex or provider path is entered.
            try
            {
                using (var writer = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)))
                    writer.WriteLine(new JavaScriptSerializer().Serialize(result));
            }
            catch { return 1; } // Publication may already have happened: caller must not replay.
            return exit;
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

        private static int InspectLockProcess()
        {
            try
            {
                string input = Console.ReadLine();
                var serializer = new JavaScriptSerializer();
                var request = serializer.DeserializeObject(input) as Dictionary<string, object>;
                if (request == null || request.Count != 2 || Convert.ToInt32(request["protocol"]) != 1)
                    throw new InvalidOperationException();
                uint processId = Convert.ToUInt32(request["processId"]);
                IntPtr handle = OpenProcess(0x101000, false, processId);
                if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                try
                {
                    long birth, exit, kernel, user;
                    if (!GetProcessTimes(handle, out birth, out exit, out kernel, out user))
                        throw new Win32Exception(Marshal.GetLastWin32Error());
                    uint state = WaitForSingleObject(handle, 0);
                    if (state != 0 && state != 258) throw new InvalidOperationException();
                    Console.WriteLine(serializer.Serialize(new Dictionary<string, object> {
                        { "protocol", 1 }, { "status", "observed" }, { "processId", processId },
                        { "birthFileTime", birth.ToString() }, { "alive", state == 258 }
                    }));
                }
                finally { CloseHandle(handle); }
                return 0;
            }
            catch { Console.WriteLine("{\"protocol\":1,\"status\":\"unavailable\"}"); return 2; }
        }

        private const uint WaitTimeout = 258;
        private const uint ProcessQueryAndWait = 0x101000;
        private const uint KillOnClose = 0x2000;

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct TaskStartup {
            public uint Size;
            public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
            public short ShowWindow, ReservedSize;
            public IntPtr ReservedPointer, Input, Output, Error;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct TaskStartupEx {
            public TaskStartup Startup;
            public IntPtr Attributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TaskProcess {
            public IntPtr Process, Thread;
            public uint ProcessId, ThreadId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TaskJobBasicLimit {
            public long ProcessTime, JobTime;
            public uint Flags;
            public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TaskJobLimits {
            public TaskJobBasicLimit Basic;
            public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
            public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct TaskJobAccounting {
            public long UserTime, KernelTime, IntervalUserTime, IntervalKernelTime;
            public uint PageFaults, Total, Active, Terminated;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int kind, ref TaskJobLimits value, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool QueryInformationJobObject(IntPtr job, int kind, out TaskJobAccounting value,
            uint length, IntPtr returnedLength);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(IntPtr attributes, uint count,
            uint flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute,
            IntPtr value, UIntPtr size, IntPtr previous, IntPtr returnedLength);
        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(IntPtr attributes);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr GetStdHandle(int handle);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target,
            out IntPtr result, uint access, bool inherit, uint options);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern bool CreateProcessW(string application, StringBuilder command,
            IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint creationFlags,
            IntPtr environment, string directory, ref TaskStartupEx startup, out TaskProcess process);

        private static long Birth(IntPtr process)
        {
            long birth, exit, kernel, user;
            if (!GetProcessTimes(process, out birth, out exit, out kernel, out user))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return birth;
        }

        private static IntPtr TaskChildHandle(int handle)
        {
            IntPtr current = GetCurrentProcess();
            IntPtr duplicate;
            if (!DuplicateHandle(current, GetStdHandle(handle), current, out duplicate, 0, true, 2))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return duplicate;
        }

        private static string QuoteTaskArgument(string text)
        {
            var quoted = new StringBuilder("\"");
            int slashes = 0;
            foreach (char value in text)
            {
                if (value == '\\') { slashes++; continue; }
                quoted.Append('\\', value == '"' ? slashes * 2 + 1 : slashes);
                quoted.Append(value);
                slashes = 0;
            }
            return quoted.Append('\\', slashes * 2).Append('"').ToString();
        }

        private static void WriteTaskJobRecord(string file, Dictionary<string, object> record)
        {
            string temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(record) + "\n");
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush(true);
            }
            try { File.Move(temporary, file); }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }

        private static uint ActiveTaskJobProcesses(IntPtr job)
        {
            TaskJobAccounting value;
            if (!QueryInformationJobObject(job, 1, out value,
                (uint)Marshal.SizeOf(typeof(TaskJobAccounting)), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return value.Active;
        }

        private static string TaskJobStop(IntPtr parent, string control, long elapsedMs, long timeoutMs)
        {
            uint state = WaitForSingleObject(parent, 0);
            if (state == 0) return "owner-ended";
            if (state != WaitTimeout) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (File.Exists(control)) return "cancelled";
            if (timeoutMs > 0 && elapsedMs >= timeoutMs) return "timed-out";
            return null;
        }

        private static int RunOwnedTaskJob(string[] args)
        {
            IntPtr owner = IntPtr.Zero, job = IntPtr.Zero;
            var created = new TaskProcess();
            var startup = new TaskStartupEx();
            IntPtr inheritedHandles = IntPtr.Zero, jobAttribute = IntPtr.Zero;
            bool initializedAttributes = false;
            try
            {
                Guid guard;
                uint parentPid;
                long parentBirth, timeout;
                if (args.Length < 7 || !Guid.TryParseExact(args[1], "D", out guard)
                    || !UInt32.TryParse(args[3], out parentPid) || parentPid == 0
                    || !Int64.TryParse(args[4], out parentBirth) || parentBirth <= 0
                    || !Int64.TryParse(args[5], out timeout) || timeout < 0)
                    throw new InvalidOperationException();
                string recordBase = LockAbsolutePath(args[2]);
                string executable = LockAbsolutePath(args[6]);
                owner = OpenProcess(ProcessQueryAndWait, false, parentPid);
                if (owner == IntPtr.Zero || Birth(owner) != parentBirth
                    || WaitForSingleObject(owner, 0) != WaitTimeout) throw new InvalidOperationException();

                job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
                if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                var limits = new TaskJobLimits();
                limits.Basic.Flags = KillOnClose; // No breakaway and no inherited Job handle.
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(TaskJobLimits))))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                startup.Startup.Size = (uint)Marshal.SizeOf(typeof(TaskStartupEx));
                startup.Startup.Flags = 0x100; // STARTF_USESTDHANDLES
                startup.Startup.Input = TaskChildHandle(-10);
                startup.Startup.Output = TaskChildHandle(-11);
                startup.Startup.Error = TaskChildHandle(-12);
                var attributeBytes = IntPtr.Zero;
                InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeBytes);
                if (attributeBytes == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                startup.Attributes = Marshal.AllocHGlobal(attributeBytes);
                if (!InitializeProcThreadAttributeList(startup.Attributes, 2, 0, ref attributeBytes))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                initializedAttributes = true;
                inheritedHandles = Marshal.AllocHGlobal(3 * IntPtr.Size);
                Marshal.WriteIntPtr(inheritedHandles, 0, startup.Startup.Input);
                Marshal.WriteIntPtr(inheritedHandles, IntPtr.Size, startup.Startup.Output);
                Marshal.WriteIntPtr(inheritedHandles, 2 * IntPtr.Size, startup.Startup.Error);
                jobAttribute = Marshal.AllocHGlobal(IntPtr.Size);
                Marshal.WriteIntPtr(jobAttribute, job);
                // Publish no runnable process until the exact Job owns it and the admission is durable.
                if (!UpdateProcThreadAttribute(startup.Attributes, 0, (UIntPtr)0x20002,
                    inheritedHandles, (UIntPtr)(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)
                    || !UpdateProcThreadAttribute(startup.Attributes, 0, (UIntPtr)0x2000D,
                    jobAttribute, (UIntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var command = new StringBuilder(QuoteTaskArgument(executable));
                for (int index = 7; index < args.Length; index++)
                    command.Append(' ').Append(QuoteTaskArgument(args[index]));
                // CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED.
                if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                    0x08080004, IntPtr.Zero, null, ref startup, out created))
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                var identity = new Dictionary<string, object> {
                    { "version", 1 }, { "guardId", args[1] }, { "parentPid", parentPid },
                    { "parentBirth", parentBirth.ToString() }, { "rootPid", created.ProcessId },
                    { "rootBirth", Birth(created.Process).ToString() },
                };
                // Recovery can take the same permit instead. Missing evidence
                // cannot mint another permit, and a fenced invocation cannot resume.
                File.Move(recordBase + ".permit", recordBase + ".started");
                var launch = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(recordBase + ".started", Encoding.UTF8));
                if (launch == null || launch.Count != 2 || !Object.Equals(launch["version"], 1)
                    || !Object.Equals(launch["guardId"], args[1])) throw new InvalidOperationException("Task launch permit differs");
                WriteTaskJobRecord(recordBase + ".admitted", identity);
                var clock = Stopwatch.StartNew();
                string reason = TaskJobStop(owner, recordBase + ".stop", 0, timeout);
                if (reason == null && ResumeThread(created.Thread) != 1)
                    throw new Win32Exception(Marshal.GetLastWin32Error());

                while (reason == null)
                {
                    uint rootState = WaitForSingleObject(created.Process, 0);
                    if (rootState == 0 && ActiveTaskJobProcesses(job) == 0) break;
                    if (rootState != 0 && rootState != WaitTimeout) throw new Win32Exception(Marshal.GetLastWin32Error());
                    reason = TaskJobStop(owner, recordBase + ".stop", clock.ElapsedMilliseconds, timeout);
                    if (reason == null)
                    {
                        if (rootState == WaitTimeout) WaitForSingleObject(created.Process, 15);
                        else Thread.Sleep(15);
                    }
                }
                if (reason != null && ActiveTaskJobProcesses(job) != 0)
                {
                    if (!TerminateJobObject(job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
                    var drain = Stopwatch.StartNew();
                    while (WaitForSingleObject(created.Process, 0) != 0 || ActiveTaskJobProcesses(job) != 0)
                    {
                        if (drain.ElapsedMilliseconds >= 10000) throw new InvalidOperationException("Job drain is unproven");
                        Thread.Sleep(15);
                    }
                }
                uint code;
                if (WaitForSingleObject(created.Process, 0) != 0 || ActiveTaskJobProcesses(job) != 0
                    || !GetExitCodeProcess(created.Process, out code))
                    throw new InvalidOperationException("Job retirement is unproven");
                identity.Add("activeProcesses", 0);
                identity.Add("reason", reason ?? "completed");
                identity.Add("exitCode", code);
                WriteTaskJobRecord(recordBase + ".finished", identity);
                return unchecked((int)code);
            }
            catch (Exception error)
            {
                var native = error as Win32Exception;
                Console.Error.WriteLine("Task Job evidence unavailable"
                    + (native == null ? "" : " (Win32 " + native.NativeErrorCode + ")"));
                return 1;
            }
            finally
            {
                if (initializedAttributes) DeleteProcThreadAttributeList(startup.Attributes);
                foreach (IntPtr pointer in new[] { startup.Attributes, inheritedHandles, jobAttribute })
                    if (pointer != IntPtr.Zero) Marshal.FreeHGlobal(pointer);
                foreach (IntPtr handle in new[] { created.Thread, created.Process,
                    startup.Startup.Input, startup.Startup.Output, startup.Startup.Error, job, owner })
                    if (handle != IntPtr.Zero) CloseHandle(handle);
            }
        }

private static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "--run-owned-task-job") return RunOwnedTaskJob(args);
    return args.Length == 1 && args[0] == "--inspect-lock-process"
        ? InspectLockProcess() : PublishLockDirectoryMode(args);
}
}
