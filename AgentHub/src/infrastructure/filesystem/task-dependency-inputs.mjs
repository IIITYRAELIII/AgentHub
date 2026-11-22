import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { measureTaskOperation, recordTaskOperationTiming } from "../process/task-operation-timing.mjs";

const MARKER = ".agent-hub-task-dependencies.json";
const FILE_BATCH_SIZE = 16;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const physical = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeMs: stat.birthtimeMs });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const missing = async file => lstat(file).then(() => false, e => { if (e.code === "ENOENT") return true; throw e; });
const fail = message => Object.assign(new Error(message), { code: "TASK_DEPENDENCY_INPUT_UNPROVEN" });
async function plainRoot(root) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(await realpath(root)).toLowerCase() !== path.resolve(root).toLowerCase()) {
    throw fail("Dependency input path is not an owned plain directory");
  }
  return physical(stat);
}
async function exclusive(file, bytes) {
  const h = await open(file, "wx");
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
}
async function inventory(root, limits, payloads = new Map()) {
  return measureTaskOperation("dependency-inventory", () => inventoryOwned(root, limits, payloads), { detail: true });
}

async function inventoryOwned(root, limits, payloads) {
  const files = [], directories = [], pending = [""];
  let entries = 0;
  let payloadReadBytes = 0;
  let payloadReads = 0;
  let reusedPayloads = 0;
  async function inspect(relative, name) {
    const key = relative ? relative + "/" + name : name;
    const file = path.join(root, key);
    const before = await lstat(file);
    if (before.isSymbolicLink()) {
      const target = await readlink(file);
      const resolved = path.resolve(path.dirname(file), target);
      if (path.isAbsolute(target) || !resolved.startsWith(path.resolve(root) + path.sep)) throw fail("Dependency input link escapes its input");
      return { path: key, target };
    }
    if (before.isDirectory()) return { path: key, directory: true };
    if (!before.isFile()) throw fail("Dependency input contains an unsupported file");
    const identity = physical(before);
    const payloadKey = JSON.stringify([identity, before.size, before.mtimeMs, before.ctimeMs]);
    let payload = payloads.get(payloadKey);
    if (!payload) {
      payload = (async () => {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(file)) {
          hash.update(chunk);
          bytes += chunk.length;
        }
        payloadReads += 1;
        payloadReadBytes += bytes;
        return { bytes, sha256: hash.digest("hex") };
      })();
      payloads.set(payloadKey, payload);
    } else reusedPayloads += 1;
    const content = await payload;
    const after = await lstat(file);
    if (!same(identity, physical(after)) || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || content.bytes !== after.size) throw fail("Dependency input changed while read");
    return { path: key, ...content, identity: physical(after) };
  }
  while (pending.length) {
    const relative = pending.pop(), dir = path.join(root, relative);
    await plainRoot(dir);
    const names = await readdir(dir);
    if (names.length > limits.maxEntriesPerDirectory) throw fail("Dependency input directory exceeds existing tree bound");
    const included = names.filter(name => relative || ![MARKER, ".cache"].includes(name)).sort();
    entries += included.length;
    if (entries > limits.maxTotalDirectoryEntries) throw fail("Dependency input exceeds existing tree bound");
    for (let offset = 0; offset < included.length; offset += FILE_BATCH_SIZE) {
      const batch = included.slice(offset, offset + FILE_BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(name => inspect(relative, name)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
        const entry = result.value;
        if (entry.directory) {
          directories.push(entry.path);
          pending.push(entry.path);
        } else files.push(entry);
      }
    }
  }
  recordTaskOperationTiming("dependency-inventory-result", { entries, payloadReads, payloadReadBytes, reusedPayloads }, { detail: true });
  return { directories: directories.sort(), files: files.sort((a,b) => a.path.localeCompare(b.path)) };
}

export async function retainSharedTaskDependencies(packageRoot, previous) {
  const target = path.join(packageRoot, "node_modules");
if (!/^[a-f0-9]{64}$/u.test(previous.lockfileSha256 ?? "")
            || previous.sharedStorage?.fingerprint !== previous.lockfileSha256
            || previous.sharedStorage?.kind !== "owned-dependency-input-v1") throw fail("Prior dependency custody malformed; retained");
        await plainRoot(target);
        const retained = path.join(packageRoot, ".agent-hub-dependency-retained");
        await mkdir(retained, { recursive: true }); await plainRoot(retained);
        const destination = path.join(retained, String(previous.lockfileSha256));
        if (!await missing(destination)) throw fail("Prior dependency retirement destination exists; retained");
        await rename(target, destination);
}

