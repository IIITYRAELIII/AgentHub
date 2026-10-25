import { createHash } from "node:crypto";
import { lstat, open, realpath, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { TaskClaimCustodyRejectedError } from "../../domain/claim-forward-custody.mjs";
import { captureProcess } from "./process-capture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
function refuse(message) {
  throw new TaskClaimCustodyRejectedError(`Runtime cohort custody refused: ${message}`);
}

// The helper never creates/assigns/terminates a job or process. A successful
// capture observes the existing RuntimeHost job, not a descendant snapshot.
// PowerShell 7 compiles this in memory; no generated executable is installed.
const nativeSource = String.raw`
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
public static class ClaimCustodyNative {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint size, IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long born, out long exit, out long kernel, out long user);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int cls, IntPtr info, int size, out int returned);
 [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr Reserved1, Peb, Reserved2, Reserved3, Pid, Parent; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public long PerProcess, PerJob; public uint Flags; public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Limits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
 static Exception Failure(string step) { return new Exception(step + ": win32=" + Marshal.GetLastWin32Error()); }
 static string Digest(byte[] bytes) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
 static long Birth(IntPtr process) { long born, exit, kernel, user; if(!GetProcessTimes(process,out born,out exit,out kernel,out user)) throw Failure("process-times"); return born; }
 static bool Alive(IntPtr process) { uint state=WaitForSingleObject(process,0); if(state==0) return false; if(state==258) return true; throw Failure("process-wait"); }
 static IntPtr ProcessHandle(int pid) {
   IntPtr handle=OpenProcess(0x00100400|0x1000,false,pid);
   if(handle==IntPtr.Zero && Marshal.GetLastWin32Error()!=87) throw Failure("process-query");
   return handle;
 }
 static string CommandHash(IntPtr process) {
   int length; NtQueryInformationProcess(process,60,IntPtr.Zero,0,out length);
   if(length<8 || length>131072) throw new Exception("command-query-size");
   IntPtr memory=Marshal.AllocHGlobal(length);
   try {
     if(NtQueryInformationProcess(process,60,memory,length,out length)!=0) throw new Exception("command-query-denied");
     int bytes=(ushort)Marshal.ReadInt16(memory);
     IntPtr address=Marshal.ReadIntPtr(memory,IntPtr.Size==8?8:4);
     if(bytes==0 || bytes>131072 || address.ToInt64()<memory.ToInt64() || address.ToInt64()+bytes>memory.ToInt64()+length) throw new Exception("command-query-invalid");
     return Digest(Encoding.UTF8.GetBytes(Marshal.PtrToStringUni(address,bytes/2)));
   } finally { Marshal.FreeHGlobal(memory); }
 }
 static Dictionary<string,object> Identity(IntPtr process, int pid, string expectedImage) {
   if(!Alive(process)) throw new Exception("capture-process-exited");
   long born=Birth(process);
   int size=Marshal.SizeOf(typeof(Basic)), returned; IntPtr memory=Marshal.AllocHGlobal(size); Basic basic;
   try { if(NtQueryInformationProcess(process,0,memory,size,out returned)!=0) throw new Exception("parent-query-denied"); basic=(Basic)Marshal.PtrToStructure(memory,typeof(Basic)); }
   finally { Marshal.FreeHGlobal(memory); }
   var image=new StringBuilder(32768); uint count=32768;
   if(!QueryFullProcessImageName(process,0,image,ref count)) throw Failure("image-query");
   string name=image.ToString();
   if(!String.Equals(Path.GetFileName(name),expectedImage,StringComparison.OrdinalIgnoreCase)) throw new Exception("unexpected-process-image");
   string imageHash;
   using(var stream=new FileStream(name,FileMode.Open,FileAccess.Read,FileShare.Read)) {
     if(stream.Length>268435456) throw new Exception("image-budget");
     using(var sha=SHA256.Create()) imageHash=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
   }
   string commandHash=CommandHash(process);
   if(!Alive(process)||Birth(process)!=born) throw new Exception("capture-process-drift");
   return new Dictionary<string,object>{{"pid",pid},{"parentPid",basic.Parent.ToInt32()},{"birthFileTime",born.ToString()},{"imageSha256",imageHash},{"imagePathSha256",Digest(Encoding.UTF8.GetBytes(name.ToLowerInvariant()))},{"commandSha256",commandHash}};
 }
 static uint JobFlags(IntPtr job) {
   int size=Marshal.SizeOf(typeof(Extended)); IntPtr memory=Marshal.AllocHGlobal(size);
   try { if(!QueryInformationJobObject(job,9,memory,(uint)size,IntPtr.Zero)) throw Failure("job-limits-query"); return ((Extended)Marshal.PtrToStructure(memory,typeof(Extended))).Basic.Flags; }
   finally { Marshal.FreeHGlobal(memory); }
 }
 static uint JobActive(IntPtr job) {
   // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: 4 LARGE_INTEGERs + 4 DWORDs.
   IntPtr memory=Marshal.AllocHGlobal(48);
   try { if(!QueryInformationJobObject(job,1,memory,48,IntPtr.Zero)) throw Failure("job-accounting-query"); return (uint)Marshal.ReadInt32(memory,40); }
   finally { Marshal.FreeHGlobal(memory); }
 }
 static void NoBreakaway(IntPtr job) { if((JobFlags(job)&0x1800)!=0) throw new Exception("job-permits-breakaway"); }
 static void Member(IntPtr process,IntPtr job) { bool member; if(!IsProcessInJob(process,job,out member)) throw Failure("job-membership-query"); if(!member) throw new Exception("process-outside-runtime-job"); }
 public static object Capture(int pid, long originalMs) {
   IntPtr node=ProcessHandle(pid), host=IntPtr.Zero, job=IntPtr.Zero;
   try {
     if(node==IntPtr.Zero) throw new Exception("primary-node-not-live-at-capture");
     var n=Identity(node,pid,"node.exe"); int parent=(int)n["parentPid"];
     host=ProcessHandle(parent); if(host==IntPtr.Zero) throw new Exception("runtime-host-not-live-at-capture");
     var h=Identity(host,parent,"AgentHub.RuntimeHost.exe");
     if(long.Parse((string)h["birthFileTime"])>long.Parse((string)n["birthFileTime"])) throw new Exception("runtime-parent-birth-drift");
     long original=checked(originalMs*10000+116444736000000000L);
     if(long.Parse((string)n["birthFileTime"])>original || long.Parse((string)h["birthFileTime"])>original || originalMs>DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) throw new Exception("original-outside-root-lifetimes");
     string jobName="Local\\IIITYRAELIII.AgentHub."+parent;
     job=OpenJobObject(4,false,jobName); if(job==IntPtr.Zero) throw Failure("runtime-job-not-observable-at-capture");
     NoBreakaway(job); Member(node,job); Member(host,job);
     if(!Alive(node)||!Alive(host)) throw new Exception("root-exited-during-capture");
     return new Dictionary<string,object>{{"node",n},{"host",h},{"jobName",jobName},{"activeProcesses",JobActive(job)},{"limitFlags",JobFlags(job)}};
   } finally { if(job!=IntPtr.Zero)CloseHandle(job); if(host!=IntPtr.Zero)CloseHandle(host); if(node!=IntPtr.Zero)CloseHandle(node); }
 }
 static string RootState(int pid,string birth) {
   IntPtr process=ProcessHandle(pid); if(process==IntPtr.Zero) return "exited";
   try { if(Birth(process).ToString()!=birth) return "pid-reused"; return Alive(process)?"alive":"exited"; }
   finally { CloseHandle(process); }
 }
 public static object Retired(string jobName,int nodePid,string nodeBirth,int hostPid,string hostBirth) {
   // Open the named job BEFORE checking roots, retaining its object through the
   // query so disappearance/name reuse cannot change which object is observed.
   IntPtr job=OpenJobObject(4,false,jobName); int error=Marshal.GetLastWin32Error();
   if(job==IntPtr.Zero) {
     // Windows removes a job's NAME when its final user handle closes even
     // while inherited descendants remain live. Exact root exit plus name
     // absence therefore cannot certify whole-cohort retirement.
     if(error==2) throw new Exception("captured-job-name-no-longer-observable-whole-cohort-unknown");
     throw new Exception("job-query-unavailable: win32="+error);
   }
   try {
     string host=RootState(hostPid,hostBirth),node=RootState(nodePid,nodeBirth);
     if(host=="alive"||node=="alive") throw new Exception("captured-runtime-root-still-live");
     if(job!=IntPtr.Zero) {
       if(host=="pid-reused") throw new Exception("runtime-host-birth-drift-with-named-job");
       NoBreakaway(job); if(JobActive(job)!=0) throw new Exception("runtime-job-still-has-active-processes");
     }
     return new Dictionary<string,object>{{"activeProcesses",0},{"evidence","named-job-active-processes-zero"},{"hostState",host},{"nodeState",node}};
   } finally { if(job!=IntPtr.Zero)CloseHandle(job); }
 }

 static IntPtr WitnessJob=IntPtr.Zero,WitnessHost=IntPtr.Zero,WitnessNode=IntPtr.Zero;
 static Dictionary<string,object> WitnessCapture;
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out int pid);
 public static object BeginWitness(int hp,string hb,int np,string nb,long originalMs) {
  WitnessJob=OpenJobObject(4,false,"Local\\IIITYRAELIII.AgentHub."+hp); if(WitnessJob==IntPtr.Zero)throw Failure("witness-job-open");
  bool inside; if(!IsProcessInJob(GetCurrentProcess(),WitnessJob,out inside))throw Failure("witness-self-membership");
  if(inside)throw new Exception("collector-inside-old-job-refused");
  WitnessHost=ProcessHandle(hp);WitnessNode=ProcessHandle(np);
  if(WitnessHost==IntPtr.Zero||WitnessNode==IntPtr.Zero)throw new Exception("witness-root-already-exited");
  if(Birth(WitnessHost).ToString()!=hb||Birth(WitnessNode).ToString()!=nb)throw new Exception("witness-exact-root-birth-mismatch");
  NoBreakaway(WitnessJob);Member(WitnessHost,WitnessJob);Member(WitnessNode,WitnessJob);
  WitnessCapture=(Dictionary<string,object>)Capture(np,originalMs);
  var host=(Dictionary<string,object>)WitnessCapture["host"];
  if((int)host["pid"]!=hp||(string)host["birthFileTime"]!=hb)throw new Exception("witness-parent-identity-drift");
  WitnessCapture["collector"]=Identity(GetCurrentProcess(),System.Diagnostics.Process.GetCurrentProcess().Id,"pwsh.exe");
  WitnessCapture["collectorOutsideCapturedJob"]=true;
  WitnessCapture["originalCreatedAtMs"]=originalMs;
  return WitnessCapture;
 }
 public static object ReadWitness() {
  if(WitnessJob==IntPtr.Zero||WitnessCapture==null)throw new Exception("witness-handle-not-held");
  NoBreakaway(WitnessJob);
  bool inside;if(!IsProcessInJob(GetCurrentProcess(),WitnessJob,out inside)||inside)throw new Exception("witness-self-membership-drift");
  uint active=JobActive(WitnessJob); bool hostExited=!Alive(WitnessHost),nodeExited=!Alive(WitnessNode);
  return new Dictionary<string,object>{{"capture",WitnessCapture},{"activeProcesses",active},
    {"hostExited",hostExited},{"nodeExited",nodeExited},{"exactQueryHandleRetained",true},
    {"retired",active==0&&hostExited&&nodeExited},{"observedAtMs",DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}};
 }
 public static void CloseWitness() {
  if(WitnessJob!=IntPtr.Zero)CloseHandle(WitnessJob);if(WitnessHost!=IntPtr.Zero)CloseHandle(WitnessHost);if(WitnessNode!=IntPtr.Zero)CloseHandle(WitnessNode);
  WitnessJob=WitnessHost=WitnessNode=IntPtr.Zero;WitnessCapture=null;
 }
 public static object QueryWitness(string pipeName,string request,int expectedPid,string expectedBirth,string expectedCommandHash) {
  using(var pipe=new System.IO.Pipes.NamedPipeClientStream(".",pipeName,System.IO.Pipes.PipeDirection.InOut,System.IO.Pipes.PipeOptions.Asynchronous)) {
   pipe.Connect(5000); int pid;
   if(!GetNamedPipeServerProcessId(pipe.SafePipeHandle.DangerousGetHandle(),out pid)||pid!=expectedPid)throw new Exception("witness-server-process-differs");
   IntPtr process=ProcessHandle(pid);
   try {
    if(process==IntPtr.Zero||Birth(process).ToString()!=expectedBirth||!Alive(process)||CommandHash(process)!=expectedCommandHash)throw new Exception("witness-server-native-identity-differs");
    var writer=new StreamWriter(pipe,new UTF8Encoding(false),1024,true);writer.AutoFlush=true;writer.WriteLine(request);
    var reader=new StreamReader(pipe,Encoding.UTF8,false,1024,true);
    var read=reader.ReadLineAsync();if(!read.Wait(5000))throw new Exception("witness-read-timeout");
    string result=read.Result;if(result==null||Encoding.UTF8.GetByteCount(result)>32768)throw new Exception("witness-response-budget");
    return result;
   } finally {if(process!=IntPtr.Zero)CloseHandle(process);}
  }
 }
}`;

async function nativeProbe(payload, dataDir) {
  if (process.platform !== "win32") refuse("native Windows job evidence is unavailable");
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -TypeDefinition $env:AGENT_HUB_CUSTODY_NATIVE; $p=$env:AGENT_HUB_CUSTODY_QUERY|ConvertFrom-Json; if($p.mode -eq 'witness-query') { $r=[ClaimCustodyNative]::QueryWitness([string]$p.pipe,[string]$p.request,[int]$p.pid,[string]$p.birth,[string]$p.commandHash) } elseif($p.mode -eq 'capture') { $r=[ClaimCustodyNative]::Capture([int]$p.pid,[long]$p.originalMs) } else { $r=[ClaimCustodyNative]::Retired([string]$p.jobName,[int]$p.nodePid,[string]$p.nodeBirth,[int]$p.hostPid,[string]$p.hostBirth) }; $r|ConvertTo-Json -Compress -Depth 8 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const result = await captureProcess("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    timeoutMs: 20_000, maxOutputBytes: 16 * 1024, cwd: dataDir,
    env: { ...process.env, TEMP: dataDir, TMP: dataDir,
      AGENT_HUB_CUSTODY_NATIVE: nativeSource, AGENT_HUB_CUSTODY_QUERY: JSON.stringify(payload) },
  });
  if (result.error || result.code !== 0 || result.stdoutTruncated || result.stderrTruncated) {
    // Helper diagnostics are authored step/error codes, never command lines.
    refuse(`native evidence unavailable (${result.error?.code ?? result.stderr.trim().slice(0, 512) ?? "helper-failed"})`);
  }
  try { return JSON.parse(result.stdout); } catch { refuse("invalid native evidence response"); }
}

