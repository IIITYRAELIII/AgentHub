import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";
import { packageFile } from "../filesystem/runtime-package-target.mjs";
import { processIsAlive } from "../process/process-liveness.mjs";
import { queryInstallerWorkerRetired } from "./windows-delete-verified-entry.mjs";

export const installerStorageDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const equalPath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (a, b) => { const rel = path.relative(a, b); return !rel || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)); };
const safe = name => typeof name === "string" && name && !path.isAbsolute(name)
  && name.split(/[/\\]/u).every(p => p && p !== "." && p !== ".." && !p.includes(":"));
const absent = error => { if (error.code === "ENOENT") return null; throw error; };
const sameDevice = (a, b) => /^\d+$/u.test(String(a)) && /^\d+$/u.test(String(b))
  && (process.platform === "win32" ? (BigInt(a) & 0xffffffffn) === (BigInt(b) & 0xffffffffn) : BigInt(a) === BigInt(b));

export async function installerDirectory(file) {
  file = path.resolve(file);
  for (let current = file; ; current = path.dirname(current)) {
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("installer-storage-linked-directory");
    if (path.dirname(current) === current) break;
  }
  const info = await lstat(file, { bigint: true });
  if (!equalPath(await realpath(file), file)) throw Error("installer-storage-alias");
  return { file, dev: String(info.dev), ino: String(info.ino) };
}

// Called by the exclusive creator BEFORE any backup file is written. Its
// planned namespace is not a later permission to adopt arbitrary extra files.
export async function installerBackupIntent({ directory, files }) {
  return { root: await installerDirectory(directory), files: files.map(f => ({ path: f.relative, sqlite: f.sqlite })) };
}

async function tree(directory, allowed, { partial = false, root = null } = {}) {
  const actualRoot = await installerDirectory(directory);
  if (root && installerStorageDigest(actualRoot) !== installerStorageDigest(root)) throw Error("installer-storage-root-changed");
  const files = [], directories = [];
  async function walk(parent, prefix) {
    for (const name of (await readdir(parent)).sort()) {
      const relative = prefix ? path.join(prefix, name) : name, file = path.join(parent, name);
      const stat = await lstat(file, { bigint: true });
      if (stat.isSymbolicLink()) throw Error("installer-storage-linked-entry");
      if (stat.isDirectory()) {
        if (![...allowed.keys()].some(p => p.startsWith(relative + path.sep))) throw Error("installer-storage-extra-directory");
        directories.push(relative); await walk(file, relative);
      } else {
        const expected = allowed.get(relative);
        if (!expected || !stat.isFile() || stat.nlink !== 1n) throw Error("installer-storage-foreign-file");
        const evidence = await packageFile(file);
        if (expected.sha256 && (expected.sha256 !== evidence.sha256 || expected.bytes !== evidence.bytes)) throw Error("installer-storage-content-changed");
        files.push({ path: relative, bytes: evidence.bytes, sha256: evidence.sha256 });
      }
    }
  }
  await walk(directory, "");
  if (!partial && files.length !== allowed.size) throw Error("installer-storage-incomplete");
  if (installerStorageDigest(await installerDirectory(directory)) !== installerStorageDigest(actualRoot)) throw Error("installer-storage-root-changed");
  return { directory, root: actualRoot, files, directories };
}

const records = files => {
  const map = new Map();
  for (const item of files) {
    if (!safe(item.path) || map.has(path.normalize(item.path))) throw Error("installer-storage-invalid-manifest");
    map.set(path.normalize(item.path), item);
  }
  return map;
};

export function installerStorageDisposed(operation) {
  return operation?.status === "succeeded" && operation.outcome === "succeeded"
    || operation?.status === "failed" && operation.outcome === "rolled-back"
      && operation.phase === "previous-ready" && operation.metadata?.autonomousRecovery?.retirementUnknown !== true;
}

export async function wakeInstallerRetention(store) {
  return store.runMaintenanceMutation(() => {
    const parent = store.getReadonly("storage-retention:v1");
    const index = parent?.metadata?.ownerIds?.indexOf("runtime-update-backup");
    if (!parent || index === undefined || index < 0 || ["succeeded", "failed"].includes(parent.status)) return false;
    return store.transition(parent.operationId, { metadata: { ownerIndex: Math.min(index, parent.metadata.ownerIndex ?? 0), cursor: null } },
      { expectedRevision: parent.revision }).applied;
  }, { requestId: "storage-retention:v1" });
}

