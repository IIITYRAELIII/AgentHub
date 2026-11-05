import path from "node:path";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, link, unlink } from "node:fs/promises";
import { MaintenanceOperationStore } from "../persistence/maintenance-operation-store.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { unlinkOwnedNativeObjectAlias, retireSealedNativeCapture } from "./sealed-native-capture.mjs";
import { inventoryNativeCapture } from "./native-capture-inventory.mjs";

export const NATIVE_OBJECT_STORAGE = "owned-immutable-git-objects-v1";
const digest = value => createHash("sha256").update(value).digest("hex");
export const nativeObjectStorageDescriptor = () => ({ kind: NATIVE_OBJECT_STORAGE,
  storeId: digest(NATIVE_OBJECT_STORAGE + ":sha1") });
const oid = value => /^[a-f0-9]{40}$/u.test(value);
const fail = message => Object.assign(new Error(message), { code: "NATIVE_OBJECT_STORAGE_UNPROVEN" });
const absent = async file => lstat(file).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; });
const physical = s => ({ dev: String(s.dev), ino: String(s.ino), birthtimeNs: String(s.birthtimeNs) });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function plain(file, directory = false) {
  const s = await lstat(file, { bigint: true });
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile())) throw fail("Object storage path is not plain");
  return s;
}
async function hashFile(file) {
  const h = await open(file, "r");
  try {
    const before = await h.stat({ bigint: true }), hash = createHash("sha256");
    if (!before.isFile()) throw fail("Object storage file changed type");
    for await (const b of h.createReadStream({ autoClose: false })) hash.update(b);
    const after = await plain(file);
    if (!equal(physical(before), physical(after)) || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw fail("Immutable object file changed during verification");
    }
    return { ...physical(after), bytes: String(after.size), sha256: hash.digest("hex") };
  } finally { await h.close(); }
}
async function immutableLink(source, destination) {
  const parent = physical(await plain(path.dirname(destination), true));
  const sourceParent = physical(await plain(path.dirname(source), true));
  const before = await hashFile(source);
  try { await link(source, destination); }
  catch (e) { if (e.code !== "EEXIST") throw e; }
  const after = await hashFile(destination);
  if (!equal(before, after) || !equal(before, await hashFile(source))
      || !equal(parent, physical(await plain(path.dirname(destination), true)))
      || !equal(sourceParent, physical(await plain(path.dirname(source), true)))) {
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
        || row.metadata.objectStorage.importOperationId !== storage.importOperationId
        || !equal(row.metadata.physicalRepository, physical(await plain(repository, true)))
        || !equal(row.metadata.physicalGit, physical(await plain(path.join(repository, ".git"), true)))) throw fail("Native object consumer custody changed");
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
    await this.assertCurrent();
    let cursor = this.dataDir;
    while (true) {
      await plain(cursor, true);
      const next = path.dirname(cursor); if (next === cursor) break; cursor = next;
    }
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
    for (const c of inputs) await this.#git(sourceRoot, ["cat-file", "-e", c + "^{commit}"]);
    const objects = String(await this.#git(sourceRoot, ["rev-list", "--objects", "--no-object-names", ...inputs])).split(/\r?\n/u).filter(Boolean).sort();
    if (!objects.length || objects.some(x => !oid(x)) || new Set(objects).size !== objects.length) throw fail("Source object closure is malformed");
    const closureSha256 = digest(objects.join("\n") + "\n");
    const binding = { ...this.descriptor(), inputs, closureSha256, objectCount: objects.length };
    const id = "native-object-import:" + digest(JSON.stringify(binding));
    let row = await this.#create(id, binding);
    row = await this.#transfer(sourceRoot, objects, id, row);
    if (row.status !== "succeeded") {
      for (const c of inputs) await this.#git(this.repository, ["cat-file", "-e", c + "^{commit}"]);
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

  async provision({ sourceRoot, repository, inputs, identityHash }) {
    if (!/^[a-f0-9]{64}$/u.test(identityHash)) throw fail("Exact native consumer identity required");
    return this.withLease(async () => {
      await this.#pool();
      const imported = await this.#import(sourceRoot, inputs);
      const binding = { ...this.descriptor(), repository: path.resolve(repository), inputs, identityHash,
        importOperationId: imported.operationId };
      let row = await this.#create("native-object-consumer:" + identityHash, binding);
      if (row.status !== "succeeded") {
        if (!await absent(repository)) throw fail("Unfinished native consumer requires its original recovery");
        const objects = String(await this.#git(this.repository,
          ["rev-list", "--objects", "--no-object-names", ...inputs])).split(/\r?\n/u).filter(Boolean).sort();
        if (objects.some(x => !oid(x)) || new Set(objects).size !== objects.length
            || objects.length !== imported.metadata.objectStorage.objectCount
            || digest(objects.join("\n") + "\n") !== imported.metadata.objectStorage.closureSha256) {
          throw fail("Consumer input closure differs from its owned import");
        }
        const required = new Set(objects);
        await this.#git(path.dirname(repository), ["init", "--object-format=sha1", "--template=" + path.join(this.root, "empty-hooks"), repository]);
        await this.#git(repository, ["config", "gc.auto", "0"]);
        const sourceObjects = path.join(this.repository, "objects"), destObjects = path.join(repository, ".git", "objects");
        for (const directory of await readdir(sourceObjects, { withFileTypes: true })) {
          if (!/^(?:[a-f0-9]{2}|pack)$/u.test(directory.name)) continue;
          const from = path.join(sourceObjects, directory.name), to = path.join(destObjects, directory.name);
          await plain(from, true); await mkdir(to, { recursive: true }); await plain(to, true);
          const files = await readdir(from), selectedPacks = new Set();
          if (directory.name === "pack") {
            for (const file of files.filter(f => /^pack-[a-f0-9]{40}\.idx$/u.test(f))) {
              await plain(path.join(from, file));
              const stem = file.slice(0, -4);
              await plain(path.join(from, stem + ".pack"));
              // Read only the immutable index to select a pack family. Do not
              // decompress every unrelated archived pack for each consumer.
              const indexFile = path.join(from, file), indexIdentity = await hashFile(indexFile);
              const inventory = String(await this.#git(this.repository, ["show-index"], { input: await readFile(indexFile) }));
              if (!equal(indexIdentity, await hashFile(indexFile))) throw fail("Owned pack index changed");
              const packed = inventory.split(/\r?\n/u).filter(Boolean).map(line => {
                const match = /^\d+ ([a-f0-9]{40})(?: \([a-f0-9]{8}\))?$/u.exec(line);
                if (!match) throw fail("Owned pack index inventory is malformed");
                return match[1];
              });
              if (!packed.length) throw fail("Owned pack inventory is empty");
              if (packed.some(x => required.has(x))) selectedPacks.add(stem);
            }
          }
          for (const file of files) {
            if (directory.name === "pack" && (file === "multi-pack-index" || /^pack-[a-f0-9]{40}\.keep$/u.test(file))) continue;
            if (!(directory.name === "pack" ? /^pack-[a-f0-9]{40}\.(?:pack|idx|rev|bitmap)$/u : /^[a-f0-9]{38}$/u).test(file)) throw fail("Foreign object-store entry");
            await plain(path.join(from, file));
            if (directory.name === "pack") {
              const stem = file.replace(/\.[^.]+$/u, "");
              if (!files.includes(stem + ".idx") || !files.includes(stem + ".pack")) throw fail("Owned pack pair is incomplete");
              if (!selectedPacks.has(stem)) continue;
            } else if (!required.has(directory.name + file)) continue;
            await immutableLink(path.join(from, file), path.join(to, file));
          }
        }
        for (const c of inputs) await this.#git(repository, ["cat-file", "-e", c + "^{commit}"]);
        await this.#git(repository, ["fsck", "--connectivity-only", "--no-dangling", ...inputs]);
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
          + "author Agent Hub Storage <storage@invalid> " + timestamp + " +0000\n"
          + "committer Agent Hub Storage <storage@invalid> " + timestamp + " +0000\n\n" + message + "\n" }));
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

  async readArchive(archive) {
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
  withArchiveLease(archive, consume) {
    return this.withLease(async () => {
      const stored = await this.readArchive(archive);
      await this.#retireTransferAliases(this.store.getReadonly(archive.operationId));
      return consume(stored);
    });
  }

  async withArchiveMath(archive, verify) {
    return this.withLease(async () => {
      const stored = await this.readArchive(archive);
      await this.#retireTransferAliases(this.store.getReadonly(archive.operationId));
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
    });
  }
}
