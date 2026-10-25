import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createClaimCustodyRuntime, launchClaimCustodyNativeWitness, closeClaimCustodyNativeWitness } from "../../../src/infrastructure/process/claim-custody-runtime.mjs";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";
import { captureProcess } from "../../../src/infrastructure/process/process-capture.mjs";

// These are owned, disposable processes. Each has a finite self-exit deadline;
// cleanup only releases control files, and never invokes stop/kill/forceStop.
const hostSource = String.raw`
using System; using System.IO; using System.Diagnostics; using System.Runtime.InteropServices; using System.Threading;
class FixtureHost {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,IntPtr info,uint size);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr info,uint size,IntPtr returned);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr h,uint info,IntPtr sd);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint revision,out IntPtr sd,out uint size);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
 static void Security(IntPtr j,string value) { IntPtr sd;uint size; if(!ConvertStringSecurityDescriptorToSecurityDescriptor(value,1,out sd,out size)) throw new Exception("fixture descriptor"); try { if(!SetKernelObjectSecurity(j,4,sd)) throw new Exception("fixture job DACL"); } finally {LocalFree(sd);} }
 static int Main(string[] args) {
  IntPtr job=IntPtr.Zero;
  try {
   if(args[0]=="observe") {
    job=OpenJobObject(4,false,"Local\\IIITYRAELIII.AgentHub."+args[2]); if(job==IntPtr.Zero)throw new Exception("fixture query observer");
    File.WriteAllText(Path.Combine(args[1],"observer-ready"),"ready");
    var deadline=DateTime.UtcNow.AddSeconds(40);while(DateTime.UtcNow<deadline&&!File.Exists(Path.Combine(args[1],"release-observer"))) {
     IntPtr accounting=Marshal.AllocHGlobal(48);try {if(!QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero))throw new Exception("fixture exact-handle query");File.WriteAllText(Path.Combine(args[1],"observer-active-count"),Marshal.ReadInt32(accounting,40).ToString());}finally{Marshal.FreeHGlobal(accounting);}Thread.Sleep(30);
    }
    return 0;
   }
   if(args[2]!="missing") { job=CreateJobObject(IntPtr.Zero,"Local\\IIITYRAELIII.AgentHub."+Process.GetCurrentProcess().Id); if(job==IntPtr.Zero||!AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)) throw new Exception("fixture job"); }
   if(args[2]=="breakaway") {
    int size=IntPtr.Size==8?144:112;IntPtr limits=Marshal.AllocHGlobal(size);
    try {for(int i=0;i<size;i++)Marshal.WriteByte(limits,i,0);Marshal.WriteInt32(limits,16,0x800);if(!SetInformationJobObject(job,9,limits,(uint)size))throw new Exception("fixture breakaway limit");}finally{Marshal.FreeHGlobal(limits);}
   }
   var start=new ProcessStartInfo(args[0],"\""+Path.Combine(args[1],"node.mjs")+"\" \""+args[1]+"\""); start.UseShellExecute=false;start.CreateNoWindow=true;
   Process.Start(start);
   var end=DateTime.UtcNow.AddSeconds(45);bool denied=false;
   while(DateTime.UtcNow<end&&!File.Exists(Path.Combine(args[1],"release-host"))) {
    if(!denied&&File.Exists(Path.Combine(args[1],"deny-query"))) { Security(job,"D:(D;;0x0004;;;WD)");denied=true;File.WriteAllText(Path.Combine(args[1],"query-denied"),"ready"); }
    if(denied&&File.Exists(Path.Combine(args[1],"restore-query"))) {Security(job,"D:(A;;GA;;;WD)");denied=false;File.Delete(Path.Combine(args[1],"deny-query"));File.WriteAllText(Path.Combine(args[1],"query-restored"),"ready");}
    Thread.Sleep(15);
   }
   return 0;
  } catch(Exception e) {Console.Error.WriteLine(e.Message);return 1;} finally {if(job!=IntPtr.Zero)CloseHandle(job);}
 }
}`;
const nodeSource = `import { writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const root=process.argv[2];
await writeFile(path.join(root,'bot.lock'),JSON.stringify({pid:process.pid,instanceToken:'fixture-secret-not-for-certificate',startedAt:new Date().toISOString()}));
const end=Date.now()+40000;
while(Date.now()<end) {
 if(await access(path.join(root,'release-node')).then(()=>true,()=>false)) break;
 await delay(15);
}
if(await access(path.join(root,'spawn-late-child')).then(()=>true,()=>false)) {
 const child=spawn(process.execPath,[path.join(root,'child.mjs'),root],{stdio:'ignore',windowsHide:true,detached:true});
 child.on('error',error=>writeFile(path.join(root,'child-error'),String(error)));
 child.unref();
}
`;
const childSource = `import { writeFile,access } from 'node:fs/promises';import path from 'node:path';import {setTimeout as delay} from 'node:timers/promises';
const root=process.argv[2];await writeFile(path.join(root,'late-child-ready'),String(process.pid));
const end=Date.now()+30000;while(Date.now()<end&&!await access(path.join(root,'release-child')).then(()=>true,()=>false))await delay(15);`;