async function directoryBinding(dataDir) {
  const physical = await realpath(dataDir);
  const named = await lstat(dataDir);
  const info = await lstat(physical, { bigint: true });
  if (named.isSymbolicLink() || !info.isDirectory()) refuse("data root is not an unaliased directory");
  return { pathSha256: hash(physical.toLowerCase()), dev: String(info.dev), ino: String(info.ino), birthtimeNs: String(info.birthtimeNs) };
}

async function lockSnapshot(dataDir) {
  const target = path.join(dataDir, "bot.lock");
  const named = await lstat(target);
  if (named.isSymbolicLink() || !named.isFile() || named.size > 16 * 1024) refuse("unsafe primary bot.lock");
  const file = await open(target, "r");
  try {
    const before = await file.stat({ bigint: true });
    const bytes = Buffer.alloc(16 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat({ bigint: true });
    const current = await lstat(target, { bigint: true });
    if (bytesRead > 16 * 1024 || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || current.ino !== before.ino || current.birthtimeNs !== before.birthtimeNs || current.isSymbolicLink()) refuse("bot.lock changed during capture");
    const raw = bytes.subarray(0, bytesRead);
    let lock;
    try { lock = JSON.parse(raw.toString("utf8")); } catch { refuse("primary bot.lock is malformed"); }
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || typeof lock.instanceToken !== "string" || !lock.instanceToken
        || !Number.isFinite(Date.parse(lock.startedAt))) refuse("primary bot.lock lacks exact instance identity");
    return { pid: lock.pid, startedAtMs: Date.parse(lock.startedAt), instanceTokenSha256: hash(lock.instanceToken), sha256: hash(raw) };
  } finally { await file.close(); }
}