// Called only by prepareTaskWorktreeDependencies under its Task lock plus the
// existing TaskGit durable process-tree owner for this exact compatibility key.
export async function reuseTaskDependencyInputs({ packageRoot, fingerprint, manifestContent, lockfileContent,
  withOwner, lease, limits, prepare, assertSourceContext = async () => {} }) {
  return withOwner(fingerprint, async ({ root, lease: sharedLease, coveredLease }) => {
    const payloads = new Map();
    const assertOwners = async () => {
      if (coveredLease !== lease) await lease?.assertOwned();
      await sharedLease.assertOwned();
    };
    const assertCurrent = async () => {
      await assertOwners();
      await assertSourceContext();
      if (!(await readFile(path.join(packageRoot, "package.json"))).equals(manifestContent)
          || !(await readFile(path.join(packageRoot, "package-lock.json"))).equals(lockfileContent)) throw fail("Task dependency inputs changed");
    };
    await assertCurrent();
    const parent = path.dirname(root); await mkdir(parent, { recursive: true }); await plainRoot(parent);
    const newSlot = await missing(root), slotFile = path.join(root, "input.json");
    if (newSlot) {
      await mkdir(root); await plainRoot(root);
      await exclusive(path.join(root, "package.json"), manifestContent);
      await exclusive(path.join(root, "package-lock.json"), lockfileContent);
      await exclusive(path.join(root, "intent.json"), JSON.stringify({ fingerprint }));
      await prepare(root, sharedLease);
      await assertCurrent();
      const modules = path.join(root, "node_modules"), content = await inventory(modules, limits, payloads);
      // Package payload is immutable. Every Task owns its own directory, stamp
      // and mutable .cache; package/bin aliases retain their relative layout.
      for (const file of content.files) if (!file.target) await chmod(path.join(modules, file.path), 0o444);
      const marker = await readFile(path.join(modules, MARKER));
      await exclusive(slotFile, JSON.stringify({ fingerprint, root: await plainRoot(root),
        modules: await plainRoot(modules), manifestSha256: digest(manifestContent), lockSha256: digest(lockfileContent),
        markerSha256: digest(marker), content }));
    }
    if (await missing(slotFile)) throw fail("Unfinished dependency input requires its original owning recovery; retained");
    const slot = JSON.parse(await readFile(slotFile));
    const modules = path.join(root, "node_modules");
    if (slot.fingerprint !== fingerprint || slot.manifestSha256 !== digest(manifestContent)
        || slot.lockSha256 !== digest(lockfileContent) || !same(slot.root, await plainRoot(root))
        || !same(slot.modules, await plainRoot(modules)) || !same(slot.content, await inventory(modules, limits, payloads))
        || slot.markerSha256 !== digest(await readFile(path.join(modules, MARKER)))) throw fail("Published dependency input custody changed");
    await assertCurrent();
    const target = path.join(packageRoot, "node_modules"), stamp = path.join(target, MARKER);
    const sharedStorage = { kind: "owned-dependency-input-v1", root, fingerprint,
      inputSha256: digest(await readFile(slotFile)) };
    let linkedBytes = 0, prepared = false;
    if (!await missing(target)) {
      const previous = JSON.parse(await readFile(stamp));
      if (!same(previous.sharedStorage, sharedStorage)) {
        // Retain prior aliases and any unique cache/work on input changes; this
        // atomic local move neither copies nor edits their shared input files.
        await retainSharedTaskDependencies(packageRoot, previous);
      }
    }
    if (await missing(target)) {
      await mkdir(target); await plainRoot(target); prepared = true;
      // Intent stamp precedes aliases; a partial attach is not silently npm-ci'd.
      const original = JSON.parse(await readFile(path.join(modules, MARKER)));
      await exclusive(stamp, JSON.stringify({ ...original, sharedStorage, attaching: true }));
      for (const dir of slot.content.directories) await mkdir(path.join(target, dir), { recursive: true });
      for (let offset = 0; offset < slot.content.files.length; offset += FILE_BATCH_SIZE) {
        const batch = slot.content.files.slice(offset, offset + FILE_BATCH_SIZE);
        await assertOwners();
        // This batch belongs to the current attaching stamp. Join its effects
        // before checking ownership again or allowing the owner to release it.
        const results = await Promise.allSettled(batch.map(async file => {
          const from = path.join(modules, file.path);
          const to = path.join(target, file.path);
          await plainRoot(path.dirname(from));
          await plainRoot(path.dirname(to));
          lease?.signal?.throwIfAborted();
          sharedLease.signal?.throwIfAborted();
          if (file.target) {
            await symlink(file.target, to);
            return 0;
          }
          await link(from, to);
          return file.bytes;
        }));
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          linkedBytes += result.value;
        }
      }
      // Existing stamp writer is used by the caller after complete validation.
      await assertCurrent();
      const completed = stamp + "." + randomUUID() + ".tmp";
      await exclusive(completed, JSON.stringify({ ...original, sharedStorage }));
      await rename(completed, stamp);
    }
    const marker = JSON.parse(await readFile(stamp));
    if (marker.attaching || !same(marker.sharedStorage, sharedStorage)) throw fail("Incomplete dependency alias attachment; retained");
    const attached = await inventory(target, limits, payloads);
    if (!same(attached, slot.content)) throw fail("Task dependency aliases or content differ from their input; retained");
    await assertCurrent();
    return { prepared, reused: true, sharedStorage, linkedBytes, copiedPackageBytes: 0 };
  });
}