async function eventually(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let error;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; } catch (caught) { error = caught; }
    await delay(30);
  }
  throw new Error(`${message}${error ? `: ${error.message}` : ""}`);
}
const exists = target => readFile(target).then(() => true, () => false);

test("native runtime cohort observes the whole inherited job and refuses missing/query-denied evidence", { skip: process.platform !== "win32", timeout: 150_000 }, async t => {
  // Native compilation and all disposable data remain in the owned WIP root.
  const fixtureParent = path.resolve("WIP", "native-custody-tests");
  await mkdir(fixtureParent, { recursive: true });
  const root = await mkdtemp(path.join(fixtureParent, "cohort-"));
  const env = { ...process.env, TEMP: root, TMP: root };
  const source = path.join(root, "FixtureHost.cs");
  const executable = path.join(root, "AgentHub.RuntimeHost.exe");
  const hosts = [];
  const roots = [];
  try {
    await writeFile(source, hostSource);
    const compiler = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    const compiled = await captureProcess(compiler, ["/nologo", "/target:exe", `/out:${executable}`, source], { env, cwd: root });
    assert.equal(compiled.code, 0, compiled.stdout + compiled.stderr);
    async function fixture(mode = "normal") {
      const directory = path.join(root, `fixture-${roots.length}`); roots.push(directory);
      await mkdir(directory);
      await writeFile(path.join(directory, "node.mjs"), nodeSource);
      await writeFile(path.join(directory, "child.mjs"), childSource);
      const host = spawn(executable, [process.execPath, directory, mode], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env, cwd: directory });
      let diagnostic = ""; host.stderr.on("data", bytes => { diagnostic += bytes.toString(); });
      host.stdout.on("data", bytes => { diagnostic += bytes.toString(); });
      const completion = new Promise(resolve => host.on("exit", code => resolve({ code, diagnostic })));
      hosts.push(completion);
      const lock = await eventually(() => readFile(path.join(directory, "bot.lock"), "utf8").then(JSON.parse), "fixture lock");
      return { directory, lock, host, completion, diagnostic: () => diagnostic, port: createClaimCustodyRuntime({ dataDir: directory }) };
    }
    const f = await fixture();
    const original = { createdAtMs: Date.now() };
    const cohort = await f.port.capture({ original });
    assert.equal(cohort.host.pid, f.host.pid);
    assert.equal(cohort.node.pid, f.lock.pid);
    assert.equal(cohort.node.parentPid, f.host.pid);
    assert.equal(JSON.stringify(cohort).includes("fixture-secret"), false);
    for (const identity of [cohort.node, cohort.host]) {
      assert.match(identity.birthFileTime, /^\d+$/);
      assert.match(identity.commandSha256, /^[a-f0-9]{64}$/);
      assert.match(identity.imageSha256, /^[a-f0-9]{64}$/);
    }
    await assert.rejects(f.port.capture({ original: { createdAtMs: 1 } }), /original-outside-root-lifetimes/);
    await assert.rejects(f.port.assertRetired(cohort), /root-still-live/);
    await assert.rejects(f.port.assertRetired({ ...cohort, dataRoot: { ...cohort.dataRoot, birthtimeNs: "0" } }), /data root identity drifted/);
    await writeFile(path.join(f.directory, "deny-query"), "");
    await eventually(() => exists(path.join(f.directory, "query-denied")), "query DACL applied");
    await assert.rejects(f.port.assertRetired(cohort), /job-query-unavailable/);
    await assert.rejects(f.port.capture({ original }), /runtime-job-not-observable-at-capture/);
    await writeFile(path.join(f.directory, "restore-query"), "");
    await eventually(() => exists(path.join(f.directory, "query-restored")), "query DACL restored");
    await writeFile(path.join(f.directory, "spawn-late-child"), "");
    await writeFile(path.join(f.directory, "release-node"), "");
    try { await eventually(() => exists(path.join(f.directory, "late-child-ready")), "late child born after capture"); }
    catch (error) { throw new Error(`${error.message}: ${f.diagnostic()}; ${await readFile(path.join(f.directory, "child-error"), "utf8").catch(() => "")}`); }
    await writeFile(path.join(f.directory, "release-host"), "");
    assert.equal((await f.completion).code, 0);
    const childPid = Number(await readFile(path.join(f.directory, "late-child-ready"), "utf8"));
    process.kill(childPid, 0);
    t.diagnostic(JSON.stringify({ scenario: "name-lost-with-live-late-descendant", jobName: cohort.jobName, capturedLimitFlags: cohort.limitFlags,
      capturedActiveProcesses: cohort.activeProcesses, capturedNodePid: cohort.node.pid, capturedHostPid: cohort.host.pid, lateChildPid: childPid }));
    // Closing the host's last job handle removes the name even though this late
    // descendant survives. Name absence plus exact root exit is NOT retirement.
    await assert.rejects(f.port.assertRetired(cohort), /job-name-no-longer-observable/);
    await writeFile(path.join(f.directory, "release-child"), "");

    const witnessed = await fixture();
    const witnessCohort = await witnessed.port.capture({ original: { createdAtMs: Date.now() } });
    const observer = spawn(executable, ["observe", witnessed.directory, String(witnessed.host.pid)], { windowsHide: true, stdio: "ignore", env, cwd: witnessed.directory });
    const observerExit = new Promise(resolve => observer.on("exit", code => resolve({ code })));
    hosts.push(observerExit);
    await eventually(() => exists(path.join(witnessed.directory, "observer-ready")), "outside read-only query handle retained");
    await writeFile(path.join(witnessed.directory, "spawn-late-child"), "");
    await writeFile(path.join(witnessed.directory, "release-node"), "");
    await eventually(() => exists(path.join(witnessed.directory, "late-child-ready")), "witnessed late child");
    await writeFile(path.join(witnessed.directory, "release-host"), "");
    assert.equal((await witnessed.completion).code, 0);
    await assert.rejects(witnessed.port.assertRetired(witnessCohort), /job-still-has-active-processes/);
    await writeFile(path.join(witnessed.directory, "release-child"), "");
    await eventually(() => readFile(path.join(witnessed.directory, "observer-active-count"), "utf8").then(value => value === "0"), "outside observer's exact retained job handle proves zero active processes");
    t.diagnostic(JSON.stringify({ scenario: "external-exact-handle-positive-zero", jobName: witnessCohort.jobName, activeProcesses: 0,
      productionPortSupportsCertificate: false, requiredBridge: "existing-cutover-owner-exact-handle-through-durable-commit" }));
    await assert.rejects(witnessed.port.assertRetired(witnessCohort), /exact-job-object-continuity-witness-required/);
    await writeFile(path.join(witnessed.directory, "release-observer"), "");
    assert.equal((await observerExit).code, 0);
    await assert.rejects(witnessed.port.assertRetired(witnessCohort), /job-name-no-longer-observable/);
    const exact = await fixture();
    const exactOriginal = { createdAtMs: Date.now() };
    const pinned = await exact.port.capture({ original: exactOriginal });
    const outputDir = path.join(exact.directory, "WIP", "retained-native-witness");
    const collector = launchClaimCustodyNativeWitness({ dataDir: exact.directory, outputDir,
      hostPid: pinned.host.pid, hostBirth: pinned.host.birthFileTime,
      nodePid: pinned.node.pid, nodeBirth: pinned.node.birthFileTime, originalMs: exactOriginal.createdAtMs });
    let collectorFailure;
    const collectorFinished = collector.catch(error => { collectorFailure = error; });
    const sourcePath = path.join(outputDir, "witness.json");
    const bytes = await eventually(async () => {
      if (collectorFailure) throw collectorFailure;
      return readFile(sourcePath).catch(() => null);
    }, "exact external collector manifest");
    const binding = { sourcePath, rawSha256: createHash("sha256").update(bytes).digest("hex") };
    try {
      const captured = await exact.port.capture({ original: exactOriginal, witness: binding });
      assert.equal(captured.kind, "windows-runtime-exact-handle-witness-v1");
      await assert.rejects(exact.port.assertRetired(captured), /still has live owners/);
      await assert.rejects(exact.port.capture({ original: { createdAtMs: exactOriginal.createdAtMs - 1 }, witness: binding }), /different primary\/original interval/);
      await assert.rejects(exact.port.capture({ original: exactOriginal, witness: { ...binding, rawSha256: "f".repeat(64) } }), /artifact hash differs/);
      await writeFile(path.join(exact.directory, "spawn-late-child"), "");
      await writeFile(path.join(exact.directory, "release-node"), "");
      await eventually(() => exists(path.join(exact.directory,"late-child-ready")), "exact collector late descendant");
      await writeFile(path.join(exact.directory, "release-host"), "");
      assert.equal((await exact.completion).code, 0);
      await assert.rejects(exact.port.assertRetired(captured), /still has live owners/);
      await writeFile(path.join(exact.directory, "release-child"), "");
      const proof = await eventually(() => exact.port.assertRetired(captured), "retained EXACT handle positive retirement");
      assert.equal(proof.retired, true); assert.equal(proof.kind,"native-exact-job-handle-zero-v1");
      t.diagnostic(JSON.stringify({ scenario: "production-native-witness-bridge", captureHash: captured.captureHash,
        manifestHash: captured.manifestHash, activeProcesses: 0, actualNativeCertificate: proof.kind }));
    } finally {
      await closeClaimCustodyNativeWitness({ dataDir: exact.directory, witness: binding });
      await collectorFinished;
    }
    if (collectorFailure) throw collectorFailure;
    await assert.rejects(exact.port.capture({ original: exactOriginal, witness: binding }), /native evidence unavailable/);
    const publicRuntime = await fixture();
    const publicOwner = await claimCustodyFixture(t, { dataDir: publicRuntime.directory });
    Object.assign(publicOwner.runtime, publicRuntime.port);
    const publicPins = await publicRuntime.port.capture({ original: publicOwner.original });
    const publicOutput = path.join(publicRuntime.directory, "WIP", "public-owner-native-witness");
    let publicCollectorError;
    const publicCollector = launchClaimCustodyNativeWitness({ dataDir: publicRuntime.directory, outputDir: publicOutput,
      hostPid: publicPins.host.pid, hostBirth: publicPins.host.birthFileTime,
      nodePid: publicPins.node.pid, nodeBirth: publicPins.node.birthFileTime, originalMs: publicOwner.original.createdAtMs })
      .catch(error => { publicCollectorError = error; });
    const publicPath = path.join(publicOutput, "witness.json");
    const publicBytes = await eventually(async () => {
      if (publicCollectorError) throw publicCollectorError;
      return readFile(publicPath).catch(() => null);
    }, "public owner native witness ready");
    const publicWitness = { sourcePath: publicPath, rawSha256: createHash("sha256").update(publicBytes).digest("hex") };
    publicOwner.prepare.claim_custody.runtime_witness = publicWitness;
    try {
      const plan = await publicOwner.hub.call("hub_task_operation_reconcile", publicOwner.prepare);
      await writeFile(path.join(publicRuntime.directory, "spawn-late-child"), "");
      await writeFile(path.join(publicRuntime.directory, "release-node"), "");
      await eventually(() => exists(path.join(publicRuntime.directory,"late-child-ready")), "public owner late child");
      await writeFile(path.join(publicRuntime.directory, "release-host"), "");
      assert.equal((await publicRuntime.completion).code,0);
      const premature = { ...publicOwner.fence(plan), request_id: "premature-diagnostic-fence" };
      await assert.rejects(publicOwner.hub.call("hub_task_operation_reconcile",premature), /live owners/);
      assert.deepEqual(publicOwner.catalog.mcpOperation(publicOwner.original.requestId), publicOwner.original);
      await writeFile(path.join(publicRuntime.directory, "release-child"), "");
      await eventually(() => publicRuntime.port.assertRetired(publicOwner.catalog.mcpOperation(plan.requestId).claimCustody.cohort), "public owner whole cohort retired");
      const fence = await publicOwner.hub.call("hub_task_operation_reconcile", publicOwner.fence(plan));
      assert.equal(fence.kind,"claim-custody-fence");
      // The durable zero-active certificate owns recovery after this collector
      // closes. A lost collector after committed fence must not lose handoff.
      await closeClaimCustodyNativeWitness({ dataDir: publicRuntime.directory, witness: publicWitness });
      await publicCollector;
      const reopened = await publicOwner.open(); const hub = publicOwner.service(reopened);
      const token = hub.contextToken({ provider: "codex", threadId: publicOwner.original.threadId });
      const result = await hub.call("hub_task_claim", { ...publicOwner.consume, context_token: token });
      assert.equal(result.streamId,publicOwner.successor.id);
      assert.equal(publicOwner.prepares(),0);
      assert.deepEqual(reopened.catalog.mcpOperation(publicOwner.original.requestId), publicOwner.original);
      assert.equal(reopened.tasks.task(publicOwner.prior.id).revision,publicOwner.prior.revision+1);
      t.diagnostic(JSON.stringify({scenario:"public-MCP-real-SQLite-Git-native-job-to-managed-takeover",prepareCalls:0,originalUnknownUnchanged:true}));
    } finally {
      await closeClaimCustodyNativeWitness({ dataDir: publicRuntime.directory, witness: publicWitness }).catch(()=>{});
      await publicCollector;
    }
    if (publicCollectorError) throw publicCollectorError;
    const missing = await fixture("missing");
    await assert.rejects(missing.port.capture({ original: { createdAtMs: Date.now() } }), /runtime-job-not-observable-at-capture/);
    const breakaway = await fixture("breakaway");
    await assert.rejects(breakaway.port.capture({ original: { createdAtMs: Date.now() } }), /job-permits-breakaway/);
    await assert.rejects(f.port.capture({ original }), /primary-node-not-live-at-capture/);
  } finally {
    for (const directory of roots) {
      for (const name of ["restore-query", "release-node", "release-child", "release-host", "release-observer"]) await writeFile(path.join(directory, name), "").catch(() => {});
    }
    await Promise.all(hosts);
    // Descendants have their own graceful release and finite deadlines. Wait for
    // ordinary exit before removing owned fixtures instead of deleting beneath them.
    await eventually(async () => {
      for (const directory of roots) {
        for (const filename of ["bot.lock", "late-child-ready"]) {
          const value = await readFile(path.join(directory, filename), "utf8").catch(() => null);
          if (!value) continue;
          const pid = filename === "bot.lock" ? JSON.parse(value).pid : Number(value);
          try { process.kill(pid, 0); return false; } catch (error) { if (error.code !== "ESRCH") throw error; }
        }
      }
      return true;
    }, "owned fixture processes exited", 45_000);
    assert.equal(path.dirname(root), fixtureParent);
    await rm(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
