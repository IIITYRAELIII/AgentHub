using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

// Invoked only by the work-log backup retention owner. Never delete by a
// pathname after checking it: the ancestor can become a junction meanwhile.
// Win32 contract: GetFileInformationByHandle + SetFileInformationByHandle
// FileDispositionInfo (Microsoft Learn, fileapi.h). The open handle, not the
// caller's earlier pathname, is the authority for the destructive syscall.
public static class AgentHubVerifiedEntryDeletion {
  [StructLayout(LayoutKind.Sequential)]
  private struct FILETIME { public uint Low; public uint High; }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_INFORMATION {
    public uint Attributes;
    public FILETIME Creation;
    public FILETIME Access;
    public FILETIME Write;
    public uint Volume;
    public uint SizeHigh;
    public uint SizeLow;
    public uint Links;
    public uint IndexHigh;
    public uint IndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct FILE_DISPOSITION_INFO { public byte DeleteFile; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(
    string path, uint access, uint share, IntPtr security,
    uint creation, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(
    SafeFileHandle handle, out FILE_INFORMATION info);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool SetFileInformationByHandle(
    SafeFileHandle handle, int informationClass,
    ref FILE_DISPOSITION_INFO information, uint size);

  public static void Delete(
    string path, string expectedVolume, string expectedIndex,
    string expectedSize, bool directory, string testBarrier) {
    const uint DELETE = 0x00010000;
    const uint FILE_READ_ATTRIBUTES = 0x00000080;
    const uint SHARE_READ_WRITE_DELETE = 0x00000007;
    const uint OPEN_EXISTING = 3;
    const uint OPEN_REPARSE_POINT = 0x00200000;
    const uint BACKUP_SEMANTICS = 0x02000000;
    const uint REPARSE_POINT = 0x00000400;
    const uint DIRECTORY = 0x00000010;
    uint flags = OPEN_REPARSE_POINT | (directory ? BACKUP_SEMANTICS : 0);
    using (SafeFileHandle handle = CreateFileW(path, DELETE | FILE_READ_ATTRIBUTES,
      SHARE_READ_WRITE_DELETE, IntPtr.Zero, OPEN_EXISTING, flags, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new IOException("Verified entry open failed: " + Marshal.GetLastWin32Error());
      FILE_INFORMATION found;
      if (!GetFileInformationByHandle(handle, out found))
        throw new IOException("Verified entry identity read failed: " + Marshal.GetLastWin32Error());
      ulong index = ((ulong)found.IndexHigh << 32) | found.IndexLow;
      ulong size = ((ulong)found.SizeHigh << 32) | found.SizeLow;
      if ((found.Attributes & REPARSE_POINT) != 0
          || ((found.Attributes & DIRECTORY) != 0) != directory)
        throw new IOException("Verified entry identity mismatch: type");
      if (found.Links != 1) throw new IOException("Verified entry identity mismatch: links");
      if (found.Volume != uint.Parse(expectedVolume, CultureInfo.InvariantCulture))
        throw new IOException("Verified entry identity mismatch: volume");
      if (index != ulong.Parse(expectedIndex, CultureInfo.InvariantCulture))
        throw new IOException("Verified entry identity mismatch: index");
      if (!directory && size != ulong.Parse(expectedSize, CultureInfo.InvariantCulture))
        throw new IOException("Verified entry identity mismatch: size");

      // Only injected by isolated tests. The same open handle remains the
      // deletion authority while the test swaps ancestor pathnames.
      if (!String.IsNullOrEmpty(testBarrier)) {
        File.WriteAllText(testBarrier + ".ready", "ready");
        DateTime deadline = DateTime.UtcNow.AddSeconds(10);
        while (!File.Exists(testBarrier + ".go") && DateTime.UtcNow < deadline)
          System.Threading.Thread.Sleep(10);
        if (!File.Exists(testBarrier + ".go")) throw new IOException("Verified entry test barrier timed out");
      }
      FILE_DISPOSITION_INFO disposition = new FILE_DISPOSITION_INFO { DeleteFile = 1 };
      if (!SetFileInformationByHandle(handle, 4, ref disposition, 1))
        throw new IOException("Verified entry delete failed: " + Marshal.GetLastWin32Error());
    }
  }
}