// No PID kill or inference from timestamps: absence is sufficient; a live or
// denied (including reused) PID conservatively keeps the creator's artifacts.
export async function installerWorkerRetired(evidence) {
  if (!Number.isSafeInteger(evidence?.worker?.pid) || evidence.worker.pid <= 0) return false;
  if (!processIsAlive(evidence.worker.pid)) return true;
  // Legacy mutable transport records did not pin birth on the canonical
  // original. A mismatching cached birth must not retire a possibly live
  // creator. New canonical scope / explicit current custody can bind it.
  if (evidence.workerBirthBound !== true) return false;
  try { return await queryInstallerWorkerRetired(evidence.worker); } catch { return false; }
}

export async function sealAutonomousInstallerStorage({ runtimeRoot, operation, cache, pythonExe = "python", requireRetired = false }) {
  const runtime = await installerDirectory(runtimeRoot), cacheRoot = await installerDirectory(cache);
  if (within(runtime.file, cacheRoot.file) || within(cacheRoot.file, runtime.file)) throw Error("installer-storage-internal-cache");
  const request = JSON.parse(await readFile(path.join(cache, "request.json"), "utf8"));
  const binding = operation?.metadata?.autonomousInstaller;
  const worker = JSON.parse(await readFile(path.join(cache, "worker-started.json"), "utf8"));
  const dispatch = binding?.storageScope?.worker ?? JSON.parse(await readFile(path.join(cache, "dispatch.json"), "utf8"));
  if (operation.kind !== "restart" || operation.streamId !== "agent-hub-installer" || !binding
    || !equalPath(operation.threadId, runtime.file) || !equalPath(binding.runtimeRoot, runtime.file)
    || !equalPath(request.runtimeRoot, runtime.file) || request.operationId !== operation.operationId
    || !sameDevice(request.runtimeIdentity?.dev, runtime.dev) || request.runtimeIdentity?.ino !== runtime.ino
    || request.installerSha256 !== (await packageFile(path.join(cache, "install_release.py"))).sha256
    || worker.outsideAllJobs !== true || worker.pid !== dispatch.pid || worker.created !== dispatch.created
    || worker.image !== dispatch.image || dispatch.outsideAllJobs !== true) throw Error("installer-storage-origin-unproven");
  if (binding.storageScope && (!sameDevice(binding.storageScope.cache.dev, cacheRoot.dev) || binding.storageScope.cache.ino !== cacheRoot.ino
    || !equalPath(binding.storageScope.cache.path, cache) || binding.storageScope.requestSha256 !== (await packageFile(path.join(cache, "request.json"))).sha256))
    throw Error("installer-storage-cache-changed");
  // Continuations retain the earlier installer binding; their immutable SAME
  // original checkpoint must positively name this exact worker and bytes.
  const continuation = [operation.metadata.autonomousPartialResume, operation.metadata.autonomousResume]
    .find(p => p?.workerPid === worker.pid && p?.installerSha256 === request.installerSha256);
  if (!(binding.workerPid === worker.pid && binding.installerSha256 === request.installerSha256) && !continuation)
    throw Error("installer-storage-worker-unbound");
  const evidence = { schema: 1, operationId: operation.operationId, runtime, cache: cacheRoot, worker,
    workerBirthBound: Boolean(binding.storageScope?.worker),
    requestSha256: (await packageFile(path.join(cache, "request.json"))).sha256,
    installerSha256: request.installerSha256, borrowedArchive: request.archive ?? null, artifacts: [] };
  if (requireRetired && !await installerWorkerRetired(evidence)) throw Error("installer-storage-worker-live");
  const packageRoot = path.join(cache, "verified");
  const manifestFile = path.join(packageRoot, "package-manifest.json");
  if (await lstat(manifestFile).catch(absent)) {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    if (manifest.schema !== 1 || manifest.repository !== "IIITYRAELIII/AgentHub" || manifest.releaseId !== binding.releaseId
      || !Array.isArray(manifest.files)) throw Error("installer-storage-package-unbound");
    const manifestPin = await packageFile(manifestFile);
    let manifestSha256 = binding.packageManifestSha256;
    if (!manifestSha256) {
      // Historical source rows did not pin the extracted descriptor. Read it
      // from the SAME hash-verified archive, without extracting/executing it.
      const archive = request.archive ?? path.join(cache, "release.zip");
      if ((await packageFile(archive)).sha256 !== binding.archiveSha256) throw Error("installer-storage-archive-changed");
      const script = "import zipfile,hashlib,sys; z=zipfile.ZipFile(sys.argv[1]); i=z.getinfo('package-manifest.json'); assert i.file_size<=8*1024**2; print(hashlib.sha256(z.read(i)).hexdigest())";
      const result = await promisify(execFile)(pythonExe, ["-I", "-c", script, archive], { windowsHide: true, maxBuffer: 4096, timeout: 30000 });
      manifestSha256 = result.stdout.trim();
    }
    if (manifestPin.sha256 !== manifestSha256) throw Error("installer-storage-package-manifest-changed");
    evidence.artifacts.push({ kind: "payload", snapshot: await tree(packageRoot, records([
      ...manifest.files, { path: "package-manifest.json", ...manifestPin }])) });
  }
  // Only the download made by --release, never a borrowed --archive input.
  if (request.release && !request.archive) {
    const archive = path.join(cache, "release.zip");
    if (await lstat(archive).catch(absent)) {
      const saved = await packageFile(archive);
      if (saved.sha256 !== binding.archiveSha256) throw Error("installer-storage-download-unbound");
      evidence.artifacts.push({ kind: "download", snapshot: { directory: cache, root: cacheRoot,
        files: [{ path: "release.zip", ...saved }], directories: [], keepRoot: true, partialTree: true } });
    }
  }
  const backup = operation.metadata.autonomousBackup;
  const attempt = operation.metadata.autonomousBackupAttempt;
  if (backup) {
    if (!equalPath(backup.directory, path.join(cache, "backup"))) throw Error("installer-storage-backup-unbound");
    // Never add companions or other files to a historical inventory. Fresh
    // producers seal generated SQLite companions BEFORE their checkpoint.
    evidence.backup = { ...backup };
    try {
      evidence.backup.root = await installerDirectory(backup.directory);
      await tree(backup.directory, records(backup.retentionFiles ?? backup.files));
    } catch { evidence.backupUnverified = true; }
  } else if (attempt && equalPath(attempt.root?.file ?? "", path.join(cache, "backup"))) {
    const allowed = attempt.files.flatMap(file => [file, ...(file.sqlite ? ["-wal", "-shm"].map(suffix => ({ path: file.path + suffix })) : [])]);
    evidence.artifacts.push({ kind: "partial-backup", snapshot: await tree(attempt.root.file, records(allowed), { partial: true, root: attempt.root }) });
  }
  return evidence;
}