export function createClaimCustodyRuntime({ dataDir } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  return {
    async capture({ original, witness = null } = {}) {
      if (!Number.isSafeInteger(original?.createdAtMs) || original.createdAtMs <= 0) refuse("original intake time is required");
      const dataRoot = await directoryBinding(dataDir);
      if (witness) {
        const loaded = await loadWitness(witness, dataDir);
        const observation = await queryWitness(loaded, dataDir);
        if (loaded.manifest.capture.originalCreatedAtMs !== original.createdAtMs || observation.capture.originalCreatedAtMs !== original.createdAtMs
            || JSON.stringify(loaded.manifest.dataRoot) !== JSON.stringify(dataRoot)
            || loaded.manifest.primaryLock.pid !== loaded.manifest.capture.node.pid
            || loaded.manifest.primaryLock.startedAtMs > original.createdAtMs
            || loaded.manifest.primaryLock.startedAtMs < Number((BigInt(loaded.manifest.capture.node.birthFileTime) - 116444736000000000n)/10000n)) refuse("witness belongs to a different primary/original interval");
        return { version: 1, kind: "windows-runtime-exact-handle-witness-v1", dataRoot,
          witness, manifestHash: loaded.rawSha256, captureHash: hash(JSON.stringify(loaded.manifest.capture)),
          originalCreatedAtMs: original.createdAtMs, collector: loaded.manifest.capture.collector };
      }
      const lock = await lockSnapshot(dataDir);
      const native = await nativeProbe({ mode: "capture", pid: lock.pid, originalMs: original.createdAtMs }, dataDir);
      if (lock.startedAtMs > original.createdAtMs || lock.startedAtMs < Number((BigInt(native.node.birthFileTime) - 116444736000000000n) / 10000n)) refuse("original does not belong to the observed lock lifetime");
      if (JSON.stringify(await directoryBinding(dataDir)) !== JSON.stringify(dataRoot)
          || (await lockSnapshot(dataDir)).sha256 !== lock.sha256) refuse("primary runtime changed during capture");
      return { version: 1, kind: "windows-runtime-job-cohort-v1", dataRoot, ...native,
        originalCreatedAtMs: original.createdAtMs, capturedAtMs: Date.now(), instanceTokenSha256: lock.instanceTokenSha256 };
    },
    async assertRetired(cohort) {
      if (cohort?.version === 1 && cohort.kind === "windows-runtime-exact-handle-witness-v1") {
        if (JSON.stringify(await directoryBinding(dataDir)) !== JSON.stringify(cohort.dataRoot)) refuse("witness data root drifted");
        const loaded = await loadWitness(cohort.witness, dataDir);
        if (loaded.rawSha256 !== cohort.manifestHash || hash(JSON.stringify(loaded.manifest.capture)) !== cohort.captureHash) refuse("witness identity changed");
        const result = await queryWitness(loaded, dataDir);
        if (result.retired !== true || result.activeProcesses !== 0 || result.hostExited !== true || result.nodeExited !== true) refuse("captured exact job still has live owners or descendants");
        return { retired: true, kind: "native-exact-job-handle-zero-v1", manifestHash: loaded.rawSha256,
          captureHash: cohort.captureHash, collector: cohort.collector, observedAtMs: result.observedAtMs };
      }
      if (cohort?.version !== 1 || cohort.kind !== "windows-runtime-job-cohort-v1"
          || !Number.isSafeInteger(cohort.node?.pid) || cohort.node.pid <= 0
          || !Number.isSafeInteger(cohort.host?.pid) || cohort.host.pid <= 0
          || !/^\d+$/.test(cohort.node?.birthFileTime ?? "") || !/^\d+$/.test(cohort.host?.birthFileTime ?? "")
          || cohort.jobName !== `Local\\IIITYRAELIII.AgentHub.${cohort.host.pid}`
          || cohort.node.parentPid !== cohort.host.pid || !Number.isSafeInteger(cohort.limitFlags) || (cohort.limitFlags & 0x1800) !== 0
          || !Number.isSafeInteger(cohort.activeProcesses) || cohort.activeProcesses < 2
          || !Number.isSafeInteger(cohort.originalCreatedAtMs) || !Number.isSafeInteger(cohort.capturedAtMs)
          || cohort.originalCreatedAtMs > cohort.capturedAtMs
          || [cohort.node, cohort.host].some(identity => ["imageSha256", "imagePathSha256", "commandSha256"].some(key => !/^[a-f0-9]{64}$/.test(identity[key] ?? "")))
          || !/^[a-f0-9]{64}$/.test(cohort.instanceTokenSha256 ?? "")) refuse("invalid captured native cohort");
      if (JSON.stringify(await directoryBinding(dataDir)) !== JSON.stringify(cohort.dataRoot)) refuse("captured data root identity drifted");
      await nativeProbe({ mode: "retired", jobName: cohort.jobName,
        nodePid: cohort.node.pid, nodeBirth: cohort.node.birthFileTime,
        hostPid: cohort.host.pid, hostBirth: cohort.host.birthFileTime }, dataDir);
      // Separate opens cannot distinguish the captured object from an empty
      // object recreated under the same PID-derived name after a handle gap.
      // Only the existing cutover owner retaining the EXACT query handle from
      // capture through zero-active query and durable custody commit can grant
      // retirement. This short-lived read-only port has no such capability.
      refuse("exact-job-object-continuity-witness-required; named job is empty but whole captured cohort retirement is unproved");
    },
  };
}


