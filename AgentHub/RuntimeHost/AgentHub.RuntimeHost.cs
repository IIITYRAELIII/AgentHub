using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Management;
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

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

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
                    SpawnIndependent(runtimeRoot);
                    return 0;
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
                WriteFailure(runtimeRoot, error);
                return 1;
            }
        }

        private static int Run(string runtimeRoot, bool checkOnly)
        {
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

                using (Process process = Process.Start(start))
                {
                    if (process == null)
                    {
                        throw new InvalidOperationException("Node.js did not start");
                    }
                    LeaveAcceptanceGate(ref acceptanceGate);
                    DeleteLegacyLaunchers(runtimeRoot);
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
            finally
            {
                LeaveAcceptanceGate(ref acceptanceGate);
                if (runtimeJob != IntPtr.Zero) CloseHandle(runtimeJob);
            }
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

        private static void SpawnIndependent(string runtimeRoot)
        {
            string executable = Assembly.GetExecutingAssembly().Location;
            using (ManagementClass processClass = new ManagementClass("Win32_Process"))
            using (ManagementBaseObject input = processClass.GetMethodParameters("Create"))
            {
                input["CommandLine"] = QuoteArgument(executable);
                input["CurrentDirectory"] = runtimeRoot;
                using (ManagementBaseObject output = processClass.InvokeMethod("Create", input, null))
                {
                    uint returnValue = Convert.ToUInt32(output["ReturnValue"], CultureInfo.InvariantCulture);
                    if (returnValue != 0)
                    {
                        throw new InvalidOperationException("Win32_Process.Create failed: " + returnValue);
                    }
                }
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
