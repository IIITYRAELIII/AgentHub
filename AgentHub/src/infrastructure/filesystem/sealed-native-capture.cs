using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Native capture owner effect boundary. External plan is an immutable archive
// receipt, never discovery/deletion authority by itself. Caller holds original
// Task/process/installation/maintenance leases and verified archive custody.
public static class AgentHubSealedNativeCapture {
  [StructLayout(LayoutKind.Sequential)] private struct FT { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential)] private struct Info {
    public uint Attributes; public FT Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string p,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
  [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll",SetLastError=true)] private static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int c,IntPtr b,uint n);
  [DllImport("kernel32.dll",SetLastError=true)] private static extern bool SetFileInformationByHandle(SafeFileHandle h,int c,ref uint d,uint n);
  private const uint Read=0x80000000, Delete=0x10000, Attr=0x80, Reparse=0x400, DirBit=0x10;
  private static readonly StringComparer Case=StringComparer.OrdinalIgnoreCase;
  private sealed class Dir { public string Path,Relative; public SafeFileHandle Handle; }
  private sealed class Asset { public string Path,Hash; public ulong Volume,Index,Birth,Write,Change; public long Bytes; public bool Shared,EnforceTimes; }
  private static ulong Number(uint hi,uint lo) { return ((ulong)hi<<32)|lo; }
  private static string Long(string p) { return p.StartsWith(@"\\?\",StringComparison.Ordinal)?p:p.StartsWith(@"\\",StringComparison.Ordinal)?@"\\?\UNC\"+p.Substring(2):@"\\?\"+p; }
  private static Info Information(SafeFileHandle h) {
    Info i;if(h.IsInvalid||!GetFileInformationByHandle(h,out i))throw new IOException("capture-handle-unavailable:"+Marshal.GetLastWin32Error());
    if((i.Attributes&Reparse)!=0)throw new IOException("capture-reparse-refused");return i;
  }
  private static void Streams(SafeFileHandle h,bool directory) {
    IntPtr b=Marshal.AllocHGlobal(65536);
    try {
      bool ok=GetFileInformationByHandleEx(h,7,b,65536);int e=Marshal.GetLastWin32Error();
      if(!ok){if(directory&&e==38)return;throw new IOException("capture-streams-unavailable:"+e);}
      if(Marshal.ReadInt32(b,0)!=0||Marshal.ReadInt32(b,4)!=14||Marshal.PtrToStringUni(IntPtr.Add(b,24),7)!="::$DATA"
        ||(directory&&Marshal.ReadInt64(b,8)!=0))throw new IOException("capture-extra-stream");
    }finally{Marshal.FreeHGlobal(b);}
  }
  private static long Allocated(SafeFileHandle h) {
    IntPtr b=Marshal.AllocHGlobal(24);
    try {if(!GetFileInformationByHandleEx(h,1,b,24))throw new IOException("capture-allocation-unavailable");return Marshal.ReadInt64(b);}
    finally{Marshal.FreeHGlobal(b);}
  }
  private static ulong ChangeTime(SafeFileHandle h) {
    IntPtr b=Marshal.AllocHGlobal(40);
    try {if(!GetFileInformationByHandleEx(h,0,b,40))throw new IOException("capture-change-time-unavailable");return (ulong)Marshal.ReadInt64(b,24);}
    finally{Marshal.FreeHGlobal(b);}
  }
  private static SafeFileHandle Open(string p,bool directory,bool destructive,bool shared) {
    SafeFileHandle h=CreateFileW(p,Attr|(directory?0:Read)|(destructive?Delete:0),destructive?1u:3u,IntPtr.Zero,3,0x200000|(directory?0x2000000u:0),IntPtr.Zero);
    try {Info i=Information(h);if(((i.Attributes&DirBit)!=0)!=directory||(!directory&&i.Links!=1&&!shared))throw new IOException("capture-type-or-hardlink-refused");Streams(h,directory);return h;}
    catch{h.Dispose();throw;}
  }
  private static string Hash(Stream stream) {using(SHA256 h=SHA256.Create())return BitConverter.ToString(h.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}
  private static void DisposeEntry(SafeFileHandle h) {uint f=0x13;if(!SetFileInformationByHandle(h,21,ref f,4))throw new IOException("capture-disposition-refused:"+Marshal.GetLastWin32Error());}
  private static string Full(string value) {
    string full=Path.GetFullPath(value).TrimEnd('\\','/');
    if(!Path.IsPathRooted(value)||Case.Equals(full,Path.GetPathRoot(full).TrimEnd('\\','/')))throw new IOException("capture-root-refused");return Long(full);
  }
  private static string Relative(string v) {
    if(String.IsNullOrEmpty(v)||Path.IsPathRooted(v)||v.Contains("\\")||v.Contains(":"))throw new IOException("capture-relative-refused");
    foreach(char c in v)if(Char.IsControl(c)||"<>\"|?*".IndexOf(c)>=0)throw new IOException("capture-relative-refused");
    foreach(string n in v.Split('/'))if(n==""||n=="."||n==".."||n.EndsWith(".")||n.EndsWith(" "))throw new IOException("capture-relative-refused");
    return v;
  }
  private static List<SafeFileHandle> Ancestors(string root) {
    var result=new List<SafeFileHandle>();var names=new List<string>();string parent=Path.GetDirectoryName(root);
    while(!String.IsNullOrEmpty(parent)){names.Add(parent);string n=Path.GetDirectoryName(parent);if(n==parent)break;parent=n;}
    names.Reverse();
    try {
      foreach(string n in names){var h=CreateFileW(n,Attr,3,IntPtr.Zero,3,0x2200000,IntPtr.Zero);result.Add(h);if((Information(h).Attributes&DirBit)==0)throw new IOException("capture-ancestor-refused");}
      return result;
    }catch{foreach(var h in result)h.Dispose();throw;}
  }
  private static Dictionary<string,object> Map(object v) {var d=v as Dictionary<string,object>;if(d==null)throw new IOException("capture-plan-malformed");return d;}
  private static ulong U(object v) {return ulong.Parse(Convert.ToString(v,CultureInfo.InvariantCulture),CultureInfo.InvariantCulture);}
  private static long L(object v) {return long.Parse(Convert.ToString(v,CultureInfo.InvariantCulture),CultureInfo.InvariantCulture);}
  private static ulong Time(object value) {return Convert.ToUInt64(decimal.Truncate(decimal.Parse(Convert.ToString(value,CultureInfo.InvariantCulture),CultureInfo.InvariantCulture)/100m)+116444736000000000m);}
  private static ulong Birth(Dictionary<string,object> d) {return Time(d["birthtimeNs"]);}
  private static void Match(Info i,Dictionary<string,object> d) {
    if(i.Volume!=U(d["dev"])||Number(i.IndexHigh,i.IndexLow)!=U(d["ino"])||Number(i.Creation.High,i.Creation.Low)!=Birth(d))throw new IOException("capture-physical-identity-changed");
  }
  private static void Match(SafeFileHandle h,Asset a) {
    Info i=Information(h);
    if(i.Volume!=a.Volume||Number(i.IndexHigh,i.IndexLow)!=a.Index||Number(i.Creation.High,i.Creation.Low)!=a.Birth
      ||Number(i.SizeHigh,i.SizeLow)!=(ulong)a.Bytes||(!a.Shared&&i.Links!=1))throw new IOException("capture-file-identity-changed");
    if(a.EnforceTimes&&(Number(i.Write.High,i.Write.Low)!=a.Write||ChangeTime(h)!=a.Change))throw new IOException("capture-file-content-time-changed");
  }
  private static bool Empty(string p) {using(var e=Directory.EnumerateFileSystemEntries(p).GetEnumerator())return !e.MoveNext();}
  private static void Mode() {AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);}
  private static JavaScriptSerializer Serializer() {return new JavaScriptSerializer{MaxJsonLength=int.MaxValue,RecursionLimit=128};}

  public static string Retire(string selectedRoot,string planPath,string planHash,bool allowPartial) {
    Mode();string root=Full(selectedRoot);var ancestors=Ancestors(root);var dirs=new List<Dir>();
    try {
      Dictionary<string,object> plan;
      // Hold the external derivative proof file while deleting. Its hash binds
      // the original Git archive; it is outside the retiring root.
      using(var ph=Open(Full(planPath),false,false,false))
      using(var ps=new FileStream(ph,FileAccess.Read)) {
        if(Hash(ps)!=planHash)throw new IOException("capture-plan-hash-changed");ps.Position=0;
        using(var reader=new StreamReader(ps,new UTF8Encoding(false,true),true,4096,true))plan=Map(Serializer().DeserializeObject(reader.ReadToEnd()));
        if(!Case.Equals(Path.GetFullPath((string)plan["repository"]),Path.GetFullPath(selectedRoot)))throw new IOException("capture-plan-root-mismatch");
        var rh=Open(root,true,true,false);dirs.Add(new Dir{Path=root,Relative="",Handle=rh});Match(Information(rh),Map(plan["root"]));
        var files=new Dictionary<string,Asset>(Case);var expectedDirs=new Dictionary<string,Dictionary<string,object>>(Case);
        foreach(object value in (object[])plan["files"]) {
          var f=Map(value);var id=Map(f["identity"]);string relative=Relative((string)f["path"]);
          string hash=(string)id["sha256"];if(hash.Length!=64)throw new IOException("capture-hash-malformed");
          bool shared=f.ContainsKey("sharedObject")&&Convert.ToBoolean(f["sharedObject"]);
          if(shared&&(!f.ContainsKey("objectFile")||!Convert.ToBoolean(f["objectFile"])||!relative.StartsWith(".git/objects/",StringComparison.Ordinal)))throw new IOException("capture-shared-object-refused");
          bool objectFile=f.ContainsKey("objectFile")&&Convert.ToBoolean(f["objectFile"]);
          files.Add(relative,new Asset{Path=relative,Hash=hash,Volume=U(id["dev"]),Index=U(id["ino"]),Birth=Birth(id),Bytes=L(id["bytes"]),Shared=shared,
            EnforceTimes=!objectFile,Write=objectFile?0:Time(f["writeTimeNs"]),Change=objectFile?0:Time(f["changeTimeNs"])});
        }
        foreach(object value in (object[])plan["directories"]){var d=Map(value);string relative=(string)d["path"];if(relative!="")expectedDirs.Add(Relative(relative),Map(d["identity"]));}
        int found=0,foundDirs=0;
        for(int n=0;n<dirs.Count;n++)foreach(string child in Directory.EnumerateFileSystemEntries(dirs[n].Path)) {
          string relative=child.Substring(root.Length+1).Replace('\\','/');var attrs=File.GetAttributes(child);
          if((attrs&FileAttributes.ReparsePoint)!=0)throw new IOException("capture-reparse-refused");
          if((attrs&FileAttributes.Directory)!=0){
            Dictionary<string,object> id;if(!expectedDirs.TryGetValue(relative,out id))throw new IOException("capture-unexpected-directory");
            var h=Open(child,true,true,false);dirs.Add(new Dir{Path=child,Relative=relative,Handle=h});Match(Information(h),id);foundDirs++;
          }else{
            Asset a;if(!files.TryGetValue(relative,out a))throw new IOException("capture-unexpected-file");
            using(var h=Open(child,false,true,a.Shared))Match(h,a);found++;
          }
        }
        if(!allowPartial&&(found!=files.Count||foundDirs!=expectedDirs.Count))throw new IOException("capture-missing-without-original");
        var ordered=new List<string>(files.Keys);ordered.Sort(Case);
        int removed=0,sharedRemoved=0;long bytes=0,allocation=0;var clock=System.Diagnostics.Stopwatch.StartNew();
        foreach(string relative in ordered) {
          Asset a=files[relative];string target=root+"\\"+relative.Replace('/','\\');
          if(!File.Exists(target)){if(allowPartial)continue;throw new IOException("capture-file-disappeared");}
          if(removed>=64||(removed>0&&(bytes+a.Bytes>256L*1024*1024||clock.ElapsedMilliseconds>=10000)))break;
          using(var h=Open(target,false,true,a.Shared))using(var stream=new FileStream(h,FileAccess.Read)) {
            Match(h,a);if(Hash(stream)!=a.Hash)throw new IOException("capture-file-hash-changed");Match(h,a);
            Info i=Information(h);if(i.Links==1)allocation+=Allocated(h);else sharedRemoved++;
            DisposeEntry(h);
          }
          removed++;bytes+=a.Bytes;
        }
        for(int n=dirs.Count-1;n>0;n--)if(Empty(dirs[n].Path)){Streams(dirs[n].Handle,true);DisposeEntry(dirs[n].Handle);dirs[n].Handle.Dispose();}
        bool complete=Empty(root);
        if(complete){Streams(rh,true);Match(Information(rh),Map(plan["root"]));DisposeEntry(rh);}
        return Serializer().Serialize(new Dictionary<string,object>{{"status",complete?"complete":"partial"},{"files",removed},{"logicalBytes",bytes},{"allocatedBytesUnlinked",allocation},{"sharedObjectsUnlinked",sharedRemoved}});
      }
    }finally{for(int n=dirs.Count-1;n>=0;n--)dirs[n].Handle.Dispose();for(int n=ancestors.Count-1;n>=0;n--)ancestors[n].Dispose();}
  }

  // Exact selected roots only, no filesystem discovery policy or deletion.
  public static string Measure(string rootsJson) {
    Mode();var roots=(object[])Serializer().DeserializeObject(rootsJson);var unique=new Dictionary<string,long>();var records=new List<object>();long logical=0;int count=0;
    foreach(string selected in roots) {
      string root=Full(selected);var ancestors=Ancestors(root);var dirs=new List<Dir>();long local=0;
      try{
        dirs.Add(new Dir{Path=root,Relative="",Handle=Open(root,true,false,false)});
        for(int n=0;n<dirs.Count;n++)foreach(string child in Directory.EnumerateFileSystemEntries(dirs[n].Path)){
          var attrs=File.GetAttributes(child);if((attrs&FileAttributes.ReparsePoint)!=0)throw new IOException("capture-measure-reparse");
          if((attrs&FileAttributes.Directory)!=0)dirs.Add(new Dir{Path=child,Handle=Open(child,true,false,false)});
          else using(var h=Open(child,false,false,true)){Info i=Information(h);long size=(long)Number(i.SizeHigh,i.SizeLow);long allocated=Allocated(h);string id=i.Volume+":"+Number(i.IndexHigh,i.IndexLow);if(unique.ContainsKey(id)&&unique[id]!=allocated)throw new IOException("capture-allocation-drift");unique[id]=allocated;logical+=size;local+=size;count++;}
        }
        records.Add(new Dictionary<string,object>{{"root",selected},{"logicalBytes",local}});
      }finally{for(int n=dirs.Count-1;n>=0;n--)dirs[n].Handle.Dispose();foreach(var h in ancestors)h.Dispose();}
    }
    long total=0;foreach(long n in unique.Values)total+=n;
    return Serializer().Serialize(new Dictionary<string,object>{{"files",count},{"uniqueFiles",unique.Count},{"logicalBytes",logical},{"uniqueAllocatedBytes",total},{"roots",records}});
  }
  public static string UnlinkObjectAlias(string selected,string identityJson) {
    Mode();string target=Full(selected);var ancestors=Ancestors(target);
    try{
      var id=Map(Serializer().DeserializeObject(identityJson));var a=new Asset{Volume=U(id["dev"]),Index=U(id["ino"]),Birth=Birth(id),Bytes=L(id["bytes"]),Hash=(string)id["sha256"],Shared=true};
      using(var h=Open(target,false,true,true))using(var stream=new FileStream(h,FileAccess.Read)){
        Match(h,a);if(Information(h).Links<2||Hash(stream)!=a.Hash)throw new IOException("capture-object-alias-unproven");
        Match(h,a);DisposeEntry(h);
      }
      return "{\"status\":\"unlinked\"}";
    }finally{foreach(var h in ancestors)h.Dispose();}
  }
}