const witnessServerScript = String.raw`
$ErrorActionPreference='Stop'
try {
 Add-Type -TypeDefinition $env:AGENT_HUB_CUSTODY_NATIVE
 $p=$env:AGENT_HUB_CUSTODY_QUERY|ConvertFrom-Json
 $capture=[ClaimCustodyNative]::BeginWitness([int]$p.hostPid,[string]$p.hostBirth,[int]$p.nodePid,[string]$p.nodeBirth,[long]$p.originalMs)
 if((Get-FileHash -LiteralPath $p.lockFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $p.primaryLock.sha256){throw 'primary-lock-changed-during-witness-capture'}
 $manifest=@{version=1;kind='claim-custody-native-witness-v1';pipeName=$p.pipe;nonceHash=$p.nonceHash;sourceSha256=$p.sourceHash;capture=$capture;dataRoot=$p.dataRoot;primaryLock=$p.primaryLock}
 [IO.File]::WriteAllText($p.manifest,($manifest|ConvertTo-Json -Compress -Depth 12),[Text.UTF8Encoding]::new($false))
 $done=$false
 while(-not $done) {
  $server=[IO.Pipes.NamedPipeServerStream]::new($p.pipe,[IO.Pipes.PipeDirection]::InOut,1,[IO.Pipes.PipeTransmissionMode]::Byte,[IO.Pipes.PipeOptions]::CurrentUserOnly,4096,4096)
  try {
   $server.WaitForConnection()
   $reader=[IO.StreamReader]::new($server,[Text.Encoding]::UTF8,$false,1024,$true)
   $writer=[IO.StreamWriter]::new($server,[Text.UTF8Encoding]::new($false),1024,$true);$writer.AutoFlush=$true
   $read=$reader.ReadLineAsync();if(-not $read.Wait(5000)){throw 'witness-request-timeout'}
   $line=$read.Result;if($null -eq $line -or $line.Length -gt 1024){throw 'witness-request-budget'}
   $request=$line|ConvertFrom-Json
   if($request.nonce -cne $p.nonce){$writer.WriteLine('{"error":"unauthorized"}');continue}
   if($request.operation -eq 'query'){$writer.WriteLine(([ClaimCustodyNative]::ReadWitness()|ConvertTo-Json -Compress -Depth 12))}
   elseif($request.operation -eq 'close'){$writer.WriteLine('{"closedOwnCollectorOnly":true}');$done=$true}
   else{$writer.WriteLine('{"error":"unknown-readonly-operation"}')}
  } finally {$server.Dispose()}
 }
} catch {[Console]::Error.WriteLine($_.Exception.Message);exit 1}
finally {[ClaimCustodyNative]::CloseWitness()}
`;
const witnessSourceHash = () => hash(nativeSource + witnessServerScript);

