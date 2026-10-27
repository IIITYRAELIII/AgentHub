using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

// Transport files only; never a recursive cleanup or an archive/evidence owner.
public static class AgentHubSealedTransportDelete {
  [StructLayout(LayoutKind.Sequential)]
  private struct FT { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Info {
    public uint Attributes; public FT Creation; public FT Access; public FT Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Disposition { public byte Delete; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr security, uint c, uint f, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle h, out Info i);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, IntPtr buffer, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool SetFileInformationByHandle(SafeFileHandle h, int c, ref Disposition d, uint size);

  private static void Check(SafeFileHandle h, string volume, string index, string size) {
    Info i;
    if (!GetFileInformationByHandle(h, out i)) throw new IOException("transport-identity-unavailable");
    ulong n = ((ulong)i.IndexHigh << 32) | i.IndexLow;
    ulong bytes = ((ulong)i.SizeHigh << 32) | i.SizeLow;
    if ((i.Attributes & 0x410) != 0 || i.Links != 1
        || i.Volume != uint.Parse(volume, CultureInfo.InvariantCulture)
        || n != ulong.Parse(index, CultureInfo.InvariantCulture)
        || bytes != ulong.Parse(size, CultureInfo.InvariantCulture)) throw new IOException("transport-identity-changed");
    IntPtr buffer = Marshal.AllocHGlobal(65536);
    try {
      // FileStreamInfo queries THIS handle. Any named stream, unsupported query,
      // extra record or oversized result refuses; no pathname ADS enumeration.
      if (!GetFileInformationByHandleEx(h, 7, buffer, 65536)) throw new IOException("transport-streams-unavailable");
      int next = Marshal.ReadInt32(buffer, 0), length = Marshal.ReadInt32(buffer, 4);
      if (next != 0 || length != 14 || Marshal.PtrToStringUni(IntPtr.Add(buffer, 24), 7) != "::$DATA")
        throw new IOException("transport-extra-stream");
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static void Delete(string path, string volume, string index, string size, string expectedHash) {
    List<SafeFileHandle> parents = new List<SafeFileHandle>();
    List<string> names = new List<string>();
    string parent = Path.GetDirectoryName(Path.GetFullPath(path));
    while (!String.IsNullOrEmpty(parent)) {
      names.Add(parent);
      string next = Path.GetDirectoryName(parent);
      if (next == parent) break;
      parent = next;
    }
    names.Reverse();
    try {
      foreach (string name in names) {
        // Pin each physical ancestor without delete sharing, and inspect the
        // no-follow directory handle. Logical compatibility aliases are resolved
        // by the artifact owner before entering this destructive boundary.
        SafeFileHandle directory = CreateFileW(name, 0x80, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero);
        parents.Add(directory);
        Info i;
        if (directory.IsInvalid || !GetFileInformationByHandle(directory, out i)
            || (i.Attributes & 0x410) != 0x10) throw new IOException("transport-ancestor-refused");
      }
    // GENERIC_READ|DELETE, SHARE_READ only: an existing writer/delete handle
    // refuses, and new writers/renames cannot modify the object during hashing.
    using (SafeFileHandle h = CreateFileW(path, 0x80010000, 1, IntPtr.Zero, 3, 0x200000, IntPtr.Zero)) {
      if (h.IsInvalid) throw new IOException("transport-open-refused:" + Marshal.GetLastWin32Error());
      Check(h, volume, index, size);
      using (FileStream bytes = new FileStream(h, FileAccess.Read)) {
        string hash;
        using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        if (hash != expectedHash) throw new IOException("transport-hash-changed");
        Check(h, volume, index, size);
        Disposition d = new Disposition { Delete = 1 };
        if (!SetFileInformationByHandle(h, 4, ref d, 1)) throw new IOException("transport-delete-refused:" + Marshal.GetLastWin32Error());
      }
    }
    } finally { for (int i = parents.Count - 1; i >= 0; i--) parents[i].Dispose(); }
  }
}
