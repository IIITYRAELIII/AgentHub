import path from "node:path";
import { measureTaskOperation, measureTaskOperationAwait, recordTaskOperationTiming } from "../process/task-operation-timing.mjs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, link, unlink } from "node:fs/promises";
import { MaintenanceOperationStore } from "../persistence/maintenance-operation-store.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { unlinkOwnedNativeObjectAlias, retireSealedNativeCapture } from "./sealed-native-capture.mjs";
import { inventoryNativeCapture } from "./native-capture-inventory.mjs";
import { hasExactGitCommitObjects } from "./selected-git-bundle.mjs";

export const NATIVE_OBJECT_STORAGE = "owned-immutable-git-objects-v1";
const digest = value => createHash("sha256").update(value).digest("hex");
export const nativeObjectStorageDescriptor = () => ({ kind: NATIVE_OBJECT_STORAGE,
  storeId: digest(NATIVE_OBJECT_STORAGE + ":sha1") });
const oid = value => /^[a-f0-9]{40}$/u.test(value);
const fail = message => Object.assign(new Error(message), { code: "NATIVE_OBJECT_STORAGE_UNPROVEN" });
const absent = async file => lstat(file).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; });
const physical = s => ({ dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function ownedPackIndexContains(bytes, packChecksum, required) {
  // gitformat-pack: a v2 SHA-1 index puts its object names in one contiguous
  // table. Older formats continue through Git's own parser.
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0xff744f63 || bytes.readUInt32BE(4) !== 2) return null;
  const hashSize = 20;
  const objectNames = 8 + 256 * 4;
  const trailer = bytes.length - 2 * hashSize;
  const invalid = () => fail("Owned pack index inventory is malformed");
  if (trailer < objectNames) throw invalid();
  const count = bytes.readUInt32BE(objectNames - 4);
  const offsets = objectNames + (hashSize + 4) * count;
  const extendedOffsets = offsets + 4 * count;
  const extendedBytes = trailer - extendedOffsets;
  if (!count || extendedBytes < 0 || extendedBytes % 8 !== 0 || extendedBytes / 8 > count) throw invalid();
  if (bytes.toString("hex", trailer, trailer + hashSize) !== packChecksum
      || !createHash("sha1").update(bytes.subarray(0, bytes.length - hashSize)).digest().equals(bytes.subarray(-hashSize))) {
    throw invalid();
  }
  let index = 0;
  let previous = null;
  let found = false;
  for (let prefix = 0; prefix < 256; prefix++) {
    const end = bytes.readUInt32BE(8 + prefix * 4);
    if (end < index || end > count) throw invalid();
    for (; index < end; index++) {
      const start = objectNames + index * hashSize;
      const name = bytes.subarray(start, start + hashSize);
      if (name[0] !== prefix || (previous && Buffer.compare(previous, name) > 0)) throw invalid();
      previous = name;
      const offset = bytes.readUInt32BE(offsets + index * 4);
      if (offset >= 0x80000000 && offset - 0x80000000 >= extendedBytes / 8) throw invalid();
      if (!found) found = required.has(name.toString("hex"));
    }
  }
  return found;
}

async function plain(file, directory = false) {
  const s = await lstat(file, { bigint: true });
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw fail("Object storage path is not plain");
  return s;
}
async function hashFile(file, observe = null) {
  const h = await open(file, "r");
  try {
    const before = await h.stat({ bigint: true }), hash = createHash("sha256");
    if (!before.isFile()) throw fail("Object storage file changed type");
    for await (const b of h.createReadStream({ autoClose: false })) hash.update(b);
    const after = await plain(file);
    if (!equal(physical(before), physical(after)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw fail("Immutable object file changed during verification");
    }
    observe?.(after);
    return { ...physical(after), bytes: String(after.size), sha256: hash.digest("hex") };
  } finally { await h.close(); }
}
// Only reads may run concurrently. Join the complete group before reporting an
// error or entering another Git command or filesystem effect.
async function readGroup(items, read) {
  const settled = await Promise.allSettled(items.map(read));
  const failure = settled.find(result => result.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map(result => result.value);
}

const inventoryBatchSize = 16;
async function readInventory(items, read) {
  const output = [];
  for (let offset = 0; offset < items.length; offset += inventoryBatchSize) {
    output.push(...await readGroup(items.slice(offset, offset + inventoryBatchSize), read));
  }
  return output;
}

async function immutableLink(source, destination, assertCurrent = null) {
  const [parent, sourceParent, before] = await readGroup([
    () => plain(path.dirname(destination), true).then(physical),
    () => plain(path.dirname(source), true).then(physical),
    () => hashFile(source),
  ], read => read());
  if (assertCurrent) await assertCurrent();
  try { await link(source, destination); }
  catch (e) { if (e.code !== "EEXIST") throw e; }

  // The post-link hash belongs to the shared inode. Both names must freshly
  // resolve to that exact inode, length and timestamps after the hash.
  let hashed;
  const after = await hashFile(destination, value => { hashed = value; });
  const [liveDestination, liveSource, destinationDirectory, sourceDirectory] = await readGroup([
    () => plain(destination), () => plain(source),
    () => plain(path.dirname(destination), true), () => plain(path.dirname(source), true),
  ], read => read());
  const matchesHash = file => equal(physical(file), physical(hashed))
    && file.size === hashed.size && file.mtimeNs === hashed.mtimeNs && file.ctimeNs === hashed.ctimeNs;
  if (!equal(before, after) || !matchesHash(liveDestination) || !matchesHash(liveSource)
      || !equal(parent, physical(destinationDirectory)) || !equal(sourceParent, physical(sourceDirectory))) {
    throw fail("Immutable object hardlink identity changed");
  }
  return after;
}

// Same maintenance-operation owner as retention. No alternate/object borrowing,
// capture registry or writable shared Git metadata. Only immutable object files
// are linked; HEAD/index/config/refs/worktree always belong to each capture.
export class OwnedNativeObjectStore {
  constructor({ dataDir, gitAt, store = new MaintenanceOperationStore({ dataDir }),
    withLease = fn => withInterprocessLocks([path.join(dataDir, "native-git-objects")], fn),
    assertCurrent = async () => {}, afterCheckpoint = async () => {} }) {
    this.dataDir = path.resolve(dataDir); this.gitAt = gitAt; this.store = store;
    this.withLease = withLease; this.assertCurrent = assertCurrent; this.afterCheckpoint = afterCheckpoint;
    this.root = path.join(this.dataDir, "native-git-objects", "sha1");
    this.repository = path.join(this.root, "objects.git");
    this.id = digest(NATIVE_OBJECT_STORAGE + ":sha1");
  }

  descriptor() { return { kind: NATIVE_OBJECT_STORAGE, storeId: this.id }; }
  async assertConsumer({ repository, identityHash, storage, inputs }) {
    if (storage?.kind !== NATIVE_OBJECT_STORAGE || storage.storeId !== this.id
        || storage.operationId !== "native-object-consumer:" + identityHash) throw fail("Native object consumer custody malformed");
    const row = this.store.getReadonly(storage.operationId);
    if (row?.status !== "succeeded" || row.metadata.objectStorage.repository !== path.resolve(repository)
        || row.metadata.objectStorage.identityHash !== identityHash || !equal(row.metadata.objectStorage.inputs, inputs)
        || row.metadata.objectStorage.importOperationId !== storage.importOperationId) throw fail("Native object consumer custody changed");
    const repositoryIdentity = physical(await plain(repository, true));
    const gitIdentity = physical(await plain(path.join(repository, ".git"), true));
    if (equal(row.metadata.physicalRepository, repositoryIdentity) && equal(row.metadata.physicalGit, gitIdentity)) return;
    const restored = this.store.getReadonly(this.#restoreId(repository, storage.operationId));
    const archived = restored && this.store.getReadonly(restored.metadata.objectStorage.archive.operationId);
    if (restored?.status !== "succeeded" || restored.metadata.objectStorage.consumerOperationId !== storage.operationId
        || !equal(restored.metadata.physicalRepository, repositoryIdentity)
        || !equal(restored.metadata.physicalGit, gitIdentity)
        || archived?.status !== "succeeded" || !equal(archived.metadata.archive, restored.metadata.objectStorage.archive)) throw fail("Native object consumer custody changed");
  }
  archiveIntent({ binding, inventory }) {
    const objectStorage = { ...this.descriptor(), binding, inventorySha256: digest(JSON.stringify(inventory)) };
    return { operationId: "native-object-archive:" + digest(JSON.stringify(objectStorage)), objectStorage };
  }
  async readArchiveIntent(intent) {
    const row = this.store.getReadonly(intent.operationId);
    if (!row) return null;
    if (!equal(row.metadata.objectStorage, intent.objectStorage)) throw fail("Original archive intent changed");
    return row.status === "succeeded" ? this.readArchive(row.metadata.archive) : null;
  }

  async #mutation(fn) { return this.store.runRestartMutation(fn); }
  async #create(id, binding) {
    return this.#mutation(() => {
      const row = this.store.create({ operationId: id, kind: "storage-retention", streamId: "agent-hub-runtime",
        threadId: id, metadata: { objectStorage: binding } });
      if (!equal(row.metadata.objectStorage, binding)) throw fail("Original object-storage intent changed");
      return row;
    });
  }
  async #patch(row, phase, metadata, succeeded = false) {
    const result = await this.#mutation(() => this.store.transition(row.operationId,
      { status: succeeded ? "succeeded" : row.status === "reconciling" ? "reconciling" : "running", phase, metadata }, { expectedRevision: row.revision }));
    if (!result.applied) throw fail("Original object-storage revision changed");
    await this.afterCheckpoint(phase, result.operation);
    return result.operation;
  }
  async #guard() {
    const directories = [];
    let cursor = this.dataDir;
    while (true) {
      directories.push(cursor);
      const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
    }
    await readGroup(directories, directory => plain(directory, true));
    if (!await absent(path.dirname(this.root))) await plain(path.dirname(this.root), true);
    const hooks = path.join(this.root, "empty-hooks");
    if (!await absent(hooks)) {
      await plain(hooks, true);
      if ((await readdir(hooks)).length) throw fail("Object storage empty-hooks custody changed");
    }
    for (const key of Object.keys(process.env)) {
      if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|GRAFT_FILE|REPLACE_REF_BASE|NAMESPACE|CONFIG|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_SYSTEM|CONFIG_GLOBAL|INDEX_FILE|SHALLOW_FILE)$/iu.test(key)) {
        throw fail("Ambient Git storage or history input is not allowed");
      }
    }
    await this.assertCurrent();
  }
  async #git(root, args, options) {
    await this.#guard();
    return this.gitAt(root, ["--no-lazy-fetch", "--no-replace-objects", "-c", "core.hooksPath=" + path.join(this.root, "empty-hooks"),
      "-c", "core.fsmonitor=false", ...args], options);
  }
  async #pool(readOnly = false) {
    await this.#guard();
    const binding = { ...this.descriptor(), root: this.root, repository: this.repository, format: "sha1" };
    let row = readOnly ? this.store.getReadonly("native-object-store:" + this.id) : await this.#create("native-object-store:" + this.id, binding);
    if (!row || !equal(row.metadata.objectStorage, binding)) throw fail("Original object-store custody missing");
    if (row.status !== "succeeded") {
      if (readOnly) throw fail("Original object-store creation is not terminal");
      if (!await absent(this.root)) throw fail("Unfinished object-store creation requires its original recovery");
      await mkdir(path.dirname(this.root), { recursive: true });
      await plain(path.dirname(this.root), true);
      await mkdir(this.root); await mkdir(path.join(this.root, "empty-hooks"));
      await this.#git(this.root, ["init", "--bare", "--object-format=sha1", "--template=" + path.join(this.root, "empty-hooks"), this.repository]);
      await this.#git(this.repository, ["config", "gc.auto", "0"]);
      row = await this.#patch(row, "ready", { physicalRoot: physical(await plain(this.root, true)),
        physicalRepository: physical(await plain(this.repository, true)) }, true);
    }
    if (!equal(row.metadata.physicalRoot, physical(await plain(this.root, true)))
        || !equal(row.metadata.physicalRepository, physical(await plain(this.repository, true)))) throw fail("Owned object store replaced");
    for (const file of ["shallow", "objects/info/alternates", "info/grafts"]) {
      if (!await absent(path.join(this.repository, file))) throw fail("Object store contains borrowed or rewritten history");
    }
    if (String(await this.#git(this.repository, ["rev-parse", "--is-bare-repository"])) !== "true"
        || String(await this.#git(this.repository, ["rev-parse", "--show-object-format"])) !== "sha1"
        || String(await this.#git(this.repository, ["for-each-ref", "--format=%(refname)", "refs/replace"])) !== "") {
      throw fail("Owned object-store configuration changed");
    }
    return row;
  }

  async #transfer(sourceRoot, objects, id, row) {
    const available = new Set(String(await this.#git(this.repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).split(/\r?\n/u).filter(Boolean));
    const missing = objects.filter(x => !available.has(x));
    if (row.status === "succeeded" && missing.length) throw fail("Completed object import lost owned objects");
    if (row.status !== "succeeded") {
      const pack = path.join(this.root, "import-" + digest(id) + ".pack"), idx = pack.slice(0, -5) + ".idx";
      if (missing.length && await absent(pack)) {
        row = await this.#patch(row, "import-intent", { missingSha256: digest(missing.join("\n") + "\n"), missingCount: missing.length });
        const handle = await open(pack, "wx+");
        try {
          row = await this.#patch(row, "pack-created", { packIdentity: physical(await handle.stat({ bigint: true })) });
          // Preserve native Git reuse/deltas for the exact missing set. Bound
          // only optional delta-search memory/parallelism, never object content.
          await this.#git(sourceRoot, ["pack-objects", "--stdout", "--window=10", "--window-memory=8m", "--threads=1"],
            { input: missing.join("\n") + "\n", stdoutFd: handle.fd });
          await handle.sync();
        } finally { await handle.close(); }
      }
      if (!await absent(pack)) {
        if (!equal(row.metadata.packIdentity, physical(await plain(pack)))) throw fail("Original pack output custody changed");
        // A partial or foreign retained output is never overwritten/replayed.
        if (await absent(idx)) await this.#git(this.repository, ["index-pack", "--strict", pack]);
        await this.#git(this.root, ["verify-pack", "-v", idx]);
        const h = await open(pack, "r"); let trailer;
        try { const s = await h.stat(); trailer = Buffer.alloc(20); await h.read(trailer, 0, 20, s.size - 20); }
        finally { await h.close(); }
        const stem = "pack-" + trailer.toString("hex");
        const packDir = path.join(this.repository, "objects", "pack");
        await immutableLink(pack, path.join(packDir, stem + ".pack"));
        await immutableLink(idx, path.join(packDir, stem + ".idx"));
      }
      const now = new Set(String(await this.#git(this.repository, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])).split(/\r?\n/u).filter(Boolean));
      if (objects.some(x => !now.has(x))) throw fail("Transferred object set is incomplete");
    }
    return row;
  }

  async #import(sourceRoot, inputs) {
    if (!inputs.length || inputs.length > 1024 || inputs.some(x => !oid(x)) || new Set(inputs).size !== inputs.length) {
      throw fail("Object-store inputs must be distinct exact commits");
    }
    const grafts = String(await this.#git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]));
    if (!await absent(path.resolve(sourceRoot, grafts))) throw fail("Source contains rewritten graft history");
    if (!await hasExactGitCommitObjects((args, options) => this.#git(sourceRoot, args, options), inputs)) {
      throw fail("Source is missing an exact object-store input commit");
    }
    const objects = String(await this.#git(sourceRoot, ["rev-list", "--objects", "--no-object-names", ...inputs])).split(/\r?\n/u).filter(Boolean).sort();
    if (!objects.length || objects.some(x => !oid(x)) || new Set(objects).size !== objects.length) throw fail("Source object closure is malformed");
    const closureSha256 = digest(objects.join("\n") + "\n");
    const binding = { ...this.descriptor(), inputs, closureSha256, objectCount: objects.length };
    const id = "native-object-import:" + digest(JSON.stringify(binding));
    let row = await this.#create(id, binding);
    row = await this.#transfer(sourceRoot, objects, id, row);
    if (row.status !== "succeeded") {
      if (!await hasExactGitCommitObjects((args, options) => this.#git(this.repository, args, options), inputs)) {
        throw fail("Object store is missing an exact input commit");
      }
      await this.#git(this.repository, ["fsck", "--connectivity-only", "--no-dangling", ...inputs]);
      const refRoot = "refs/agent-hub/objects/" + digest(id);
      for (const [i, c] of inputs.entries()) {
        const ref = refRoot + "/" + i;
        let before;
        try { before = String(await this.#git(this.repository, ["rev-parse", "--verify", ref])); }
        catch { before = "0".repeat(40); }
        if (before !== c && before !== "0".repeat(40)) throw fail("Original import ref contains foreign data");
        if (before !== c) await this.#git(this.repository, ["update-ref", ref, c, before]);
      }
      row = await this.#patch(row, "imported", { refRoot }, true);
    }
    await this.#retireTransferAliases(row);
    return row;
  }

  // Deterministic intake aliases are owned by this SAME durable operation.
  // Preflight the complete pair before unlinking either name. The live pool
  // must still hold the exact immutable files, never just equivalent bytes.
  async #retireTransferAliases(row) {
    if (row.status !== "succeeded") throw fail("Intake alias retirement requires durable success");
    const pack = path.join(this.root, "import-" + digest(row.operationId) + ".pack"), idx = pack.slice(0, -5) + ".idx";
    const presentPack = !await absent(pack), presentIndex = !await absent(idx);
    if (!presentPack && !presentIndex) return;
    await this.#guard();
    if (presentPack) await plain(pack);
    if (presentIndex) await plain(idx);
    const trailerFile = presentPack ? pack : idx, h = await open(trailerFile, "r");
    let trailer;
    try {
      const info = await h.stat({ bigint: true }), offset = presentPack ? 20 : 40;
      if (!info.isFile() || info.size < BigInt(offset)) throw fail("Intake alias custody malformed");
      trailer = Buffer.alloc(20);
      const read = await h.read(trailer, 0, 20, Number(info.size) - offset);
      if (read.bytesRead !== 20) throw fail("Intake alias checksum incomplete");
    } finally { await h.close(); }
    const stem = "pack-" + trailer.toString("hex"), poolPack = path.join(this.repository, "objects", "pack", stem + ".pack");
    const donorPack = await hashFile(poolPack);
    if (!equal(row.metadata.packIdentity, physical(await plain(poolPack)))) throw fail("Intake alias original pack custody changed");
    await this.#git(this.repository, ["verify-pack", poolPack.slice(0, -5) + ".idx"]);
    const aliases = [];
    for (const [file, donor] of [[pack, poolPack], [idx, poolPack.slice(0, -5) + ".idx"]]) {
      if (await absent(file)) continue;
      const identity = await hashFile(file), retained = file === pack ? donorPack : await hashFile(donor);
      if (!equal(identity, retained) || (await plain(file)).nlink < 2n) throw fail("Intake alias custody changed");
      aliases.push({ file, donor, identity });
    }
    for (const { file, donor, identity } of aliases) {
      await this.#guard();
      if (!equal(identity, await hashFile(file)) || !equal(identity, await hashFile(donor))) throw fail("Intake alias custody changed before unlink");
      if (process.platform === "win32") await unlinkOwnedNativeObjectAlias(file, identity);
      else await unlink(file);
    }
  }

  async #linkObjects(repository, required) {
    const sourceObjects = path.join(this.repository, "objects");
    const destObjects = path.join(repository, ".git", "objects");
    const inventory = await measureTaskOperation("native:object-inventory", async () => {
      const entries = (await readdir(sourceObjects, { withFileTypes: true }))
        .filter(entry => /^(?:[a-f0-9]{2}|pack)$/u.test(entry.name));
      const directories = await readInventory(entries, async ({ name }) => {
        const from = path.join(sourceObjects, name);
        await plain(from, true);
        return { name, from, files: new Set(await readdir(from)) };
      });
      const files = directories.flatMap(directory => [...directory.files].flatMap(file => {
        const pack = directory.name === "pack";
        if (pack && (file === "multi-pack-index" || /^pack-[a-f0-9]{40}\.keep$/u.test(file))) return [];
        if (!(pack ? /^pack-[a-f0-9]{40}\.(?:pack|idx|rev|bitmap)$/u : /^[a-f0-9]{38}$/u).test(file)) {
          throw fail("Foreign object-store entry");
        }
        const stem = pack ? file.slice(0, file.lastIndexOf(".")) : null;
        if (pack && (!directory.files.has(stem + ".idx") || !directory.files.has(stem + ".pack"))) {
          throw fail("Owned pack pair is incomplete");
        }
        return [{ directory, file, stem, source: path.join(directory.from, file) }];
      }));
      await readInventory(files, async ({ source }) => { await plain(source); });
      return files;
    });
    const selectedPacks = await measureTaskOperation("native:object-pack-indexes", async () => {
      const selected = new Set();
      const indexes = inventory.filter(({ stem, file }) => stem && file.endsWith(".idx"));
      for (let offset = 0; offset < indexes.length; offset += inventoryBatchSize) {
        const proof = await readGroup(indexes.slice(offset, offset + inventoryBatchSize), async ({ source, stem }) => {
          const identity = await hashFile(source);
          const bytes = await readFile(source);
          if (digest(bytes) !== identity.sha256) throw fail("Owned pack index changed");
          const contains = ownedPackIndexContains(bytes, stem.slice(5), required);
          if (contains !== null && !equal(identity, await hashFile(source))) throw fail("Owned pack index changed");
          return { source, stem, identity, bytes, contains };
        });
        for (const { source, stem, identity, bytes, contains } of proof) {
          if (contains === true) selected.add(stem);
          if (contains !== null) continue;

          // Older formats still use the existing guarded, serial Git owner.
          const rows = String(await this.#git(this.repository, ["show-index"], { input: bytes }));
          const packed = rows.split(/\r?\n/u).filter(Boolean).map(line => {
            const match = /^\d+ ([a-f0-9]{40})(?: \([a-f0-9]{8}\))?$/u.exec(line);
            if (!match) throw fail("Owned pack index inventory is malformed");
            return match[1];
          });
          if (!packed.length) throw fail("Owned pack inventory is empty");
          if (!equal(identity, await hashFile(source))) throw fail("Owned pack index changed");
          if (packed.some(id => required.has(id))) selected.add(stem);
        }
      }
      return selected;
    });
    const selected = inventory.filter(({ stem, directory, file }) => stem
      ? selectedPacks.has(stem) : required.has(directory.name + file));
    recordTaskOperationTiming("native:object-inventory-size",
      { files: inventory.length, packs: selectedPacks.size, aliases: selected.length, objects: required.size });
    return measureTaskOperation("native:object-aliases", async () => {
      const linked = new Set();
      let currentDirectory = null;
      for (const { directory, source, file } of selected) {
        const to = path.join(destObjects, directory.name);
        if (currentDirectory !== to) {
          await plain(directory.from, true);
          await mkdir(to, { recursive: true }); await plain(to, true);
          currentDirectory = to;
        }
        const destination = path.join(to, file);
        await immutableLink(source, destination, () => measureTaskOperationAwait(
          "native:object-alias-owner", () => this.#guard(), { reportAtMs: Infinity }));
        linked.add(path.relative(repository, destination).split(path.sep).join("/"));
      }
      return linked;
    });
  }

  async provision({ sourceRoot, repository, inputs, identityHash }) {
    if (!/^[a-f0-9]{64}$/u.test(identityHash)) throw fail("Exact native consumer identity required");
    return this.withLease(async () => {
      await measureTaskOperation("native:object-pool", () => this.#pool());
      const imported = await measureTaskOperation("native:object-import", () => this.#import(sourceRoot, inputs));
      const binding = { ...this.descriptor(), repository: path.resolve(repository), inputs, identityHash,
        importOperationId: imported.operationId };
      let row = await this.#create("native-object-consumer:" + identityHash, binding);
      if (row.status !== "succeeded") {
        if (!await absent(repository)) throw fail("Unfinished native consumer requires its original recovery");
        const closure = await measureTaskOperation("native:object-closure", () => this.#git(this.repository,
          ["rev-list", "--objects", "--no-object-names", ...inputs]));
        const objects = String(closure).split(/\r?\n/u).filter(Boolean).sort();
        if (objects.some(x => !oid(x)) || new Set(objects).size !== objects.length
            || objects.length !== imported.metadata.objectStorage.objectCount
            || digest(objects.join("\n") + "\n") !== imported.metadata.objectStorage.closureSha256) {
          throw fail("Consumer input closure differs from its owned import");
        }
        const required = new Set(objects);
        await this.#git(path.dirname(repository), ["init", "--object-format=sha1", "--template=" + path.join(this.root, "empty-hooks"), repository]);
        // upload-pack drops the client's -c settings: persist the same Windows
        // path policy before this independent consumer can serve its objects.
        if (process.platform === "win32") await this.#git(repository, ["config", "core.longpaths", "true"]);
        await this.#git(repository, ["config", "gc.auto", "0"]);
        await this.#linkObjects(repository, required);
        await measureTaskOperation("native:object-connectivity", async () => {
          if (!await hasExactGitCommitObjects((args, options) => this.#git(repository, args, options), inputs)) {
            throw fail("Object consumer is missing an exact input commit");
          }
          await this.#git(repository, ["fsck", "--connectivity-only", "--no-dangling", ...inputs]);
        });
        row = await this.#patch(row, "linked", { physicalRepository: physical(await plain(repository, true)),
          physicalGit: physical(await plain(path.join(repository, ".git"), true)) }, true);
      }
      if (!equal(row.metadata.physicalRepository, physical(await plain(repository, true)))
          || !equal(row.metadata.physicalGit, physical(await plain(path.join(repository, ".git"), true)))) throw fail("Native object consumer replaced");
      if (!await absent(path.join(repository, ".git", "objects", "info", "alternates"))) throw fail("Native consumer cannot borrow objects");
      await this.#guard();
      return { ...this.descriptor(), operationId: row.operationId, importOperationId: imported.operationId };
    });
  }

  async archive({ sourceRoot, binding, inventory, assertCurrent }) {
    return this.withLease(async () => {
      await this.#pool(); await assertCurrent();
      const { operationId: id, objectStorage: archiveBinding } = this.archiveIntent({ binding, inventory });
      let row = await this.#create(id, archiveBinding);
      if (row.status === "succeeded") {
        const stored = await this.readArchive(row.metadata.archive);
        await this.#retireTransferAliases(row);
        return stored;
      }
      if (!row.metadata.gitIdentity) {
        // Bind new synthetic anchor authorship once to this original archive.
        // Captured original commit objects are imported byte-for-byte below.
        const identity = String(await this.#git(this.repository, ["-c", "user.name=Agent Hub Storage",
          "-c", "user.email=storage@invalid", "var", "GIT_AUTHOR_IDENT"]));
        const match = /^(.*) <([^<>\r\n]+)> \d+ [+-]\d{4}$/u.exec(identity);
        if (!match || /[\r\n<>]/u.test(match[1])) throw fail("Archive Git identity is invalid");
        row = await this.#patch(row, "git-identity-bound", { gitIdentity: { name: match[1], email: match[2] } });
      }
      const grafts = String(await this.#git(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]));
      if (!await absent(path.resolve(sourceRoot, grafts))) throw fail("Archive source has rewritten history");
      await this.#git(sourceRoot, ["fsck", "--full", "--no-reflogs", "--no-dangling"]);
      const listed = String(await this.#git(sourceRoot, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]));
      const objects = listed.split(/\r?\n/u).filter(Boolean).map(line => {
        const match = /^([a-f0-9]{40}) (commit|tag|tree|blob)$/u.exec(line);
        if (!match) throw fail("Archive original object list malformed");
        return { oid: match[1], type: match[2] };
      }).sort((a, b) => a.oid.localeCompare(b.oid));
      if (new Set(objects.map(o => o.oid)).size !== objects.length) throw fail("Duplicate original archive object");
      row = await this.#transfer(sourceRoot, objects.map(o => o.oid), id, row);
      const files = [], rawFiles = inventory.files.filter(f => !f.objectFile);
      for (const file of rawFiles) {
        const full = path.join(sourceRoot, ...file.path.split("/"));
        if (!equal(file.identity, await hashFile(full))) throw fail("Archive source file differs from admitted inventory");
      }
      const rawBlobs = rawFiles.length ? String(await this.#git(this.repository, ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        { input: rawFiles.map(f => JSON.stringify(path.join(sourceRoot, ...f.path.split("/")))).join("\n") + "\n" })).split(/\r?\n/u) : [];
      if (rawBlobs.length !== rawFiles.length) throw fail("Archive raw object intake incomplete");
      const blobs = new Map(rawFiles.map((f, i) => [f.path, rawBlobs[i]]));
      for (const [i, file] of inventory.files.entries()) {
        if (file.objectFile) continue; // Git raw object identity closure is preserved independently.
        const full = path.join(sourceRoot, ...file.path.split("/")), blob = blobs.get(file.path);
        if (!oid(blob) || blob !== file.rawBlobOid || !equal(file.identity, await hashFile(full))) throw fail("Archived raw file changed");
        files.push({ name: "file-" + i, blob, ...file });
      }
      await assertCurrent();
      const fileTree = String(await this.#git(this.repository, ["mktree"], { input: files.map(f => "100644 blob " + f.blob + "\t" + f.name + "\n").join("") }));
      const nonCommits = objects.filter(o => ["blob", "tree"].includes(o.type));
      const originalTree = String(await this.#git(this.repository, ["mktree"], { input: nonCommits.map(o =>
        (o.type === "tree" ? "040000 tree " : "100644 blob ") + o.oid + "\tobject-" + o.oid + "\n").join("") }));
      const manifest = { version: 1, binding, inventory, files, objects };
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      const manifestBlob = String(await this.#git(this.repository, ["hash-object", "-w", "--stdin"], { input: manifestBytes }));
      const tree = String(await this.#git(this.repository, ["mktree"], { input:
        "040000 tree " + fileTree + "\tfiles\n040000 tree " + originalTree + "\tobjects\n100644 blob " + manifestBlob + "\tmanifest.json\n" }));
      const commits = objects.filter(o => o.type === "commit").map(o => o.oid);
      const parents = new Set(String(await this.#git(this.repository, ["rev-list", "--parents", "--stdin"],
        { input: commits.join("\n") + "\n" })).split(/\r?\n/u).filter(Boolean).flatMap(line => line.split(" ").slice(1)));
      let roots = commits.filter(c => !parents.has(c));
      // Bounded argv, no limit/truncation of original heads. Synthetic storage
      // commits anchor the complete original DAG; they never become Task results.
      const timestamp = Math.floor(Date.parse(row.createdAt) / 1000);
      const commitTree = async (tree, ancestors, message) => String(await this.#git(this.repository,
        ["hash-object", "-t", "commit", "-w", "--stdin"], { input: "tree " + tree + "\n"
          + ancestors.map(c => "parent " + c + "\n").join("")
          + "author " + row.metadata.gitIdentity.name + " <" + row.metadata.gitIdentity.email + "> " + timestamp + " +0000\n"
          + "committer " + row.metadata.gitIdentity.name + " <" + row.metadata.gitIdentity.email + "> " + timestamp + " +0000\n\n" + message + "\n" }));
      while (roots.length > 32) {
        const next = [];
        for (let i = 0; i < roots.length; i += 32) next.push(await commitTree(originalTree, roots.slice(i, i + 32), "Preserved original Git DAG"));
        roots = next;
      }
      const commit = await commitTree(tree, roots, "Preserved native capture " + digest(JSON.stringify(binding)));
      const ref = "refs/agent-hub/archives/" + digest(id), commands = ["start"];
      const targets = [{ ref, oid: commit }, ...objects.filter(o => o.type === "tag").map(o => ({ ref: ref + "-tag/" + o.oid, oid: o.oid }))];
      for (const target of targets) {
        let before;
        try { before = String(await this.#git(this.repository, ["rev-parse", "--verify", target.ref])); }
        catch { before = "0".repeat(40); }
        if (before !== target.oid && before !== "0".repeat(40)) throw fail("Original archive ref contains foreign data");
        commands.push(before === target.oid ? "verify " + target.ref + " " + before
          : "create " + target.ref + " " + target.oid);
      }
      commands.push("prepare", "commit", "");
      await assertCurrent();
      await this.#git(this.repository, ["update-ref", "--stdin"], { input: commands.join("\n") });
      await this.#git(this.repository, ["fsck", "--full", "--no-dangling", commit]);
      await assertCurrent();
      const archive = { ...this.descriptor(), operationId: id, ref, commit, tree, manifestBlob,
        manifestSha256: digest(manifestBytes), inventorySha256: archiveBinding.inventorySha256 };
      row = await this.#patch(row, "archived", { archive }, true);
      const stored = await this.readArchive(archive);
      await this.#retireTransferAliases(row);
      return stored;
    });
  }

  readArchive(archive) {
    return measureTaskOperation("native-retire:archive-read", () => this.#readArchive(archive));
  }

  async #readArchive(archive) {
    await this.#pool(true);
    if (!archive || archive.storeId !== this.id || !oid(archive.commit) || !oid(archive.tree)
        || !oid(archive.manifestBlob) || !/^refs\/agent-hub\/archives\/[a-f0-9]{64}$/u.test(archive.ref)) throw fail("Archive binding malformed");
    const row = this.store.getReadonly(archive.operationId);
    if (row?.status !== "succeeded" || !equal(row.metadata.archive, archive)
        || String(await this.#git(this.repository, ["rev-parse", "--verify", archive.ref])) !== archive.commit
        || String(await this.#git(this.repository, ["rev-parse", archive.commit + "^{tree}"])) !== archive.tree
        || String(await this.#git(this.repository, ["rev-parse", archive.commit + ":manifest.json"])) !== archive.manifestBlob) {
      throw fail("Archive original or stored Git binding changed");
    }
    const bytes = String(await this.#git(this.repository, ["cat-file", "blob", archive.manifestBlob], { rawOutput: true }));
    if (digest(bytes) !== archive.manifestSha256) throw fail("Archive manifest bytes changed");
    const manifest = JSON.parse(bytes);
    if (digest(JSON.stringify(manifest.inventory)) !== archive.inventorySha256
        || !equal(row.metadata.objectStorage.binding, manifest.binding)) throw fail("Archive inventory or original binding changed");
    if (!Array.isArray(manifest.objects) || !manifest.objects.length || !Array.isArray(manifest.files)) throw fail("Archive original roots malformed");
    const required = new Map();
    for (const original of manifest.objects) {
      if (!oid(original.oid) || !["commit", "tag", "tree", "blob"].includes(original.type)
          || required.has(original.oid)) throw fail("Archive original roots malformed");
      required.set(original.oid, original.type);
    }
    for (const file of manifest.files) {
      if (!oid(file.blob) || required.has(file.blob) && required.get(file.blob) !== "blob") throw fail("Archive raw file root malformed");
      required.set(file.blob, "blob");
    }
    const tags = manifest.objects.filter(o => o.type === "tag");
    const expectedRefs = tags.map(o => archive.ref + "-tag/" + o.oid + " " + o.oid).sort();
    const actualRefs = String(await this.#git(this.repository, ["for-each-ref", "--format=%(refname) %(objectname)", archive.ref + "-tag/"]))
      .split(/\r?\n/u).filter(Boolean).sort();
    if (!equal(actualRefs, expectedRefs)) throw fail("Archive original tag roots changed");
    const entries = [...required], checked = String(await this.#git(this.repository,
      ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: entries.map(([id]) => id).join("\n") + "\n" })).split(/\r?\n/u);
    if (checked.length !== entries.length || checked.some((line, i) => line !== entries[i][0] + " " + entries[i][1])) throw fail("Archive original object unavailable");
    const reachable = new Set(String(await this.#git(this.repository,
      ["rev-list", "--objects", "--no-object-names", "--missing=error", "--stdin"],
      { input: [archive.commit, ...tags.map(o => o.oid)].join("\n") + "\n" })).split(/\r?\n/u).filter(Boolean));
    if (entries.some(([id]) => !reachable.has(id))) throw fail("Archive original roots no longer retain all objects");
    return { archive, manifest, repository: this.repository };
  }

  // Fresh complete preservation and the destructive consumer share the SAME
  // object-store lease, excluding owned GC/import/ref updates until it returns.
  async withArchiveLease(archive, consume) {
    const started = performance.now(); let acquired = false;
    try {
      return await this.withLease(async () => {
        acquired = true;
        recordTaskOperationTiming("native-retire:archive-lease-wait", { durationMs: Math.max(0, performance.now() - started), outcome: "ok" });
        const stored = await this.readArchive(archive);
        await this.#retireTransferAliases(this.store.getReadonly(archive.operationId));
        return consume(stored);
      });
    } finally {
      if (!acquired) recordTaskOperationTiming("native-retire:archive-lease-wait", { durationMs: Math.max(0, performance.now() - started), outcome: "error" });
    }
  }

  async withArchiveMath(archive, verify) {
    return this.withLease(async () => {
      const stored = await this.readArchive(archive);
      await this.#retireTransferAliases(this.store.getReadonly(archive.operationId));
      return this.#withMath(stored, verify);
    });
  }

  #restoreId(repository, consumerOperationId) {
    return "native-object-restore:" + digest(JSON.stringify({ repository: path.resolve(repository), consumerOperationId }));
  }

  async #restorationBinding(stored, repository) {
    const { archive } = stored;
    const { manifest } = stored;
    repository = path.resolve(repository);
    if (manifest.binding.kind !== "release-generation-repository-v1"
        || manifest.binding.repository !== repository || manifest.inventory.repository !== repository) {
      throw fail("Restoration requires the original release generation repository");
    }
    const marker = manifest.files.find(file => file.path === ".git/agent-hub-release-clone.json");
    if (!marker) throw fail("Archived release clone custody missing");
    const markerBytes = Buffer.from(await this.#git(this.repository, ["cat-file", "blob", marker.blob], { rawOutput: true }));
    if (digest(markerBytes) !== marker.identity.sha256) throw fail("Archived release clone marker changed");
    const consumer = JSON.parse(markerBytes).objectStorage;
    const consumerOperationId = consumer?.storage.operationId ?? archive.operationId;
    if (consumer) {
      const original = this.store.getReadonly(consumerOperationId);
      const gitDirectory = manifest.inventory.directories.find(item => item.path === ".git");
      if (original?.status !== "succeeded" || original.metadata.objectStorage.repository !== repository
          || original.metadata.objectStorage.identityHash !== consumer.identityHash
          || !equal(original.metadata.objectStorage.inputs, consumer.inputs)
          || original.metadata.objectStorage.importOperationId !== consumer.storage.importOperationId
          || !equal(original.metadata.physicalRepository, manifest.inventory.root)
          || !equal(original.metadata.physicalGit, gitDirectory?.identity)) throw fail("Archived original consumer changed");
    }
    return { ...this.descriptor(), archive, repository, consumerOperationId };
  }

  async hasPendingRestoration({ archive, repository }) {
    // Routing observation only. The actual continuation repeats this complete
    // archive/binding proof under its original archive lease before any writes.
    const stored = await this.readArchive(archive);
    const binding = await this.#restorationBinding(stored, repository);
    const row = this.store.getReadonly(this.#restoreId(binding.repository, binding.consumerOperationId));
    return Boolean(row && ["running", "reconciling"].includes(row.status)
      && equal(row.metadata.objectStorage, binding));
  }

  // Rebuild only the original generation repository from its positively sealed
  // archive. Raw Git metadata is private; immutable history uses the same pool
  // linker as provision. Original archive/consumer receipts remain unchanged.
  restoreArchive({ archive, repository, assertCurrent, prepare }) {
    return measureTaskOperation("native-archive:restore", () => this.withArchiveLease(archive, async stored => {
      const { manifest } = stored;
      const binding = await this.#restorationBinding(stored, repository);
      const { consumerOperationId } = binding;
      repository = binding.repository;
      const id = this.#restoreId(repository, consumerOperationId);
      let row = this.store.getReadonly(id);
      if (!row && !await absent(repository)) throw fail("Original restoration destination is occupied");
      row = await this.#create(id, binding);
      await assertCurrent();
      await prepare({ metadata: row.metadata, checkpoint: async metadata => {
        row = await this.#patch(row, "restore-metadata", metadata);
      } });
      if (!row.metadata.physicalRepository) {
        await mkdir(repository);
        row = await this.#patch(row, "restore-created", { physicalRepository: physical(await plain(repository, true)) });
      }
      if (!equal(row.metadata.physicalRepository, physical(await plain(repository, true)))) throw fail("Restoration destination replaced");
      const destination = relative => {
        if (!relative || relative.includes("\\") || relative.includes(":") || relative.split("/").some(part => !part || part === "." || part === "..")) {
          throw fail("Archive restoration path is not relative");
        }
        return path.join(repository, ...relative.split("/"));
      };
      for (const directory of manifest.inventory.directories) {
        if (!directory.path) continue;
        const target = destination(directory.path);
        await mkdir(target, { recursive: true });
        await plain(target, true);
      }
      const gitIdentity = physical(await plain(path.join(repository, ".git"), true));
      if (!row.metadata.physicalGit) row = await this.#patch(row, "restore-paths", { physicalGit: gitIdentity });
      if (!equal(row.metadata.physicalGit, gitIdentity)) throw fail("Restored Git custody changed");
      for (let offset = 0; offset < manifest.files.length; offset += 32) {
        await assertCurrent();
        const files = manifest.files.slice(offset, offset + 32);
        const bytes = Buffer.from(await this.#git(this.repository, ["cat-file", "--batch"],
          { input: files.map(file => file.blob).join("\n") + "\n", rawOutput: true }));
        let cursor = 0;
        for (const file of files) {
          const newline = bytes.indexOf(10, cursor);
          const [blob, type, length] = bytes.subarray(cursor, newline).toString().split(" ");
          const size = Number(length), body = bytes.subarray(newline + 1, newline + 1 + size);
          cursor = newline + 1 + size + 1;
          if (newline < 0 || blob !== file.blob || type !== "blob" || !Number.isSafeInteger(size)
              || String(size) !== file.identity.bytes || digest(body) !== file.identity.sha256) throw fail("Archived restoration bytes changed");
          const target = destination(file.path);
          if (await absent(target)) {
            const handle = await open(target, "wx");
            try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
          }
          const actual = await hashFile(target);
          if (actual.bytes !== file.identity.bytes || actual.sha256 !== file.identity.sha256) throw fail("Restoration file is occupied or changed");
        }
        if (cursor !== bytes.length) throw fail("Archived restoration batch has trailing data");
      }
      const linked = await this.#linkObjects(repository, new Set(manifest.objects.map(object => object.oid)));
      const rawPaths = new Set(manifest.files.map(file => file.path)), pending = [repository];
      while (pending.length) {
        const directory = pending.pop();
        await plain(directory, true);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name), relative = path.relative(repository, file).split(path.sep).join("/");
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(file);
          else if (!entry.isFile() || entry.isSymbolicLink() || !rawPaths.has(relative) && !linked.has(relative)) {
            throw fail("Restoration contains a foreign entry");
          }
        }
      }
      if (process.platform !== "win32") {
        const entries = String(await this.#git(repository, ["ls-files", "--stage", "-z"], { rawOutput: true })).split("\0").filter(Boolean);
        for (const entry of entries) {
          const [metadata, relative] = entry.split("\t");
          const mode = metadata.split(" ")[0];
          if (["100644", "100755"].includes(mode)) await chmod(destination(relative), mode === "100755" ? 0o755 : 0o644);
        }
      }
      await this.#git(repository, ["fsck", "--connectivity-only", "--no-reflogs", "--no-dangling"]);
      for (const file of manifest.files) {
        const target = destination(file.path), actual = await hashFile(target);
        if ((await plain(target)).nlink !== 1n || actual.bytes !== file.identity.bytes || actual.sha256 !== file.identity.sha256) {
          throw fail("Restored raw payload changed before completion");
        }
      }
      await assertCurrent();
      if (row.status !== "succeeded") row = await this.#patch(row, "restored", {
        physicalGit: physical(await plain(path.join(repository, ".git"), true)) }, true);
      if (!equal(row.metadata.physicalGit, physical(await plain(path.join(repository, ".git"), true)))) throw fail("Restored Git custody changed");
      return { operationId: id, archive };
    }));
  }

  async withInputMath({ sourceRoot, inputs, sources = [{ sourceRoot, inputs }] }, verify) {
    return this.withLease(async () => {
      await this.#pool();
      const allInputs = [];
      for (const source of sources) {
        const selected = [...new Set(source.inputs)];
        const imported = await this.#import(source.sourceRoot, selected);
        await this.#retireTransferAliases(imported);
        allInputs.push(...selected);
      }
      return this.#withMath({ inputs: inputs ?? [...new Set(allInputs)] }, verify);
    });
  }

  async #withMath(stored, verify) {
      const parent = path.join(this.dataDir, "native-git-objects", "math");
      await mkdir(parent, { recursive: true }); await plain(parent, true);
      const root = await mkdtemp(path.join(parent, "owned-"));
      const created = physical(await plain(root, true));
      let result, originalError;
      try {
        await this.#git(parent, ["init", "--bare", "--template=" + path.join(this.root, "empty-hooks"), root]);
        await this.#git(root, ["config", "gc.auto", "0"]);
        // This invocation-only object scratch borrows while the pool lease is
        // HELD. Native captures and frozen release holders never use alternates.
        const h = await open(path.join(root, "objects/info/alternates"), "wx");
        try { await h.writeFile(path.join(this.repository, "objects").replaceAll("\\", "/") + "\n"); await h.sync(); }
        finally { await h.close(); }
        result = await verify({ ...stored, repository: root });
      } catch (error) { originalError = error; }
      try {
        if (!equal(created, physical(await plain(root, true)))) throw fail("Invocation math root replaced; retained");
        const inventory = await inventoryNativeCapture(root), bytes = Buffer.from(JSON.stringify(inventory));
        const plan = root + ".proof.json", h = await open(plan, "wx");
        let proof;
        try { await h.writeFile(bytes); await h.sync(); proof = physical(await h.stat({ bigint: true })); }
        finally { await h.close(); }
        let retired;
        do {
          await this.#guard();
          retired = await retireSealedNativeCapture(root, plan, digest(bytes), { allowPartial: retired !== undefined });
          if (retired.status === "partial" && !retired.files) throw fail("Invocation math cleanup made no progress; retained");
        } while (retired.status === "partial");
        if (!equal(proof, physical(await plain(plan))) || digest(await readFile(plan)) !== digest(bytes)) throw fail("Invocation proof replaced; retained");
        await unlink(plan);
      } catch (error) {
        if (originalError) { originalError.cleanupError = error; throw originalError; }
        throw error;
      }
      if (originalError) throw originalError;
      return result;
  }
}