async function boundedRegular(file, max = 32768) {
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > max) refuse("unsafe witness artifact");
  const bytes = await readFile(file);
  const after = await lstat(file);
  if (after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size) refuse("witness artifact changed");
  return bytes;
}
async function loadWitness(binding, dataDir) {
  if (typeof binding?.sourcePath !== "string" || !/^[a-f0-9]{64}$/.test(binding.rawSha256 ?? "")) refuse("exact witness artifact binding is required");
  const file = path.resolve(binding.sourcePath);
  const relative = path.relative(await realpath(dataDir), await realpath(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !relative.split(path.sep).includes("WIP")) refuse("witness is outside the owning data WIP");
  const raw = await boundedRegular(file); const rawSha256 = hash(raw);
  if (rawSha256 !== binding.rawSha256) refuse("witness artifact hash differs");
  const manifest = JSON.parse(raw.toString("utf8"));
  if (manifest.version !== 1 || manifest.kind !== "claim-custody-native-witness-v1"
      || manifest.sourceSha256 !== witnessSourceHash() || !/^AgentHub\.ClaimCustody\.[a-f0-9]{32}$/.test(manifest.pipeName)
      || manifest.capture?.collectorOutsideCapturedJob !== true || (manifest.capture.limitFlags & 0x1800) !== 0
      || !Number.isSafeInteger(manifest.capture?.collector?.pid) || !/^\d+$/.test(manifest.capture.collector.birthFileTime ?? "")) refuse("witness native/source identity is unsupported");
  const key = JSON.parse((await boundedRegular(path.join(path.dirname(file), "nonce.private.json"), 1024)).toString("utf8"));
  if (typeof key.nonce !== "string" || key.nonce.length !== 64 || hash(key.nonce) !== manifest.nonceHash) refuse("witness nonce identity differs");
  return { manifest, rawSha256, key };
}
async function queryWitness(loaded, dataDir, operation = "query") {
  const { manifest, key } = loaded; const collector = manifest.capture.collector;
  const encoded = await nativeProbe({ mode: "witness-query", pipe: manifest.pipeName,
    request: JSON.stringify({ operation, nonce: key.nonce }), pid: collector.pid,
    birth: collector.birthFileTime, commandHash: collector.commandSha256 }, dataDir);
  const result = JSON.parse(encoded);
  if (operation === "close") return result;
  if (result.error || result.exactQueryHandleRetained !== true
      || hash(JSON.stringify(result.capture)) !== hash(JSON.stringify(manifest.capture))) refuse("witness response identity differs");
  return result;
}

// Explicit operator diagnostic. This never launches automatically from MCP.
// The caller must be outside the old job; native BeginWitness proves this before
// retaining a handle. Closing affects only this collector's own QUERY handles.
export async function launchClaimCustodyNativeWitness({ dataDir, outputDir, hostPid, hostBirth, nodePid, nodeBirth, originalMs }) {
  if (process.platform !== "win32") refuse("native Windows witness is unavailable");
  const dataRoot = await directoryBinding(dataDir);
  const primaryLock = await lockSnapshot(dataDir);
  if (primaryLock.pid !== nodePid || primaryLock.startedAtMs > originalMs) refuse("witness primary lock differs from the pinned original runtime");
  if (![hostPid, nodePid, originalMs].every(v => Number.isSafeInteger(v) && v > 0)
      || ![hostBirth,nodeBirth].every(v => /^\d+$/.test(v ?? ""))) refuse("exact native root pins are required");
  const relative = path.relative(path.resolve(dataDir), path.resolve(outputDir));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !relative.split(path.sep).includes("WIP")) refuse("witness output must be owned data WIP");
  // Refuse aliases before creating anything under the declared data root.
  let current = path.resolve(dataDir);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current,segment);
    const info = await lstat(current).catch(error => { if(error.code === "ENOENT") return null; throw error; });
    if (info && (!info.isDirectory() || info.isSymbolicLink())) refuse("witness output parent is aliased");
    if (!info) await mkdir(current);
    const physical = path.relative(await realpath(dataDir),await realpath(current));
    if (physical.startsWith(`..${path.sep}`) || path.isAbsolute(physical)) refuse("witness output escaped data root");
  }
  const nonce = randomBytes(32).toString("hex"); const pipe = `AgentHub.ClaimCustody.${randomBytes(16).toString("hex")}`;
  const manifest = path.join(outputDir, "witness.json");
  // Exclusive create preserves any prior useful capture and key.
  await writeFile(path.join(outputDir, "nonce.private.json"), JSON.stringify({ nonce }), { flag: "wx", mode: 0o600 });
  const child = spawn("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(witnessServerScript,"utf16le").toString("base64")], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe"], cwd: outputDir,
    env: { ...process.env, TEMP: outputDir, TMP: outputDir, AGENT_HUB_CUSTODY_NATIVE: nativeSource,
      AGENT_HUB_CUSTODY_QUERY: JSON.stringify({ hostPid,hostBirth,nodePid,nodeBirth,originalMs,manifest,pipe,nonce,nonceHash:hash(nonce),sourceHash:witnessSourceHash(),dataRoot,primaryLock,lockFile:path.join(dataDir,"bot.lock") }) },
  });
  let diagnostic = ""; child.stderr.on("data", bytes => { diagnostic = (diagnostic + bytes.toString("utf8")).slice(0,1024); });
  const [code] = await once(child,"exit");
  if (code !== 0) refuse(`collector refused (${diagnostic.trim()})`);
  return { closedOwnCollectorOnly: true };
}
export async function closeClaimCustodyNativeWitness({ dataDir, witness }) {
  return queryWitness(await loadWitness(witness,dataDir), dataDir, "close");
}
