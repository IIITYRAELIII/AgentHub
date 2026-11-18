import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { packageFile } from "../filesystem/runtime-package-target.mjs";
import { deleteVerifiedWindowsEntry } from "./windows-delete-verified-entry.mjs";
import { installerStorageDigest, installerStorageDisposed, installerWorkerRetired, sealAutonomousInstallerStorage, installerCustodyCurrent } from "./autonomous-installer-storage.mjs";

const LIMIT = 5;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalize = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const inside = (root, child) => {
  const relative = path.relative(normalize(root), normalize(child));
  return !relative || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
};
const missing = error => error.code === "ENOENT";
const pin = info => ({ dev: String(info.dev), ino: String(info.ino) });
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const safeRelative = name => typeof name === "string" && name && !path.isAbsolute(name)
  && name.split(/[/\\]/u).every(part => part && part !== "." && part !== ".." && !part.includes(":"));

async function plainDirectory(file) {
  const info = await lstat(file, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("backup-directory-unproven");
  return { file, ...pin(info) };
}

async function ancestors(directory) {
  const result = [];
  for (let file = path.resolve(directory); ; file = path.dirname(file)) {
    result.push(await plainDirectory(file));
    if (path.dirname(file) === file) break;
  }
  return result;
}

async function assertDirectories(entries) {
  for (const entry of entries) {
    if (!same(entry, await plainDirectory(entry.file))) throw new Error("backup-ancestor-changed");
  }
}

// The backup owner can create WAL/SHM while checking its own copied SQLite.
// Bind those generated files before the successful snapshot is checkpointed;
// never adopt extra files into a historical original during retention.
export async function sealRuntimeUpdateBackup(snapshot) {
  const files = [...snapshot.files], declared = new Set(files.map(f => normalize(f.path)));
  for (const record of snapshot.files) {
    const file = path.join(snapshot.directory, record.path);
    const handle = await open(file, "r");
    const header = Buffer.alloc(16);
    try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    if (!header.equals(Buffer.from("SQLite format 3\0"))) continue;
    for (const suffix of ["-wal", "-shm"]) {
      const relative = record.path + suffix;
      if (declared.has(normalize(relative))) continue;
      const evidence = await packageFile(path.join(snapshot.directory, relative))
        .catch(error => { if (missing(error)) return null; throw error; });
      if (evidence) files.push({ path: relative, bytes: evidence.bytes, sha256: evidence.sha256 });
    }
  }
  return { ...snapshot, retentionFiles: files };
}

// The original update owns the backup reference. StorageRetentionService owns
// each admitted deletion and its recovery. There is no second backup registry.
export class RuntimeUpdateBackupRetention {
  id = "runtime-update-backup";
  #bad = new Set();
  #runtimePin = null;
  #last = { limit: LIMIT, state: "not-run", limitMet: false };

  constructor({ runtimeRoot, store, isStopping = () => false,
    deleteEntry = deleteVerifiedWindowsEntry, beforeDelete = null, maxEntries = 16, trace = null } = {}) {
    Object.assign(this, { runtimeRoot: path.resolve(runtimeRoot), store, isStopping, deleteEntry, beforeDelete, maxEntries, trace });
  }

  status() { return structuredClone(this.#last); }

  #original(operation, evidence = null, artifact = null) {
    const autonomous = operation?.metadata?.autonomousInstaller;
    const snapshot = artifact?.snapshot ?? evidence?.backup ?? operation?.metadata?.autonomousBackup ?? operation?.metadata?.packageBackup;
    const envelope = operation?.metadata?.packageHandoff;
    const binding = autonomous ? { operationId: operation.operationId, runtimeRoot: autonomous.runtimeRoot, scratchRoot: evidence?.cache?.file } : envelope?.binding;
    if (artifact && (!["payload", "download", "partial-backup"].includes(artifact.kind)
      || artifact.kind === "download" && (snapshot.files?.length !== 1 || snapshot.files[0].path !== "release.zip" || !snapshot.keepRoot)))
      throw Error("backup-artifact-scope-unproven");
    const owned = autonomous ? evidence?.schema === 1 && evidence.operationId === operation.operationId
      && operation.streamId === "agent-hub-installer" && normalize(operation.threadId) === normalize(this.#runtimePin.file)
      && same(evidence.runtime, this.#runtimePin) && normalize(evidence.runtime.file) === normalize(this.#runtimePin.file)
      : operation?.streamId === "agent-hub-runtime" && operation?.threadId === "agent-hub-runtime"
        && envelope?.sha256 === digest(binding);
    if (operation?.invalid || operation?.kind !== "restart" || operation.streamId !== "agent-hub-runtime"
      && !autonomous || !owned || !binding
      || binding.operationId !== operation.operationId || normalize(binding.runtimeRoot) !== normalize(this.#runtimePin.file)
      || !path.isAbsolute(binding.scratchRoot ?? "") || inside(this.#runtimePin.file, binding.scratchRoot)
      || !snapshot || !path.isAbsolute(snapshot.directory ?? "")
      || evidence?.borrowedArchive && inside(snapshot.directory, evidence.borrowedArchive)
      || normalize(snapshot.directory) !== normalize(artifact ? artifact.kind === "download" ? binding.scratchRoot
        : path.join(binding.scratchRoot, artifact.kind === "partial-backup" ? "backup" : "verified") : path.join(binding.scratchRoot, "backup"))
      || !Array.isArray(snapshot.files) || !snapshot.files.length && !artifact
      || Object.values(binding.target ?? {}).some(value => value?.file && inside(snapshot.directory, value.file))) {
      throw new Error("backup-original-unproven");
    }
    const names = new Map();
    for (const file of snapshot.retentionFiles ?? snapshot.files) {
      if (!safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "") || names.has(normalize(file.path))) {
        throw new Error("backup-manifest-unproven");
      }
      names.set(normalize(file.path), file);
    }
    if (snapshot.files.some(file => {
      const saved = names.get(normalize(file.path));
      return !saved || saved.path !== file.path || saved.bytes !== file.bytes || saved.sha256 !== file.sha256;
    })) {
      throw new Error("backup-payload-manifest-changed");
    }
    if (snapshot.directories?.some(name => !safeRelative(name))) throw Error("backup-directory-manifest-unproven");
    return { id: artifact ? `${operation.operationId}:installer:${artifact.kind}:${digest(evidence.cache).slice(0, 16)}` : operation.operationId,
      sourceId: operation.operationId, operation, snapshot, evidence, artifact,
      snapshotDigest: digest({ operationId: operation.operationId, bindingSha256: autonomous ? installerStorageDigest(evidence) : envelope.sha256, snapshot }) };
  }

  async #inventory() {
    const physical = await plainDirectory(await realpath(this.runtimeRoot));
    if (this.#runtimePin && (physical.file !== this.#runtimePin.file || !same(physical, this.#runtimePin))) {
      throw new Error("backup-runtime-root-changed");
    }
    this.#runtimePin ??= physical;
    const rows = []; let cursor = "", done = false;
    while (!done) {
      const page = this.store.listPackageBackupOriginsReadonly({ after: cursor });
      rows.push(...page.items); cursor = page.cursor; done = page.done;
    }
    const evidenceRows = []; let evidenceCursor = "", evidenceDone = false;
    while (this.store.listInstallerStorageEvidenceReadonly && !evidenceDone) {
      const page = this.store.listInstallerStorageEvidenceReadonly({ after: evidenceCursor });
      evidenceRows.push(...page.items); evidenceCursor = page.cursor; evidenceDone = page.done;
    }
    const entries = [], migrations = []; let unverified = 0;
    const expanded = [];
    for (const operation of rows) {
      const imported = evidenceRows.filter(row => row.metadata?.owner === this.id
        && (row.phase === "provenance" || row.metadata.admitted === true
          && installerStorageDigest(row.metadata.installerStorageEvidence?.evidence) === row.metadata.binding?.evidenceDigest)
        && row?.metadata?.installerStorageEvidence?.sourceId === operation.operationId
        && row.metadata.installerStorageEvidence.sourceSha256 === installerStorageDigest(operation));
      const proofs = [operation.metadata?.autonomousStorage, ...imported.map(row => row.metadata.installerStorageEvidence.evidence)].filter(Boolean);
      const seen = new Set();
      if (operation.metadata?.autonomousInstaller) {
        for (const evidence of proofs) {
          if (evidence.backup && !seen.has("backup")) { expanded.push({ operation, evidence }); seen.add("backup"); }
          for (const artifact of evidence.artifacts ?? []) {
            const key = `${artifact.kind}:${artifact.snapshot?.directory}`;
            if (!seen.has(key)) { expanded.push({ operation, evidence, artifact }); seen.add(key); }
          }
        }
        if (!proofs.length) {
          unverified++;
          const directory = operation.metadata.autonomousBackup?.directory;
          if (installerStorageDisposed(operation) && path.isAbsolute(directory ?? "")
            && path.basename(directory) === "backup" && !inside(this.runtimeRoot, directory)) {
            const migration = { id: `${operation.operationId}:installer:provenance`, operation, cache: path.dirname(directory) };
            if (!this.#bad.has(installerStorageDigest(operation))) migrations.push(migration);
          }
        }
      } else expanded.push({ operation });
    }
    for (const { operation, evidence, artifact } of expanded) {
      let entry;
      try { entry = this.#original(operation, evidence, artifact); }
      catch { unverified++; continue; }
      const child = this.store.latestStorageArtifactReadonly(this.id, entry.id);
      const exists = await lstat(entry.snapshot.directory, { bigint: true }).catch(error => { if (missing(error)) return null; throw error; });
      const retired = child?.metadata?.binding?.snapshotDigest === entry.snapshotDigest
        && (child.metadata?.updateBackupPrune?.complete === true
          || ["removed", "already-removed"].includes(child.metadata?.result?.status));
      if (retired && (!exists || entry.snapshot.keepRoot && (await Promise.all(entry.snapshot.files.map(file =>
        lstat(path.join(entry.snapshot.directory, file.path)).then(() => false, error => { if (missing(error)) return true; throw error; })))).every(Boolean))) continue;
      entry.missing = !exists;
      entry.workerRetired = entry.evidence ? await installerWorkerRetired(evidence) : true;
      entry.protected = (entry.evidence ? !installerStorageDisposed(operation) || !entry.workerRetired
        : operation.status !== "succeeded" || operation.outcome !== "succeeded")
        || !entry.artifact && evidence?.backupUnverified === true
        || !await installerCustodyCurrent(evidence, this.runtimeRoot, this.store)
        || retired || this.#bad.has(entry.snapshotDigest) || !exists || !exists.isDirectory() || exists.isSymbolicLink();
      if (retired || !exists || exists.isSymbolicLink() || !exists.isDirectory() || this.#bad.has(entry.snapshotDigest)) unverified++;
      if (!entry.artifact && evidence?.backupUnverified) unverified++;
      entries.push(entry);
    }
    const duplicate = new Set(entries.filter((entry, i) => entries.some((other, j) => j !== i
      && normalize(entry.snapshot.directory) === normalize(other.snapshot.directory))).map(e => e.id));
    for (const entry of entries) if (duplicate.has(entry.id)) { entry.protected = true; entry.duplicated = true; }
    const backups = entries.filter(entry => !entry.artifact);
    const protectedCount = backups.filter(entry => entry.protected).length;
    const eligible = backups.filter(entry => !entry.protected)
      .sort((a, b) => b.operation.createdAt.localeCompare(a.operation.createdAt) || b.id.localeCompare(a.id));
    const candidates = [...migrations, ...eligible.slice(Math.max(0, LIMIT - protectedCount)).reverse(), ...entries.filter(e => e.artifact && !e.protected)];
    this.#last = { limit: LIMIT, state: "observed", knownBackups: backups.length,
      protected: protectedCount, unverified, pendingExcess: Math.max(0, backups.length - LIMIT),
      pendingArtifacts: entries.filter(e => e.artifact).length,
      workerPending: entries.some(e => e.evidence && installerStorageDisposed(e.operation) && !e.workerRetired),
      limitMet: backups.length <= LIMIT && unverified === 0 };
    return { entries, candidates, migrations };
  }

  async list({ after, limit }) {
    const { candidates } = await this.#inventory();
    const items = candidates.map(entry => ({ id: entry.id,
      cursor: `${entry.operation.createdAt}:${entry.snapshot ? entry.id : `!installer-provenance:${entry.id}`}` })).sort((a, b) => a.cursor.localeCompare(b.cursor))
      .filter(entry => !after || entry.cursor > after).slice(0, limit);
    // Re-evaluate the global limit after each bounded page, not just once/cycle.
    return { items, done: items.length === 0, retry: this.#last.workerPending };
  }

  async #capture(entry) {
    const root = entry.snapshot.directory;
    const parents = await ancestors(root), files = [], directories = [];
    if (entry.snapshot.root && !same(parents[0], entry.snapshot.root)) throw Error("backup-root-changed");
    if (entry.evidence && !parents.some(parent => normalize(parent.file) === normalize(entry.evidence.cache.file)
      && same(parent, entry.evidence.cache))) throw Error("backup-cache-changed");
    async function walk(directory, relative) {
      const dir = await plainDirectory(directory); directories.push({ relative, ...dir });
      for (const name of (await readdir(directory)).sort()) {
        const file = path.join(directory, name), rel = path.join(relative, name);
        const info = await lstat(file, { bigint: true });
        if (info.isSymbolicLink()) throw new Error("backup-reparse-refused");
        if (info.isDirectory()) await walk(file, rel);
        else if (info.isFile() && info.nlink === 1n) files.push({ relative: rel, file,
          ...pin(info), size: String(info.size) });
        else throw new Error("backup-entry-unproven");
      }
    }
    if (entry.snapshot.partialTree) {
      if (!entry.snapshot.keepRoot || entry.artifact?.kind !== "download") throw Error("backup-partial-tree-unproven");
      for (const record of entry.snapshot.files) {
        const file = path.join(root, record.path), info = await lstat(file, { bigint: true });
        if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) throw Error("backup-entry-unproven");
        files.push({ relative: record.path, file, ...pin(info), size: String(info.size) });
      }
    } else await walk(root, "");
    const manifest = entry.snapshot.retentionFiles ?? entry.snapshot.files;
    const expected = new Map(manifest.map(file => [normalize(file.path), file]));
    if (files.length !== expected.size) throw new Error("backup-inventory-changed");
    const expectedDirs = new Set(entry.snapshot.keepRoot ? [] : ["", ...(entry.snapshot.directories ?? []).map(normalize)]);
    for (const record of manifest) {
      if (!entry.snapshot.keepRoot) for (let dir = path.dirname(record.path); dir !== "."; dir = path.dirname(dir)) expectedDirs.add(normalize(dir));
    }
    if (directories.length !== expectedDirs.size || directories.some(d => !expectedDirs.has(d.relative ? normalize(d.relative) : ""))) {
      throw new Error("backup-directory-inventory-changed");
    }
    for (const file of files) {
      const declared = expected.get(normalize(file.relative));
      const actual = await packageFile(file.file);
      if (!declared || actual.bytes !== declared.bytes || actual.sha256 !== declared.sha256) throw new Error("backup-content-changed");
    }
    await assertDirectories(parents);
    const entries = [...files, ...directories.sort((a, b) => b.relative.length - a.relative.length)
      .map(d => ({ ...d, directory: true, size: "0" }))];
    return { parents, entries };
  }

  async preview({ candidate }) {
    if (this.isStopping()) return { status: "retained", reason: "backup-owner-stopping" };
    const { candidates } = await this.#inventory(), entry = candidates.find(e => e.id === candidate.id);
    if (!entry) return { status: "retained", reason: "backup-protected-or-within-limit" };
    try {
      if (!entry.snapshot) {
        const evidence = await sealAutonomousInstallerStorage({ runtimeRoot: this.runtimeRoot, operation: entry.operation, cache: entry.cache, requireRetired: true });
        return { status: "eligible", binding: { sourceId: entry.operation.operationId, sourceSha256: installerStorageDigest(entry.operation),
          cache: evidence.cache, evidenceDigest: installerStorageDigest(evidence) } };
      }
      const proof = await this.#capture(entry);
      return { status: "eligible", binding: { sourceId: entry.sourceId, snapshotDigest: entry.snapshotDigest,
        root: proof.parents[0], proofDigest: digest(proof) } };
    } catch (error) {
      this.#bad.add(entry.snapshotDigest ?? installerStorageDigest(entry.operation)); await this.#inventory();
      this.#last.limitMet = false;
      this.#last.reason = /^backup-[a-z-]+$/u.test(error.message) ? error.message : "backup-proof-unavailable";
      return { status: "retained", reason: "backup-proof-unavailable" };
    }
  }

  #save(operationId, progress) {
    const child = this.store.getReadonly(operationId);
    const result = this.store.transition(operationId, { metadata: { updateBackupPrune: progress } }, { expectedRevision: child.revision });
    if (!result.applied) throw new Error("backup-retirement-cas");
  }

  async #effect({ candidate, binding, operationId }, reconcile) {
    const child = this.store.getReadonly(operationId);
    if (!child?.metadata?.admitted || child.metadata.owner !== this.id || child.metadata.candidate?.id !== candidate.id
      || digest(child.metadata.binding) !== digest(binding)) throw new Error("backup-retirement-original-required");
    if (binding.evidenceDigest) {
      const source = this.store.getReadonly(binding.sourceId);
      if (!installerStorageDisposed(source) || installerStorageDigest(source) !== binding.sourceSha256) throw Error("backup-source-changed");
      let saved = child.metadata.installerStorageEvidence;
      if (!saved) {
        const evidence = await sealAutonomousInstallerStorage({ runtimeRoot: this.runtimeRoot, operation: source, cache: binding.cache.file, requireRetired: true });
        if (installerStorageDigest(evidence) !== binding.evidenceDigest) throw Error("backup-preview-changed");
        saved = { sourceId: source.operationId, sourceSha256: binding.sourceSha256, evidence };
        const result = this.store.transition(operationId, { metadata: { installerStorageEvidence: saved } }, { expectedRevision: child.revision });
        if (!result.applied) throw Error("backup-retirement-cas");
      }
      if (installerStorageDigest(saved.evidence) !== binding.evidenceDigest) throw Error("backup-owner-proof-changed");
      return { status: "retained", reason: "installer-provenance-registered" };
    }
    let progress = child.metadata.updateBackupPrune;
    if (progress?.complete) {
      let receipt = progress.receipt;
      if (!receipt && progress.proof && digest(progress.proof) === binding.proofDigest
        && progress.next === progress.proof.entries.length && progress.intent === null) {
        // The prior owner wrote completion before its final reply. Preserve
        // that positive receipt on SAME child; never rediscover or delete again.
        receipt = { sourceId: binding.sourceId, proofDigest: binding.proofDigest, entries: progress.next,
          root: binding.root, logicalBytes: progress.proof.entries.reduce((n, e) => n + (e.directory ? 0 : Number(e.size)), 0) };
        progress.receipt = receipt; delete progress.proof; this.#save(operationId, progress);
      }
      if (receipt?.proofDigest !== binding.proofDigest || receipt.sourceId !== binding.sourceId
        || receipt.entries !== progress.next || progress.intent !== null) throw Error("backup-completion-receipt-changed");
      return { status: "already-removed", logicalBytes: 0 };
    }
    const live = await this.#inventory();
    const record = live.entries.find(e => e.id === candidate.id);
    const original = record;
    if (!original || original.snapshotDigest !== binding.snapshotDigest
      || (original.evidence ? !installerStorageDisposed(original.operation) || !await installerWorkerRetired(original.evidence)
        : original.operation.status !== "succeeded" || original.operation.outcome !== "succeeded"))
      return { status: "unknown", reason: "backup-source-changed" };
    const rootIntentAbsent = record?.missing && !record.duplicated && progress?.intent
      && progress.next === progress.proof.entries.length - 1
      && progress.proof.entries[progress.next].file === binding.root.file;
    if (!progress?.complete && (!record || (record.protected && !rootIntentAbsent)
      || (!progress?.next && !progress?.intent && !live.candidates.some(e => e.id === candidate.id)))) {
      return { status: "unknown", reason: "backup-retirement-no-longer-eligible" };
    }
    if (!progress) {
      // No owner proof means no per-entry effect could have been admitted.
      // Revalidate the original preview before creating that still-unused proof.
      const proof = await this.#capture(original);
      if (digest(proof) !== binding.proofDigest) return { status: "unknown", reason: "backup-preview-changed" };
      progress = { proof, next: 0, intent: null, complete: false, logicalBytes: 0 };
      this.#save(operationId, progress); // Owner proof stays on SAME canonical child, not its 64KiB scheduler binding.
    }
    const { entries, parents } = progress.proof;
    if (digest(progress.proof) !== binding.proofDigest) return { status: "unknown", reason: "backup-owner-proof-changed" };
    const checkParents = async target => {
      if (!await installerCustodyCurrent(original.evidence, this.runtimeRoot, this.store)) throw Error("backup-custody-current-changed");
      await assertDirectories(parents.filter(p => p.file !== target.file));
      for (const dir of entries.filter(e => e.directory && inside(e.file, target.file) && e.file !== target.file)) {
        if (!same(dir, await plainDirectory(dir.file))) throw new Error("backup-parent-changed");
      }
    };
    let used = 0, bytes = 0;
    if (progress.intent) {
      const target = entries[progress.next];
      await checkParents(target);
      const info = await lstat(target.file).catch(error => { if (missing(error)) return null; throw error; });
      if (info) return { status: "unknown", reason: "backup-delete-unconfirmed" };
      bytes += target.directory ? 0 : Number(target.size);
      progress.logicalBytes = (progress.logicalBytes ?? 0) + bytes;
      progress.next++; progress.intent = null; this.#save(operationId, progress);
    }
    while (progress.next < entries.length && used < this.maxEntries) {
      if (this.isStopping()) return { status: "partial", logicalBytes: bytes, reason: "backup-owner-stopping" };
      const target = entries[progress.next];
      await checkParents(target);
      const info = await lstat(target.file, { bigint: true });
      if (info.isSymbolicLink() || !same(target, pin(info)) || info.nlink !== 1n
        || target.directory !== undefined && !info.isDirectory() || !target.directory && (!info.isFile() || String(info.size) !== target.size)) {
        throw new Error("backup-entry-changed");
      }
      if (target.directory && (await readdir(target.file)).length) throw new Error("backup-directory-not-empty");
      progress.intent = { next: progress.next }; this.#save(operationId, progress);
      await this.beforeDelete?.(target);
      await checkParents(target);
      await this.deleteEntry(target.file, { ...pin(info), size: target.size, directory: Boolean(target.directory) });
      bytes += target.directory ? 0 : Number(target.size); used++;
      progress.logicalBytes = (progress.logicalBytes ?? 0) + (target.directory ? 0 : Number(target.size));
      progress.next++; progress.intent = null; this.#save(operationId, progress);
    }
    if (progress.next < entries.length) return { status: "partial", logicalBytes: bytes };
    progress.complete = true;
    progress.receipt = { sourceId: binding.sourceId, proofDigest: binding.proofDigest, entries: entries.length,
      logicalBytes: progress.logicalBytes ?? 0, root: binding.root };
    delete progress.proof; // Completed child keeps its bound receipt, not a second full file inventory.
    this.#save(operationId, progress);
    await this.#inventory();
    return { status: "removed", logicalBytes: bytes };
  }

  async #run(input, reconcile) {
    const started = performance.now();
    let result;
    try { result = await this.#effect(input, reconcile); return result; }
    catch {
      this.#last = { ...this.#last, state: "failed", reason: "backup-delete-unconfirmed", limitMet: false };
      result = { status: "unknown", reason: "backup-delete-unconfirmed" }; return result;
    } finally {
      this.#last.elapsedMs = performance.now() - started;
      try {
        const logged = this.trace?.recordBestEffort({ commandId: input.operationId, stage: "storage-update-artifact-prune", transport: "server-runtime",
          outcome: result?.status === "unknown" ? "unknown" : "succeeded", observedAtMs: Date.now(), monotonicDurationMs: this.#last.elapsedMs,
          metadata: { logicalBytes: Math.max(0, Number(result?.logicalBytes) || 0), partial: result?.status === "partial",
            reconciliation: reconcile, artifactClass: input.binding?.evidenceDigest ? 0 : input.candidate.id.includes(":installer:") ? 1 : 2 } });
        logged?.catch?.(() => {});
      } catch { /* Diagnostic only; never repeat/change the owning effect. */ }
    }
  }
  async prune(input) { return this.#run(input, false); }
  async reconcile(input) { return this.#run(input, true); }
}
