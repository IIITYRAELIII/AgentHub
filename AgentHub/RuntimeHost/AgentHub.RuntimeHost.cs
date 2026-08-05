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
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

[assembly: AssemblyTitle("Agent Hub Runtime Host")]
[assembly: AssemblyDescription("Verified background launcher for Agent Hub Server")]
[assembly: AssemblyCompany("Dark Sanctuary Utilities")]
[assembly: AssemblyProduct("Agent Hub")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace AgentHub.RuntimeHost
{
    internal static class Program
    {
        private const string AutostartShortcutName = "Agent Hub.lnk";
        private static readonly Regex ReleaseIdPattern = new Regex(
            "^[A-Za-z0-9][A-Za-z0-9._-]*$",
            RegexOptions.CultureInvariant);

        [STAThread]
        private static int Main(string[] args)
        {
            string runtimeRoot = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar,
                Path.AltDirectorySeparatorChar);
            try
            {
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

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = node;
            start.Arguments = QuoteArgument(server);
            start.WorkingDirectory = releaseRoot;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            start.EnvironmentVariables["AGENT_HUB_CONFIG"] = Path.Combine(runtimeRoot, "config.json");
            start.EnvironmentVariables["AGENT_HUB_LAUNCHER"] = Assembly.GetExecutingAssembly().Location;
            start.EnvironmentVariables["AGENT_HUB_RUNTIME_ROOT"] = runtimeRoot;

            using (Process process = Process.Start(start))
            {
                if (process == null)
                {
                    throw new InvalidOperationException("Node.js did not start");
                }
                DeleteLegacyLaunchers(runtimeRoot);
                process.WaitForExit();
                return process.ExitCode;
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
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "Agent Hub runtime" });
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
