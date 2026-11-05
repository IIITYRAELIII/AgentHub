import { createHash } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { packageFile } from "../filesystem/runtime-package-target.mjs";
import { deleteVerifiedWindowsEntry } from "./windows-delete-verified-entry.mjs";

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
    deleteEntry = deleteVerifiedWindowsEntry, beforeDelete = null, maxEntries = 16 } = {}) {
    Object.assign(this, { runtimeRoot: path.resolve(runtimeRoot), store, isStopping, deleteEntry, beforeDelete, maxEntries });
  }

  status() { return structuredClone(this.#last); }

  #original(operation) {
    const snapshot = operation?.metadata?.packageBackup, envelope = operation?.metadata?.packageHandoff;
    const binding = envelope?.binding;
    if (operation?.invalid || operation?.kind !== "restart" || operation.streamId !== "agent-hub-runtime"
      || operation.threadId !== "agent-hub-runtime" || !binding || envelope.sha256 !== digest(binding)
      || binding.operationId !== operation.operationId || normalize(binding.runtimeRoot) !== normalize(this.#runtimePin.file)
      || !path.isAbsolute(binding.scratchRoot ?? "") || inside(this.#runtimePin.file, binding.scratchRoot)
      || !snapshot || !path.isAbsolute(snapshot.directory ?? "")
      || normalize(snapshot.directory) !== normalize(path.join(binding.scratchRoot, "backup"))
      || !Array.isArray(snapshot.files) || !snapshot.files.length
      || Object.values(binding.target ?? {}).some(value => value?.file && inside(snapshot.directory, value.file))) {
      throw new Error("backup-original-unproven");
    }
    const names = new Set();
    for (const file of snapshot.retentionFiles ?? snapshot.files) {
      if (!safeRelative(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0
        || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? "") || names.has(normalize(file.path))) {
        throw new Error("backup-manifest-unproven");
      }
      names.add(normalize(file.path));
    }
    if (snapshot.files.some(file => !(snapshot.retentionFiles ?? snapshot.files).some(saved =>
      saved.path === file.path && saved.bytes === file.bytes && saved.sha256 === file.sha256))) {
      throw new Error("backup-payload-manifest-changed");
    }
    return { id: operation.operationId, operation, snapshot,
      snapshotDigest: digest({ operationId: operation.operationId, bindingSha256: envelope.sha256, snapshot }) };
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
    const entries = []; let unverified = 0;
    for (const operation of rows) {
      let entry;
      try { entry = this.#original(operation); }
      catch { unverified++; continue; }
      const child = this.store.latestStorageArtifactReadonly(this.id, entry.id);
      const exists = await lstat(entry.snapshot.directory, { bigint: true }).catch(error => { if (missing(error)) return null; throw error; });
      const retired = child?.metadata?.binding?.snapshotDigest === entry.snapshotDigest
        && (child.metadata?.updateBackupPrune?.complete === true
          || ["removed", "already-removed"].includes(child.metadata?.result?.status));
      if (!exists && retired) continue;
      entry.missing = !exists;
      entry.protected = operation.status !== "succeeded" || operation.outcome !== "succeeded"
        || retired || this.#bad.has(entry.snapshotDigest) || !exists || !exists.isDirectory() || exists.isSymbolicLink();
      if (retired || !exists || exists.isSymbolicLink() || !exists.isDirectory() || this.#bad.has(entry.snapshotDigest)) unverified++;
      entries.push(entry);
    }
    const duplicate = new Set(entries.filter((entry, i) => entries.some((other, j) => j !== i
      && normalize(entry.snapshot.directory) === normalize(other.snapshot.directory))).map(e => e.id));
    for (const entry of entries) if (duplicate.has(entry.id)) { entry.protected = true; entry.duplicated = true; }
    const protectedCount = entries.filter(entry => entry.protected).length;
    const eligible = entries.filter(entry => !entry.protected)
      .sort((a, b) => b.operation.createdAt.localeCompare(a.operation.createdAt) || b.id.localeCompare(a.id));
    const candidates = eligible.slice(Math.max(0, LIMIT - protectedCount)).reverse();
    this.#last = { limit: LIMIT, state: "observed", knownBackups: entries.length,
      protected: protectedCount, unverified, pendingExcess: Math.max(0, entries.length - LIMIT),
      limitMet: entries.length <= LIMIT && unverified === 0 };
    return { entries, candidates };
  }

  async list({ after, limit }) {
    const { candidates } = await this.#inventory();
    const items = candidates.map(entry => ({ id: entry.id,
      cursor: `${entry.operation.createdAt}:${entry.id}` })).sort((a, b) => a.cursor.localeCompare(b.cursor))
      .filter(entry => !after || entry.cursor > after).slice(0, limit);
    // Re-evaluate the global limit after each bounded page, not just once/cycle.
    return { items, done: items.length === 0 };
  }

  async #capture(entry) {
    const root = entry.snapshot.directory;
    const parents = await ancestors(root), files = [], directories = [];
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
    await walk(root, "");
    const manifest = entry.snapshot.retentionFiles ?? entry.snapshot.files;
    const expected = new Map(manifest.map(file => [normalize(file.path), file]));
    if (files.length !== expected.size) throw new Error("backup-inventory-changed");
    const expectedDirs = new Set([""]);
    for (const record of manifest) {
      for (let dir = path.dirname(record.path); dir !== "."; dir = path.dirname(dir)) expectedDirs.add(normalize(dir));
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
      const proof = await this.#capture(entry);
      return { status: "eligible", binding: { sourceId: entry.id, snapshotDigest: entry.snapshotDigest,
        root: proof.parents[0], proofDigest: digest(proof) } };
    } catch (error) {
      this.#bad.add(entry.snapshotDigest); await this.#inventory();
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
    const original = this.#original(this.store.getReadonly(binding.sourceId));
    if (original.snapshotDigest !== binding.snapshotDigest || original.operation.status !== "succeeded"
      || original.operation.outcome !== "succeeded") return { status: "unknown", reason: "backup-source-changed" };
    let progress = child.metadata.updateBackupPrune;
    const live = await this.#inventory();
    const record = live.entries.find(e => e.id === candidate.id);
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
      progress = { proof, next: 0, intent: null, complete: false };
      this.#save(operationId, progress); // Owner proof stays on SAME canonical child, not its 64KiB scheduler binding.
    }
    const { entries, parents } = progress.proof;
    if (digest(progress.proof) !== binding.proofDigest) return { status: "unknown", reason: "backup-owner-proof-changed" };
    const checkParents = async target => {
      await assertDirectories(parents.filter(p => p.file !== target.file));
      for (const dir of entries.filter(e => e.directory && inside(e.file, target.file) && e.file !== target.file)) {
        if (!same(dir, await plainDirectory(dir.file))) throw new Error("backup-parent-changed");
      }
    };
    if (progress.intent) {
      const target = entries[progress.next];
      await checkParents(target);
      const info = await lstat(target.file).catch(error => { if (missing(error)) return null; throw error; });
      if (info) return { status: "unknown", reason: "backup-delete-unconfirmed" };
      progress.next++; progress.intent = null; this.#save(operationId, progress);
    }
    let used = 0, bytes = 0;
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
      progress.next++; progress.intent = null; this.#save(operationId, progress);
    }
    if (progress.next < entries.length) return { status: "partial", logicalBytes: bytes };
    progress.complete = true; this.#save(operationId, progress);
    await this.#inventory();
    return { status: "removed", logicalBytes: bytes };
  }

  async #run(input, reconcile) {
    const started = performance.now();
    try { return await this.#effect(input, reconcile); }
    catch {
      this.#last = { ...this.#last, state: "failed", reason: "backup-delete-unconfirmed", limitMet: false };
      return { status: "unknown", reason: "backup-delete-unconfirmed" };
    } finally { this.#last.elapsedMs = performance.now() - started; }
  }
  async prune(input) { return this.#run(input, false); }
  async reconcile(input) { return this.#run(input, true); }
}
