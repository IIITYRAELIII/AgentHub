using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
public static class AgentHubReleaseLockPublisher {
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

private static int Main(string[] args) { return PublishLockDirectoryMode(args); }
}
