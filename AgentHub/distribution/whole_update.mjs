/** Real isolated Windows Hub/package lifecycle. External provider and download
 * peers are controlled; application, stores, IPC, backup, installer and Host are real.
 * Usage: node distribution/whole_update.mjs <artifacts.json> <new-output-directory>
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { finished } from "node:stream/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { releaseAcceptanceConfig, inspectAcceptanceArtifact, prepareAcceptanceRestartTarget, waitForAcceptanceHost } from "../src/runtime/test-contour-release-acceptance.mjs";
import { LoopbackTelegramApi } from "../src/infrastructure/network/loopback-telegram-api.mjs";
import { callDesktopControl } from "../src/infrastructure/process/desktop-control.mjs";
import { createTestResourceMonitor } from "../src/infrastructure/process/test-resource-monitor.mjs";
import { processIsAlive } from "../src/infrastructure/process/process-liveness.mjs";
import { installPreparedRuntime } from "../src/runtime/runtime-manager.mjs";
import { MaintenanceOperationStore } from "../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { MAINTENANCE_OPERATION_KINDS } from "../src/domain/maintenance-operation.mjs";
import { createInterface } from "node:readline";

const execute = promisify(execFile), here = import.meta.dirname, source = path.resolve(here, "..");
const [artifactFile, outputArgument] = process.argv.slice(2);
const mode = process.argv[4] ?? "whole";
if (!["whole", "downgrade", "poststop-recovery"].includes(mode)) throw Error("Unknown isolated scenario");
if (process.platform !== "win32" || !artifactFile || !outputArgument) throw Error("Windows artifacts.json and new isolated output required");
const input = JSON.parse(await fs.readFile(artifactFile, "utf8")), output = path.resolve(outputArgument);
await fs.mkdir(output); // Exclusive: never adopt an existing instance/data/cache.
const root = path.join(output, "runtime"), fixtures = path.join(root, "fixtures"), id = randomUUID();
const report = { id, root, source: input, status: "running", boundaries: { application: "real Hub composition", transport: "local exact HTTP mapped from canonical URLs, no public TLS proof", provider: "existing fake Codex and loopback Telegram, no real account", nativeHost: "real owned Windows cohort" }, events: [] };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const json = file => fs.readFile(file, "utf8").then(JSON.parse);
const save = () => fs.writeFile(path.join(output, "result.json"), JSON.stringify(report, null, 2));
const event = async (stage, details = {}) => { report.events.push({ stage, at: new Date().toISOString(), elapsedMs: performance.now() - started, ...details }); await save(); console.log(stage); };
const started = performance.now();
await save();
let monitor, sampling, samplingError, server, telegram, host, externalSampler, externalLines, externalExit, lastOperation;
const samples = [], children = new Set();
const essential = new Set(["SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "PATH", "PATHEXT", "COMSPEC", "OS",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "USERNAME", "USERDOMAIN", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"]);
const cleanEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => essential.has(key.toUpperCase())));
cleanEnvironment.PYTHONUTF8 = "1"; cleanEnvironment.PYTHONIOENCODING = "utf-8";
for (const [key, name] of [["TEMP", "temp"], ["TMP", "temp"], ["LOCALAPPDATA", "local"], ["APPDATA", "roaming"], ["USERPROFILE", "home"], ["HOME", "home"]]) {
  await fs.mkdir(path.join(output, name), { recursive: true }); cleanEnvironment[key] = path.join(output, name);
}
cleanEnvironment.PSModuleAnalysisCachePath = path.join(output, "temp", "powershell-module-analysis-cache");
report.childEnvironmentKeys = Object.keys(cleanEnvironment).sort();
async function run(name, command, args, { input: stdin, timeout = 180_000, env = cleanEnvironment } = {}) {
  const child = spawn(command, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); children.add(child);
  const out = createWriteStream(path.join(output, `${name}.stdout`)), err = createWriteStream(path.join(output, `${name}.stderr`));
  child.stdout.pipe(out); child.stderr.pipe(err); child.stdin.end(stdin);
  const timer = setTimeout(() => { report.timeout = { name, pid: child.pid }; child.kill(); }, timeout); timer.unref();
  try {
    const [code, signal] = await once(child, "close"); await Promise.all([finished(out), finished(err)]);
    const result = { name, code, signal, pid: child.pid }; await fs.writeFile(path.join(output, `${name}.exit.json`), JSON.stringify(result));
    if (code !== 0) throw Object.assign(Error(`${name} failed: ${await fs.readFile(path.join(output, `${name}.stderr`), "utf8")}`), { result });
    return await fs.readFile(path.join(output, `${name}.stdout`), "utf8");
  } finally { clearTimeout(timer); children.delete(child); }
}
async function wait(predicate, label, timeout = 120_000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw Error(`Owned boundary not reached: ${label}`);
}
function operation() {
  let db; try { db = new DatabaseSync(path.join(root, "data/runtime.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT operation_json FROM maintenance_operations WHERE operation_id=?").get(id);
    const value = row ? JSON.parse(row.operation_json) : null;
    lastOperation = value;
    const observations = report.operationObservations ??= [];
    if (value && observations.at(-1)?.revision !== value.revision) observations.push({ operationId: id,
      observedAt: new Date().toISOString(), revision: value.revision, status: value.status, phase: value.phase,
      updatedAt: value.updatedAt, blockers: value.blockers });
    return value;
  } catch (error) {
    if ([5, 6].includes(error.errcode)) {
      // Backup's real writer reservations may temporarily prevent this readonly
      // observer. Keep waiting on the same original; never infer its outcome.
      report.busyReadObservations = (report.busyReadObservations ?? 0) + 1;
      return null;
    }
    if (/no such table|unable to open/u.test(error.message)) return null;
    throw error;
  }
  finally { db?.close(); }
}
try {
  monitor = await createTestResourceMonitor();
  externalSampler = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", path.join(here, "whole-update-resources.ps1")],
    { windowsHide: true, env: cleanEnvironment, stdio: ["pipe", "pipe", "pipe"] });
  externalSampler.stderr.pipe(createWriteStream(path.join(output, "external-resource.stderr")));
  externalLines = createInterface({ input: externalSampler.stdout });
  externalExit = once(externalSampler, "close");
  externalSampler.stdin.on("error", error => { samplingError ??= error; });
  let sampleActive = true;
  sampling = (async () => { while (sampleActive) {
    const roots = [], metadata = lastOperation?.metadata;
    if (metadata?.packageNative) roots.push({ pid: metadata.packageNative.hostPid, started: metadata.packageNative.hostStarted });
    if (metadata?.packageLaunchAdmission) roots.push({ pid: metadata.packageLaunchAdmission.hostPid, started: metadata.packageLaunchAdmission.hostStarted });
    const reply = once(externalLines, "line");
    externalSampler.stdin.write(JSON.stringify({ harnessPid: process.pid, roots }) + "\n");
    const external = JSON.parse((await Promise.race([reply, externalExit.then(([code]) => { throw Error(`External sampler exited before reply: ${code}`); })]))[0]), job = await monitor.sample();
    const extra = external.processes.reduce((sum, value) => sum + value.workingSetBytes, 0);
    samples.push({ at: Date.now(), operationId: id, originalPhase: lastOperation?.phase ?? null, ...job, jobWorkingSetBytes: job.rssBytes, jobProcesses: job.processes,
      rssBytes: job.rssBytes + extra, processes: job.processes + external.processes.length, external });
    await new Promise(resolve => setTimeout(resolve, 1_000));
  } })().catch(error => { samplingError = error; });
  report.stopSampling = () => { sampleActive = false; };
  await fs.mkdir(fixtures, { recursive: true });
  const packages = [];
  for (const [index, artifact] of input.artifacts.entries()) {
    await inspectAcceptanceArtifact(artifact.releaseRoot);
    if (index === 0) continue; // Initial private instance setup, not the tested public update.
    const archive = path.join(path.dirname(path.resolve(artifactFile)), "packages", `package-${index}`, "AgentHub-win32-x64.zip");
    if (!await fs.stat(archive).catch(error => { if (error.code === "ENOENT") return null; throw error; }))
      await run(`package-${index}`, "python", ["-X", "utf8", "-B", path.join(here, "build_package.py"), "--prepared-runtime", artifact.releaseRoot,
      "--license", path.join(source, "..", "LICENSE"), "--notices", path.join(source, "..", "THIRD_PARTY_NOTICES.md"), "--source-commit", input.revision, "--output", archive]);
    const value = await json(`${archive}.json`);
    assert.equal(value.sourceCommit, input.revision); assert.equal(value.releaseId, artifact.releaseId);
    const packageManifest = JSON.parse((await execute("python", ["-X", "utf8", "-c",
      "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('package-manifest.json').decode('utf-8'))", archive],
    { windowsHide: true, env: cleanEnvironment, maxBuffer: 8 * 1024 * 1024 })).stdout);
    assert.equal(packageManifest.preparedManifestSha256, hash(await fs.readFile(path.join(artifact.releaseRoot, "runtime-manifest.json"))));
    assert.equal(value.sha256, hash(await fs.readFile(archive)));
    packages[index] = { archive, descriptor: `${archive}.json`, value };
  }
  await event("verified-local-artifacts");
  const previous = input.artifacts[0], previousRoot = path.join(root, "releases", previous.releaseId);
  const previousManifest = await json(path.join(previous.releaseRoot, "runtime-manifest.json"));
  for (const name of [...previousManifest.files.map(file => file.path), "runtime-manifest.json"]) {
    const target = path.join(previousRoot, name); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(previous.releaseRoot, name), target, 1);
  }
  await installPreparedRuntime({ runtimeRoot: root, releaseId: previous.releaseId });
  await event("initial-private-instance-prepared");
  telegram = new LoopbackTelegramApi(); await telegram.start();
  const fake = path.join(root, "providers", "fake-codex-app-server.mjs"); await fs.mkdir(path.dirname(fake));
  // External fixture only. A bounded held turn finishes normally after the
  // test's release file; no product controller/active count is substituted.
  await fs.copyFile(path.join(source, "e2e/fake-codex-app-server.mjs"), fake, 1);
  const config = releaseAcceptanceConfig({ root, telegramApiBaseUrl: telegram.baseUrl, fakeCodexFile: fake });
  config.usageSyncServerUrl = "";
  config.codexExecutableArgs = [fake, "--require-test-contour", "--state", path.join(root, "data/fake-codex-state.json"), "--whole-release-file", path.join(fixtures, "work-complete")];
  await fs.mkdir(path.join(root, "project")); await fs.writeFile(path.join(root, "config.json"), JSON.stringify(config));
  const installer = path.join(output, "install_release.py"); await fs.copyFile(path.join(here, "install_release.py"), installer);
  const target = packages[1], tag = target.value.publicVersion, assetBase = `https://github.com/IIITYRAELIII/AgentHub/releases/download/${tag}/`;
  const assets = { "AgentHub-win32-x64.zip": target.archive, "AgentHub-win32-x64.zip.json": target.descriptor, "install_release.py": installer };
  const metadata = { tag_name: tag, draft: false, prerelease: false, published_at: "2026-01-01T00:00:00Z", assets: [] };
  for (const [name, file] of Object.entries(assets)) { const bytes = await fs.readFile(file); metadata.assets.push({ name, state: "uploaded", size: bytes.length, digest: `sha256:${hash(bytes)}`, browser_download_url: `${assetBase}${name}` }); }
  await fs.writeFile(path.join(output, "transport-metadata.json"), JSON.stringify(metadata, null, 2));
  server = createServer((request, response) => {
    if (request.url === "/metadata") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(metadata)); }
    else { const file = assets[String(request.url).slice(1)]; if (!file) { response.writeHead(404).end(); return; }
      fs.stat(file).then(stat => { response.setHeader("Content-Length", stat.size); createReadStream(file).pipe(response); }); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const controlFile = path.join(fixtures, "control.json"), preload = path.join(fixtures, "whole-update-preload.mjs");
  await fs.copyFile(path.join(here, "whole-update-preload.mjs"), preload);
  const control = { root, metadataUrl: `https://api.github.com/repos/IIITYRAELIII/AgentHub/releases/tags/${tag}`,
    temporaryRoot: path.join(output, "temp"), telegramApiBaseUrl: telegram.baseUrl, transport: `http://127.0.0.1:${server.address().port}`, assetBase, assetNames: Object.keys(assets),
    churn: mode === "whole" ? "replacement" : null,
    ...(mode === "poststop-recovery" ? { installFailurePath: path.join(root, "releases", target.value.releaseId) } : {}) };
  await fs.writeFile(controlFile, JSON.stringify(control));
  await fs.writeFile(path.join(root, ".agent-hub-release-acceptance.json"), JSON.stringify({ schemaVersion: 1, id, root,
    nodeImport: { file: preload, sha256: hash(await fs.readFile(preload)) } }));
  await run("external-provider-port-control", process.execPath, [path.join(here, "whole-update-provider-guard-test.mjs"),
    preload, root, path.join(previousRoot, "agent-hub-main.mjs")]);
  // A distinct test-owned maintenance scope is inert; its canonical UNKNOWN
  // receipt is preserved, never reconciled or used to bypass active work.
  const unknownRelative = path.join("locks", "retained-unknown");
  await fs.mkdir(path.join(root, "data", unknownRelative), { recursive: true });
  const unknownStore = new MaintenanceOperationStore({ dataDir: path.join(root, "data", unknownRelative) });
  const unknownOriginal = unknownStore.create({ operationId: "unrelated-owned-unknown", kind: MAINTENANCE_OPERATION_KINDS.CONTEXT_COMPACTION,
    streamId: "retained-test-scope", threadId: "retained-test-thread", status: "reconciling", outcome: "unknown", phase: "reconciling" });
  report.retainedUnknown = unknownOriginal;
  await fs.writeFile(path.join(root, "data/whole-update-cursor.keep"), "owned cursor 19");
  const launcher = path.join(root, "AgentHub.RuntimeHost.exe");
  host = spawn(launcher, [], { env: cleanEnvironment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  host.stdout.pipe(createWriteStream(path.join(output, "host.stdout"))); host.stderr.pipe(createWriteStream(path.join(output, "host.stderr")));
  await waitForAcceptanceHost(host, { runtimeRoot: root, expectedReleaseId: input.artifacts[0].releaseId, timeoutMs: 120_000 });
  const before = await json(path.join(root, "data/bot.lock")); report.before = before;
  if (mode === "whole") {
  await prepareAcceptanceRestartTarget({ root, telegram });
  telegram.pushMessage("[whole-update-wait] finish only after package admission");
  await wait(async () => { const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot: root });
    await fs.writeFile(path.join(output, "active-work-snapshot.json"), JSON.stringify(snapshot));
    return (await fs.readFile(path.join(root, "data/fake-codex-state.json"), "utf8")).includes("[whole-update-wait]"); }, "real owned turn active");
  } else {
    // These affected cases do not repeat run13's owned-provider-work scenario.
    // Join observable startup enrichment rather than racing its config writes.
    await wait(async () => {
      const health = await callDesktopControl("runtime-health", {}, { runtimeRoot: root });
      return health.ready && !health.startup?.operations?.some(value => value.state === "running");
    }, "initial startup owners settled");
  }
  const cli = ["-X", "utf8", "-B", path.join(here, "whole-update-transport.py"), controlFile, installer, "--release", tag,
    "--prepare-update", "--operation-id", id, "--runtime-root", root, "--scratch-root", path.join(output, "cache")];
  let admissionError;
  try { await run("public-installer-admission", "python", cli, { input: "\n", env: { ...cleanEnvironment, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } }); }
  catch (error) { admissionError = error; }
  if (mode === "downgrade") {
    assert.match(admissionError?.message ?? "", /Version\/build downgrade or reuse refused/u);
    assert.equal(operation(), null);
    assert.deepEqual(await json(path.join(root, "data/bot.lock")), before);
    assert.ok(processIsAlive(before.pid));
    assert.equal((await json(path.join(root, "current.json"))).current, before.releaseId);
    await fs.writeFile(path.join(fixtures, "work-complete"), "complete normally");
    report.after = before; report.status = "passed";
    await event("downgrade-refused-before-any-original-or-stop", { previousVersion: previousManifest.releaseVersion, targetVersion: target.value.version });
  } else {
  if (admissionError) throw admissionError;
  let blocked;
  if (mode === "whole") {
  blocked = await wait(() => operation()?.status === "blocked" && operation(), "canonical blocked request");
  report.blocked = blocked; assert.equal((await json(path.join(root, "data/bot.lock"))).pid, before.pid);
  await event("real-owner-waits-for-owned-work", { operationId: id });
  await fs.writeFile(path.join(fixtures, "work-complete"), "complete normally");
  }
  if (mode === "poststop-recovery") {
    const completed = await wait(() => operation()?.status === "failed" && operation(), "failed installer and restored original", 180_000);
    assert.equal(completed.metadata.packageCurrentRecoveryReady, true);
    assert.equal(completed.metadata.packageFailurePhase, "package-installing");
    assert.notEqual(completed.metadata.packageCurrentRecovery.installerExitCode, 0);
    const lock = await wait(async () => { const value = await json(path.join(root, "data/bot.lock")).catch(() => null);
      return value?.ready && value.releaseId === before.releaseId && value.pid !== before.pid && value; }, "verified previous current Ready");
    const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot: root });
    assert.equal(snapshot.server.process.pid, lock.pid); assert.equal(snapshot.server.process.releaseId, before.releaseId);
    assert.equal((await json(path.join(root, "current.json"))).current, before.releaseId);
    await inspectAcceptanceArtifact(path.join(root, "releases", before.releaseId));
    assert.equal(hash(await fs.readFile(launcher)), hash(await fs.readFile(path.join(previousRoot, "AgentHub.RuntimeHost.exe"))));
    const backup = completed.metadata.packageBackup.directory;
    for (const data of [path.join(root, "data"), path.join(backup, "data")]) {
      assert.deepEqual(new MaintenanceOperationStore({ dataDir: path.join(data, unknownRelative) }).getReadonly(unknownOriginal.operationId), unknownOriginal);
      assert.equal(await fs.readFile(path.join(data, "whole-update-cursor.keep"), "utf8"), "owned cursor 19");
    }
    assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), await fs.readFile(path.join(backup, "config.json"), "utf8"));
    const cache = (await fs.readdir(path.join(output, "cache"))).find(name => name.startsWith("agenthub-update-"));
    const requestFile = path.join(output, "cache", cache, "update-request.json");
    const entry = path.join(previousRoot, "src/runtime/runtime-package-handoff.mjs"), completedBytes = JSON.stringify(completed);
    await run("terminal-original-readback", process.execPath, [entry, "bootstrap-start", requestFile]);
    assert.equal(JSON.stringify(operation()), completedBytes);
    assert.equal((await json(path.join(root, "data/bot.lock"))).pid, lock.pid);
    await wait(() => !processIsAlive(completed.metadata.packageNative.hostPid), "native recovery owner joined");
    const lifetime = (await fs.readFile(path.join(root, "data/runtime-host-lifetime.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const starts = lifetime.filter(value => value.stage === "node-start" && value.hostPid === completed.metadata.packageLaunchAdmission.hostPid);
    assert.equal(starts.length, 1); assert.equal(starts[0].childPid, lock.pid);
    assert.equal(await fs.readFile(control.installFailurePath, "utf8"), "owned obstructing target path");
    report.completed = completed; report.after = lock; report.snapshot = snapshot; report.effectObservations = { replacementStarts: starts };
    await event("failed-installer-restored-same-current-ready", { originalOutcome: completed.outcome }); report.status = "passed";
  } else {
  const failed = await wait(() => operation()?.status === "failed" && operation(), "typed pre-stop failure");
  assert.equal(failed.metadata.packagePreStopFailure?.phase, "package-backup-preflight");
  assert.equal((await json(path.join(root, "current.json"))).current, before.releaseId);
  assert.equal((await json(path.join(root, "data/bot.lock"))).pid, before.pid); assert.ok(processIsAlive(before.pid));
  report.failedAttempt = failed; await event("failed-pre-stop-original-preserved");
  const replacement = await json(path.join(fixtures, "replacement.json"));
  assert.ok(path.dirname(replacement.ready) === path.join(root, "data"));
  assert.equal(await fs.readFile(path.join(replacement.ready, "foreign-state.json"), "utf8"), "owned negative fixture");
  await fs.rm(replacement.ready, { recursive: true }); // Only the exact fixture entry we created.
  control.churn = "retirement"; await fs.writeFile(controlFile, JSON.stringify(control));
  const cache = (await fs.readdir(path.join(output, "cache"))).find(name => name.startsWith("agenthub-update-"));
  const requestFile = path.join(output, "cache", cache, "update-request.json");
  const entry = path.join(root, "releases", before.releaseId, "src/runtime/runtime-package-handoff.mjs");
  const continuation = await run("fresh-continuation-input", process.execPath, [entry, "resume-input", requestFile, String(failed.revision), failed.metadata.packageHandoff.sha256]);
  const continuationFile = path.join(output, "same-continuation.json"); await fs.writeFile(continuationFile, continuation);
  const addressed = JSON.parse(continuation), refusals = [];
  for (const [name, value] of [
    ["foreign-original", { ...addressed, input: { ...addressed.input, operationId: `${id}-foreign` } }],
    ["changed-cas", { ...addressed, expectedRevision: addressed.expectedRevision + 1 }],
    ["changed-assets", { ...addressed, input: { ...addressed.input, archive: addressed.input.descriptor } }],
    ["changed-current", { ...addressed, expectedCurrent: { ...addressed.expectedCurrent, pid: addressed.expectedCurrent.pid + 1 } }],
    ["foreign-field", { ...addressed, clientTiming: {} }],
  ]) {
    let refusal;
    try { await callDesktopControl("resume-package", value, { runtimeRoot: root, timeoutMs: 120_000 }); }
    catch (error) { refusal = error; }
    assert.ok(refusal?.desktopControlRejected === true, `Expected actual authenticated refusal: ${name}`);
    assert.deepEqual(operation(), failed); refusals.push({ name, error: refusal.message });
  }
  await fs.writeFile(path.join(output, "addressed-refusals.json"), JSON.stringify(refusals, null, 2));
  await run("same-original-resume-lost-reply", process.execPath, [path.join(here, "whole-update-lost-reply.mjs"), entry, requestFile, continuationFile]);
  await run("same-original-readback-after-lost-reply", process.execPath, [entry, "resume", requestFile, continuationFile]);
  await event("same-original-fresh-attempt-admitted");
  const completed = await wait(() => operation()?.status === "succeeded" && operation(), "real replacement original succeeded", 180_000);
  const lock = await wait(async () => { const value = await json(path.join(root, "data/bot.lock")).catch(() => null); return value?.ready && value.releaseId === input.artifacts[1].releaseId && value; }, "new real Hub Ready");
  const snapshot = await callDesktopControl("snapshot", {}, { runtimeRoot: root });
  assert.equal(snapshot.server.process.pid, lock.pid); assert.equal(snapshot.server.process.releaseId, lock.releaseId);
  assert.equal((await json(path.join(root, "current.json"))).current, lock.releaseId); assert.notEqual(lock.pid, before.pid);
  await inspectAcceptanceArtifact(path.join(root, "releases", lock.releaseId));
  const traceDatabase = new DatabaseSync(path.join(root, "data/command-traces.sqlite"), { readOnly: true });
  try {
    report.originalCommandSpans = traceDatabase.prepare("SELECT * FROM command_trace_spans WHERE command_id=? ORDER BY observed_at_ms,rowid").all(id);
  } finally { traceDatabase.close(); }
  // Intake measures blockers before projecting the original. Its initial wait
  // is the canonical blocked receipt; a readiness callback need not run again
  // while that same work remains active.
  assert.equal(blocked.phase, "waiting-for-work");
  assert.ok(blocked.metadata.blockingCount > 0);
  assert.ok(Date.parse(failed.updatedAt) > Date.parse(blocked.createdAt));
  assert.ok(report.originalCommandSpans.some(span => span.stage === "restart-readiness" && span.outcome === "ready"));
  assert.ok(report.originalCommandSpans.some(span => span.stage === "restart-package-backup-preflight" && span.outcome === "failed"));
  for (const stage of ["package-backup-preflight", "quiesce", "save-state", "drain", "package-arm", "package-close"]) {
    assert.ok(report.originalCommandSpans.some(span => span.stage === `restart-${stage}` && span.outcome === "succeeded"), `Missing original measured stage ${stage}`);
  }
  await fs.writeFile(path.join(output, "original-command-spans.json"), JSON.stringify(report.originalCommandSpans, null, 2));
  assert.deepEqual(completed.metadata.packageAttemptHistory, [failed]);
  const backup = completed.metadata.packageBackup.directory;
  for (const data of [path.join(root, "data"), path.join(backup, "data")]) {
    const retained = new MaintenanceOperationStore({ dataDir: path.join(data, unknownRelative) });
    assert.deepEqual(retained.getReadonly(unknownOriginal.operationId), unknownOriginal);
    assert.equal(await fs.readFile(path.join(data, "whole-update-cursor.keep"), "utf8"), "owned cursor 19");
  }
  assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), await fs.readFile(path.join(backup, "config.json"), "utf8"));
  const completedBytes = JSON.stringify(completed);
  for (const name of ["lost-reply-readback", "repeated-same-request"]) await run(name, process.execPath,
    [path.join(root, "releases", lock.releaseId, "src/runtime/runtime-package-handoff.mjs"), "resume", requestFile, continuationFile]);
  assert.equal(JSON.stringify(operation()), completedBytes); assert.equal((await json(path.join(root, "data/bot.lock"))).pid, lock.pid);
  await wait(() => !processIsAlive(completed.metadata.packageNative.hostPid), "owned native continuation joined");
  const lifetime = (await fs.readFile(path.join(root, "data/runtime-host-lifetime.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const replacementStarts = lifetime.filter(value => value.stage === "node-start" && value.hostPid === completed.metadata.packageLaunchAdmission.hostPid);
  assert.equal(replacementStarts.length, 1); assert.equal(replacementStarts[0].childPid, lock.pid);
  let backups = 0;
  for (const name of await fs.readdir(path.join(output, "temp"))) if (name.startsWith("agent-hub-package-"))
    if ((await fs.stat(path.join(output, "temp", name, "backup")).catch(error => { if (error.code === "ENOENT") return null; throw error; }))?.isDirectory()) backups++;
  assert.equal(backups, 1); report.effectObservations = { backups, replacementStarts };
  report.completed = completed; report.after = lock; report.snapshot = snapshot;
  await fs.writeFile(path.join(output, "telegram-calls.json"), JSON.stringify(telegram.calls, null, 2));
  await event("whole-update-ready-and-same-request-readback"); report.status = "passed";
  }
  }
} catch (error) { report.status = "failed"; report.error = { message: error.message, stack: error.stack }; throw error; }
finally {
  report.stopSampling?.(); delete report.stopSampling;
  await sampling;
  if (externalSampler) { externalSampler.stdin.end("close\n"); const exit = await externalExit; if (exit[0] !== 0) samplingError ??= Error(`External accounting failed ${exit[0]}`); externalLines.close(); }
  if (monitor) await monitor.close();
  if (samplingError) report.status = "failed";
  const forbiddenProcesses = samples.flatMap(sample => [...sample.external.processes, ...(sample.external.baselineProcesses ?? [])])
    .filter(value => /^(?:claude|codex)$/iu.test(String(value.name ?? "")));
  report.unexpectedProviderProcesses = forbiddenProcesses;
  if (forbiddenProcesses.length) report.status = "failed";
  report.resources = { samples, samplingError: samplingError?.message, peakWorkingSetBytes: Math.max(0, ...samples.map(s => s.rssBytes)), peakProcesses: Math.max(0, ...samples.map(s => s.processes)) };
  // A failed observation/assertion cannot race teardown against an already
  // admitted native installer. Join that same owned continuation first.
  if (lastOperation?.metadata?.packageNative?.hostPid) {
    await wait(() => !processIsAlive(lastOperation.metadata.packageNative.hostPid), "owned admitted continuation drain", 300_000);
  }
  try { if (host) await execute(path.join(root, "AgentHub.RuntimeHost.exe"), ["--close-release-acceptance"], { env: { ...cleanEnvironment, AGENT_HUB_RUNTIME_ROOT: root }, windowsHide: true, timeout: 15_000 }); }
  catch (error) { report.cleanupError = error.message; report.status = "failed"; }
  if (host && host.exitCode === null) await Promise.race([once(host, "close"), new Promise((_, reject) => setTimeout(() => reject(Error("Owned Host did not join")), 15_000))]);
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await telegram?.stop(); report.ownedChildren = [...children].map(child => ({ pid: child.pid, code: child.exitCode }));
  report.finishedAt = new Date().toISOString(); await save();
  if (report.status !== "passed") process.exitCode = 1;
}
