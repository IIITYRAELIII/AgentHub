using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Exact retired-runtime custody only. Pointer/operation admission belongs to
// the runtime owner; this boundary never discovers candidates or recursively rm's.
public static class AgentHubSealedRuntimeRelease {
  [StructLayout(LayoutKind.Sequential)] private struct FT { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] private struct Info {
    public uint Attributes; public FT Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr security, uint c, uint f, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, IntPtr b, uint n);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle h, int c, ref uint disposition, uint size);
  private sealed class Dir {
    public string Path, Relative; public SafeFileHandle Handle; public bool Deleted;
  }
  private sealed class Asset { public string Relative, Hash; public long Bytes; public Info Snapshot; }
  private const uint Read = 0x80000000, Delete = 0x10000, Attr = 0x80, Reparse = 0x400, DirectoryBit = 0x10;
  private const int MaxFiles = 20000, MaxMetadataBytes = 4 * 1024 * 1024;
  private const long MaxFileBytes = 256L * 1024 * 1024;
  private static readonly StringComparer Case = StringComparer.OrdinalIgnoreCase;

  private static string Long(string p) {
    if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p;
    return p.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + p.Substring(2) : @"\\?\" + p;
  }
  private static Info Information(SafeFileHandle h) {
    Info i;
    if (h.IsInvalid || !GetFileInformationByHandle(h, out i)) throw new IOException("runtime-entry-unavailable:" + Marshal.GetLastWin32Error());
    if ((i.Attributes & Reparse) != 0) throw new IOException("runtime-reparse-refused");
    return i;
  }
  private static ulong Number(uint high, uint low) { return ((ulong)high << 32) | low; }
  private static void Streams(SafeFileHandle h, bool directory) {
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      bool found = GetFileInformationByHandleEx(h, 7, buffer, 65536);
      int error = Marshal.GetLastWin32Error();
      if (!found) {
        if (directory && error == 38) return;
        throw new IOException("runtime-streams-unavailable:" + error);
      }
      if (Marshal.ReadInt32(buffer, 0) != 0 || Marshal.ReadInt32(buffer, 4) != 14
          || Marshal.PtrToStringUni(IntPtr.Add(buffer, 24), 7) != "::$DATA"
          || (directory && Marshal.ReadInt64(buffer, 8) != 0)) throw new IOException("runtime-extra-stream");
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  private static SafeFileHandle Open(string p, bool directory, bool payload) {
    SafeFileHandle h = CreateFileW(p, Delete | Attr | (payload ? Read : 0), 1, IntPtr.Zero, 3,
      0x200000 | (directory ? 0x2000000u : 0), IntPtr.Zero);
    try {
      Info i = Information(h);
      if (((i.Attributes & DirectoryBit) != 0) != directory || (!directory && i.Links != 1)) throw new IOException("runtime-entry-type-or-links");
      Streams(h, directory);
      return h;
    } catch { h.Dispose(); throw; }
  }
  private static void DisposeEntry(SafeFileHandle h) {
    uint flags = 0x13; // accepted R15 disposition: DELETE|POSIX|IGNORE_READONLY
    if (!SetFileInformationByHandle(h, 21, ref flags, 4)) throw new IOException("runtime-delete-refused:" + Marshal.GetLastWin32Error());
  }
  private static string Hash(Stream stream) {
    using (SHA256 sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
  }
  private static string Relative(string value) {
    if (String.IsNullOrEmpty(value) || value.Length > 1024 || value.Contains("\\") || value.Contains(":")
        || value.IndexOfAny(new char[] {'\0', '<', '>', '"', '|', '?', '*'}) >= 0) throw new IOException("runtime-path-refused");
    foreach (char c in value) if (Char.IsControl(c)) throw new IOException("runtime-path-refused");
    foreach (string part in value.Split('/')) {
      if (part == "" || part == "." || part == ".." || part.Length > 255 || part.EndsWith(".", StringComparison.Ordinal)
          || part.EndsWith(" ", StringComparison.Ordinal)
          || Regex.IsMatch(part, "^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|$)", RegexOptions.IgnoreCase)) throw new IOException("runtime-path-refused");
    }
    if (Path.IsPathRooted(value)) throw new IOException("runtime-path-refused");
    return value;
  }
  private static string DataRelative(string value) {
    value = Relative(value);
    if (Case.Equals(value, "runtime-manifest.json") || value.StartsWith("runtime-manifest.json/", StringComparison.OrdinalIgnoreCase))
      throw new IOException("runtime-manifest-entry");
    return value;
  }
  private static void AddParents(HashSet<string> parents, string value) {
    while (value.LastIndexOf('/') >= 0) { value = value.Substring(0, value.LastIndexOf('/')); parents.Add(value); }
  }
  private static string Child(string root, string relative) { return root + "\\" + relative.Replace('/', '\\'); }
  private static bool Empty(string path) {
    using (IEnumerator<string> entries = System.IO.Directory.EnumerateFileSystemEntries(path).GetEnumerator()) return !entries.MoveNext();
  }
  private static void CheckFile(SafeFileHandle h, Asset expected) {
    Info i = Information(h);
    if ((i.Attributes & DirectoryBit) != 0 || i.Links != 1 || Number(i.SizeHigh, i.SizeLow) != (ulong)expected.Bytes)
      throw new IOException("runtime-asset-changed");
    Streams(h, false);
  }
  private static void CheckSnapshot(SafeFileHandle h, Asset asset) {
    CheckFile(h, asset);
    Info i = Information(h), old = asset.Snapshot;
    if (i.Volume != old.Volume || Number(i.IndexHigh, i.IndexLow) != Number(old.IndexHigh, old.IndexLow)
        || Number(i.Creation.High, i.Creation.Low) != Number(old.Creation.High, old.Creation.Low)
        || Number(i.Write.High, i.Write.Low) != Number(old.Write.High, old.Write.Low)
        || i.Attributes != old.Attributes) throw new IOException("runtime-asset-identity-changed");
  }
  private static string Outcome(string state, int files, long bytes) {
    return new JavaScriptSerializer().Serialize(new Dictionary<string, object> {
      {"status", state}, {"files", files}, {"logicalBytes", bytes},
    });
  }

  public static string Retire(string selectedRoot, string volume, string index, string birth,
    string manifestHash, string releaseId, bool allowPartial) {
    AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
    AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
    string fullRoot = Path.GetFullPath(selectedRoot);
    if (!Path.IsPathRooted(selectedRoot) || Case.Equals(fullRoot.TrimEnd('\\', '/'), Path.GetPathRoot(fullRoot).TrimEnd('\\', '/')))
      throw new IOException("runtime-root-path-refused");
    string root = Long(fullRoot.TrimEnd('\\', '/'));
    if (!Regex.IsMatch(manifestHash, "^[a-f0-9]{64}$") || !Regex.IsMatch(releaseId, "^[A-Za-z0-9._-]{1,160}$"))
      throw new IOException("runtime-manifest-binding-required");
    List<SafeFileHandle> ancestors = new List<SafeFileHandle>();
    List<Dir> directories = new List<Dir>();
    try {
      List<string> names = new List<string>();
      string parent = Path.GetDirectoryName(root);
      while (!String.IsNullOrEmpty(parent)) { names.Add(parent); string next = Path.GetDirectoryName(parent); if (next == parent) break; parent = next; }
      names.Reverse();
      foreach (string name in names) {
        SafeFileHandle h = CreateFileW(name, Attr, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
        ancestors.Add(h);
        if ((Information(h).Attributes & DirectoryBit) == 0) throw new IOException("runtime-ancestor-refused");
      }
      SafeFileHandle rootHandle = Open(root, true, false);
      directories.Add(new Dir { Path = root, Relative = "", Handle = rootHandle });
      Info rootInfo = Information(rootHandle);
      if (rootInfo.Volume != uint.Parse(volume, CultureInfo.InvariantCulture)
          || Number(rootInfo.IndexHigh, rootInfo.IndexLow) != ulong.Parse(index, CultureInfo.InvariantCulture)
          || Number(rootInfo.Creation.High, rootInfo.Creation.Low) != ulong.Parse(birth, CultureInfo.InvariantCulture)) throw new IOException("runtime-root-changed");
      string manifestPath = Child(root, "runtime-manifest.json");
      // A final-disposition crash can leave only the SAME empty root. Missing
      // manifest is never authority unless the caller retained original pruning.
      using (SafeFileHandle manifestHandle = CreateFileW(manifestPath, Delete | Attr | Read, 1, IntPtr.Zero, 3, 0x200000, IntPtr.Zero)) {
      if (manifestHandle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (error != 2 || !allowPartial || !Empty(root)) throw new IOException("runtime-manifest-unavailable:" + error);
        Streams(rootHandle, true); DisposeEntry(rootHandle);
        return Outcome("complete", 0, 0);
      }
      using (FileStream manifest = new FileStream(manifestHandle, FileAccess.Read)) {
        Asset manifestAsset = new Asset { Bytes = manifest.Length };
        CheckFile(manifestHandle, manifestAsset);
        manifestAsset.Snapshot = Information(manifestHandle);
        if (manifest.Length > MaxMetadataBytes || Hash(manifest) != manifestHash) throw new IOException("runtime-manifest-changed");
        manifest.Position = 0;
        string json;
        using (StreamReader reader = new StreamReader(manifest, new UTF8Encoding(false, true), true, 4096, true)) json = reader.ReadToEnd();
        JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = MaxMetadataBytes };
        Dictionary<string, object> document = serializer.DeserializeObject(json) as Dictionary<string, object>;
        if (document == null || !document.ContainsKey("releaseId") || (string)document["releaseId"] != releaseId) throw new IOException("runtime-release-changed");
        object[] entries = document.ContainsKey("files") ? document["files"] as object[] : null;
        if (entries == null || entries.Length > MaxFiles) throw new IOException("runtime-manifest-budget");
        Dictionary<string, Asset> files = new Dictionary<string, Asset>(Case);
        HashSet<string> expectedDirectories = new HashSet<string>(Case);
        long total = 0;
        foreach (object entry in entries) {
          Dictionary<string, object> value = entry as Dictionary<string, object>;
          if (value == null) throw new IOException("runtime-manifest-entry");
          string relative = DataRelative((string)value["path"]), hash = (string)value["sha256"];
          if (!(value["bytes"] is int) && !(value["bytes"] is long)) throw new IOException("runtime-manifest-entry");
          long bytes = Convert.ToInt64(value["bytes"], CultureInfo.InvariantCulture);
          if (Case.Equals(relative, "runtime-manifest.json") || files.ContainsKey(relative) || bytes < 0 || bytes > MaxFileBytes
              || !Regex.IsMatch(hash, "^[a-f0-9]{64}$")) throw new IOException("runtime-manifest-entry");
          files.Add(relative, new Asset { Relative = relative, Hash = hash, Bytes = bytes });
          total += bytes;
          AddParents(expectedDirectories, relative);
        }
        if (total > 8L * 1024 * 1024 * 1024) throw new IOException("runtime-manifest-byte-budget");
        if (document.ContainsKey("directories")) {
          object[] declared = document["directories"] as object[];
          if (declared == null || declared.Length > MaxFiles) throw new IOException("runtime-directory-budget");
          HashSet<string> unique = new HashSet<string>(Case);
          foreach (object value in declared) {
            string relative = DataRelative((string)value);
            if (!unique.Add(relative)) throw new IOException("runtime-directory-duplicate");
            expectedDirectories.Add(relative); AddParents(expectedDirectories, relative);
          }
        }
        foreach (string directory in expectedDirectories) if (files.ContainsKey(directory)) throw new IOException("runtime-path-type-conflict");
        if (expectedDirectories.Count > MaxFiles) throw new IOException("runtime-directory-budget");
        HashSet<string> foundFiles = new HashSet<string>(Case), foundDirectories = new HashSet<string>(Case);
        // Whole bounded metadata preflight, not a full body hash on every batch.
        // Exact bytes are hashed on EACH same held deletion handle below.
        for (int n = 0; n < directories.Count; n++) {
          Dir directory = directories[n];
          foreach (string child in System.IO.Directory.EnumerateFileSystemEntries(directory.Path)) {
            string relative = child.Substring(root.Length + 1).Replace('\\', '/');
            FileAttributes attributes = File.GetAttributes(child);
            if ((attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("runtime-reparse-refused");
            if ((attributes & FileAttributes.Directory) != 0) {
              if (!expectedDirectories.Contains(relative) || directories.Count >= MaxFiles + 1) throw new IOException("runtime-unexpected-directory");
              directories.Add(new Dir { Path = child, Relative = relative, Handle = Open(child, true, false) });
              foundDirectories.Add(relative);
            } else {
              if (Case.Equals(relative, "runtime-manifest.json")) continue;
              Asset asset;
              if (!files.TryGetValue(relative, out asset)) throw new IOException("runtime-unexpected-file");
              using (SafeFileHandle h = Open(child, false, true)) {
                CheckFile(h, asset); asset.Snapshot = Information(h);
              }
              foundFiles.Add(relative);
            }
          }
        }
        if (!allowPartial && (foundFiles.Count != files.Count || foundDirectories.Count != expectedDirectories.Count)) throw new IOException("runtime-missing-unadmitted-data");
        List<string> ordered = new List<string>(foundFiles); ordered.Sort(Case);
        int removed = 0; long deletedBytes = 0;
        Stopwatch clock = Stopwatch.StartNew();
        foreach (string relative in ordered) {
          Asset asset = files[relative];
          if (removed >= 64 || (removed > 0 && (deletedBytes + asset.Bytes > MaxFileBytes || clock.ElapsedMilliseconds >= 10000))) break;
          using (SafeFileHandle h = Open(Child(root, relative), false, true))
          using (FileStream stream = new FileStream(h, FileAccess.Read)) {
            CheckSnapshot(h, asset);
            if (Hash(stream) != asset.Hash) throw new IOException("runtime-asset-hash-changed");
            CheckSnapshot(h, asset); DisposeEntry(h);
          }
          removed++; deletedBytes += asset.Bytes;
        }
        for (int i = directories.Count - 1; i > 0; i--) {
          Dir directory = directories[i];
          if (Empty(directory.Path)) {
            Streams(directory.Handle, true); DisposeEntry(directory.Handle); directory.Deleted = true; directory.Handle.Dispose();
          }
        }
        bool complete = ordered.Count == removed;
        if (complete) {
          foreach (string child in System.IO.Directory.EnumerateFileSystemEntries(root)) {
            if (!Case.Equals(child, manifestPath)) throw new IOException("runtime-late-unexpected-data:" + Path.GetFileName(child));
          }
          Streams(rootHandle, true); CheckSnapshot(manifestHandle, manifestAsset);
          DisposeEntry(manifestHandle); manifest.Dispose(); manifestHandle.Dispose(); DisposeEntry(rootHandle);
        }
        return Outcome(complete ? "complete" : "partial", removed, deletedBytes);
      }
      }
    } finally {
      for (int i = directories.Count - 1; i >= 0; i--) directories[i].Handle.Dispose();
      for (int i = ancestors.Count - 1; i >= 0; i--) ancestors[i].Dispose();
    }
  }
}