// Migration is addressed by canonical original + retained cache, never a scan.
// The immutable source row is not rewritten. A canonical storage child holds
// this owner proof, just as it holds a native deletion proof and its cursor.
export async function registerInstallerStorageEvidence({ runtimeRoot, store, operationId, cache, expectedOriginalSha256 }) {
  const operation = store.getReadonly(operationId);
  if (!installerStorageDisposed(operation) || installerStorageDigest(operation) !== expectedOriginalSha256)
    throw Error("installer-storage-disposition-required");
  const cacheRoot = await installerDirectory(cache);
  const id = `installer-storage:${installerStorageDigest([operationId, cacheRoot])}`;
  const existing = store.getReadonly(id);
  if (existing) {
    if (existing.metadata?.installerStorageEvidence?.sourceSha256 !== expectedOriginalSha256) throw Error("installer-storage-original-changed");
    return existing;
  }
  const evidence = await sealAutonomousInstallerStorage({ runtimeRoot, operation, cache, requireRetired: true });
  if (!await installerWorkerRetired(evidence)) throw Error("installer-storage-worker-live");
  if (installerStorageDigest(store.getReadonly(operationId)) !== expectedOriginalSha256) throw Error("installer-storage-original-changed");
  const receipt = store.create({ operationId: id, kind: "storage-retention", streamId: "agent-hub-runtime", threadId: "runtime-update-backup-provenance",
    status: "succeeded", outcome: "succeeded", phase: "provenance", metadata: { owner: "runtime-update-backup", installerStorageEvidence: {
      sourceId: operationId, sourceSha256: expectedOriginalSha256, evidence } } });
  await wakeInstallerRetention(store); return receipt;
}

