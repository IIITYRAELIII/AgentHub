using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;

// Read-only lifetime custody. No copy, replacement, assignment or process stop.
public sealed class AgentHubCodexBundleCustody : IDisposable {
  [StructLayout(LayoutKind.Sequential)] private struct Info {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
      WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string p, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder b, uint size, uint flags);
  private readonly List<IDisposable> held = new List<IDisposable>();
  private readonly HashSet<string> directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

  private static string FinalPath(SafeFileHandle h) {
    StringBuilder b = new StringBuilder(512);
    uint length = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
    if (length >= b.Capacity) {
      b = new StringBuilder(checked((int)length + 1));
      length = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
    }
    if (length == 0 || length >= b.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error());
    string value = b.ToString();
    return value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + value.Substring(8)
      : value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value.Substring(4) : value;
  }
  private SafeFileHandle Open(string p, bool directory) {
    SafeFileHandle h = CreateFileW(p, directory ? 0x80u : 0x80000000u,
      directory ? 3u : 1u, IntPtr.Zero, 3, directory ? 0x2200000u : 0x200000u, IntPtr.Zero);
    if (h.IsInvalid) { int error = Marshal.GetLastWin32Error(); h.Dispose(); throw new Win32Exception(error); }
    try {
      Info info;
      if (!GetFileInformationByHandle(h, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
      if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) != directory
        || !String.Equals(Path.GetFullPath(p), FinalPath(h), StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Codex bundle path changed or is a reparse point");
      return h;
    } catch { h.Dispose(); throw; }
  }
  private void Directory(string p) {
    if (directories.Add(p)) held.Add(Open(p, true));
  }
  public static AgentHubCodexBundleCustody Acquire(string root, string boundary, string[] names, string[] hashes) {
    AgentHubCodexBundleCustody lease = new AgentHubCodexBundleCustody();
    try {
      root = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
      boundary = Path.GetFullPath(boundary).TrimEnd(Path.DirectorySeparatorChar);
      if (!String.Equals(root, boundary, StringComparison.OrdinalIgnoreCase)
        && !root.StartsWith(boundary + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Codex bundle escapes its install root");
      if (names.Length == 0 || names.Length != hashes.Length) throw new InvalidDataException("Invalid Codex bundle binding");
      // Deny rename/delete of the path chain; allow sibling installations.
      for (string p = root; p != null; p = Path.GetDirectoryName(p)) {
        lease.Directory(p);
        if (String.Equals(p, boundary, StringComparison.OrdinalIgnoreCase)) break;
      }
      for (int i = 0; i < names.Length; i++) {
        string p = Path.GetFullPath(Path.Combine(root, names[i]));
        if (!p.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
          throw new InvalidDataException("Codex bundle member escapes its root");
        for (string d = Path.GetDirectoryName(p); d != root; d = Path.GetDirectoryName(d)) lease.Directory(d);
        SafeFileHandle handle = lease.Open(p, false);
        FileStream stream;
        try { stream = new FileStream(handle, FileAccess.Read); }
        catch { handle.Dispose(); throw; }
        lease.held.Add(stream);
        using (SHA256 hash = SHA256.Create()) {
          string actual = BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "");
          if (!String.Equals(actual, hashes[i], StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Codex bundle member SHA-256 changed");
        }
      }
      return lease;
    } catch { lease.Dispose(); throw; }
  }
  public void Dispose() {
    for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
    held.Clear();
  }
}