// Explicit contemporary custody is deliberately separate from creator proof.
// This is an addressed CLI admission; automatic discovery never calls it.
export async function registerLegacyInstallerCustody({ runtimeRoot, store, previewFile, previewSha256, successorOperationId, decisionId, inspectOnly = false }) {
  if (typeof decisionId !== "string" || !decisionId.trim() || !/^[a-f0-9]{64}$/u.test(previewSha256 ?? ""))
    throw Error("installer-custody-decision-required");
  const file = await packageFile(previewFile);
  if (file.sha256 !== previewSha256) throw Error("installer-custody-preview-changed");
  const preview = JSON.parse(await readFile(previewFile, "utf8"));
  const operation = store.getReadonly(preview.original?.operationId);
  const successor = store.getReadonly(successorOperationId);
  const runtime = await installerDirectory(runtimeRoot), target = path.resolve(preview.target), cache = path.dirname(target);
  if (!isDeepStrictEqual(preview.original, operation) || operation?.status !== "failed" || !installerStorageDisposed(operation)
    || operation.metadata?.autonomousInstaller?.runtimeRoot?.toLowerCase() !== runtime.file.toLowerCase()
    || successor?.status !== "succeeded" || successor.outcome !== "succeeded"
    || successor.metadata?.autonomousInstaller?.runtimeRoot?.toLowerCase() !== runtime.file.toLowerCase()
    || path.basename(target) !== "backup" || within(runtime.file, target) || within(target, runtime.file)
    || preview.effects !== 0 || !Array.isArray(preview.files) || !Array.isArray(preview.directories))
    throw Error("installer-custody-origin-unproven");
  const id = `installer-custody:${installerStorageDigest([operation.operationId, previewSha256, decisionId])}`;
  const existing = store.getReadonly(id);
  if (existing) {
    if (existing.metadata?.installerStorageEvidence?.sourceSha256 !== installerStorageDigest(operation)) throw Error("installer-custody-original-changed");
    return existing;
  }
  const pointer = await packageFile(path.join(runtime.file, "current.json"));
  const current = JSON.parse(await readFile(pointer.file, "utf8"));
  if (current.current !== successor.metadata?.autonomousReady?.releaseId) throw Error("installer-custody-current-changed");
  const root = await installerDirectory(target);
  if (!sameDevice(preview.rootIdentity?.dev, root.dev) || preview.rootIdentity?.ino !== root.ino) throw Error("installer-custody-root-changed");
  const worker = JSON.parse(await readFile(path.join(cache, "worker-started.json"), "utf8"));
  const request = JSON.parse(await readFile(path.join(cache, "request.json"), "utf8"));
  const backupInput = JSON.parse(await readFile(path.join(cache, "input-backup.json"), "utf8"));
  if (!["pid", "created", "image", "outsideAllJobs"].every(key => worker[key] === preview.retiredWorker?.[key])
    || request.operationId !== operation.operationId || !equalPath(request.runtimeRoot, runtime.file)
    || !equalPath(backupInput.destination, target) || !await installerWorkerRetired({ worker, workerBirthBound: true }))
    throw Error("installer-custody-worker-unproven");
  for (const record of [...preview.directories, ...preview.files]) {
    if (record.relative !== "." && !safe(record.relative)) throw Error("installer-custody-invalid-path");
    const info = await lstat(path.join(target, record.relative), { bigint: true });
    if (info.isSymbolicLink() || !sameDevice(record.identity.dev, info.dev) || record.identity.ino !== String(info.ino))
      throw Error("installer-custody-entry-changed");
  }
  const allowed = records(preview.files.map(record => ({ path: record.relative, bytes: record.identity.bytes, sha256: record.sha256 })));
  const snapshot = await tree(target, allowed, { root });
  const directories = preview.directories.filter(record => record.relative !== ".").map(record => path.normalize(record.relative));
  if (!isDeepStrictEqual([...snapshot.directories].sort(), directories.sort())) throw Error("installer-custody-directory-changed");
  const evidence = { schema: 1, operationId: operation.operationId, runtime, cache: await installerDirectory(cache), worker, workerBirthBound: true,
    custody: { kind: "explicit-legacy-partial-v1", decisionId, previewSha256, successorOperationId,
      successorSha256: installerStorageDigest(successor), currentSha256: pointer.sha256 },
    artifacts: [{ kind: "partial-backup", snapshot }] };
  if (!isDeepStrictEqual(operation, store.getReadonly(operation.operationId))
    || !isDeepStrictEqual(successor, store.getReadonly(successorOperationId))
    || (await packageFile(pointer.file)).sha256 !== pointer.sha256) throw Error("installer-custody-authority-changed");
  const intake = { operationId: id, kind: "storage-retention", streamId: "agent-hub-runtime", threadId: "runtime-update-backup-provenance",
    status: "succeeded", outcome: "succeeded", phase: "provenance", metadata: { owner: "runtime-update-backup", installerStorageEvidence: {
      sourceId: operation.operationId, sourceSha256: installerStorageDigest(operation), evidence } } };
  if (inspectOnly) return { readOnly: true, intake };
  const receipt = store.create(intake); await wakeInstallerRetention(store); return receipt;
}

export async function installerCustodyCurrent(evidence, runtimeRoot, store) {
  const custody = evidence?.custody;
  return !custody || custody.kind === "explicit-legacy-partial-v1"
    && installerStorageDigest(store.getReadonly(custody.successorOperationId)) === custody.successorSha256
    && (await packageFile(path.join(runtimeRoot, "current.json"))).sha256 === custody.currentSha256;
}
