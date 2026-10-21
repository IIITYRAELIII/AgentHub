import { createHash } from "node:crypto";
import { lstat, open, opendir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { deleteSealedTransport } from "./sealed-transport-delete.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const retained = reason => ({ status: "retained", reason });
const absent = error => { if (error.code === "ENOENT") return null; throw error; };
const same = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
const keys = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"];

async function plain(file, directory = true) {
  const value = await lstat(file, { bigint: true });
  if (value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile())) throw new Error("release-transport-plain-required");
  return value;
}

async function metadata(file) {
  const first = await plain(file, false);
  if (first.nlink !== 1n || first.size > 1024n * 1024n) throw new Error("release-transport-metadata-budget");
  const held = await open(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    for (;;) {
      const next = await held.read(buffer, length, buffer.length - length, length);
      length += next.bytesRead;
      if (length === buffer.length) throw new Error("release-transport-metadata-budget");
      if (!next.bytesRead) break;
    }
    const bytes = buffer.subarray(0, length);
    const last = await held.stat({ bigint: true });
    if (BigInt(bytes.length) !== first.size || keys.some(key => first[key] !== last[key])) throw new Error("release-transport-metadata-changed");
    return { value: JSON.parse(bytes), hash: hash(bytes) };
  } finally { await held.close(); }
}

async function transport(file) {
  const first = await plain(file, false).catch(absent);
  if (!first) return null;
  if (first.nlink !== 1n || first.size > 8n * 1024n ** 3n) throw new Error("release-transport-file-budget");
  const held = await open(file, "r");
  try {
    const digest = createHash("sha256");
    let length = 0n;
    for await (const chunk of held.createReadStream({ autoClose: false })) {
      length += BigInt(chunk.length);
      if (length > first.size) throw new Error("release-transport-file-changed");
      digest.update(chunk);
    }
    const last = await held.stat({ bigint: true });
    if (keys.some(key => first[key] !== last[key])) throw new Error("release-transport-file-changed");
    return { dev: String(first.dev), ino: String(first.ino), size: String(first.size), sha256: digest.digest("hex") };
  } finally { await held.close(); }
}

async function freeBytes(root) {
  try { const info = await statfs(root, { bigint: true }); return info.bavail * info.bsize; }
  catch { return null; }
}

// Only a redundant bundle, under the existing release-generation lease. The
// independent repository, refs, manifests, checkpoints and all WIP survive.
export class ReleaseGenerationTransportRetention {
  id = "release-generation-transport";

  constructor({ dataDir, readGeneration, withGenerationLease, gitAt,
    deleteTransport = deleteSealedTransport, isStopping = () => false, platform = process.platform } = {}) {
    if ([readGeneration, withGenerationLease, gitAt].some(value => typeof value !== "function")) throw new TypeError("Release retention owner ports required");
    Object.assign(this, { root: path.join(dataDir, "release-gens"), readGeneration, withGenerationLease,
      gitAt, deleteTransport, isStopping, platform });
  }

  async list({ after, limit }) {
    const root = await lstat(this.root).catch(absent);
    if (!root) return { items: [], done: true };
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("release-transport-root-not-plain");
    const names = [];
    let entries = 0;
    for await (const entry of await opendir(this.root)) {
      if (++entries > 8192) throw new Error("release-transport-inventory-budget");
      if (/^[a-f0-9]{24}$/u.test(entry.name) && (!after || entry.name > after)) names.push(entry.name);
    }
    names.sort();
    return { items: names.slice(0, limit).map(id => ({ id, cursor: id })), done: names.length <= limit };
  }

  async #owned(candidate, action) {
    if (!/^[a-f0-9]{24}$/u.test(candidate?.id)) return retained("unknown-release-generation");
    // Do not queue behind a still-active generation merely to learn that its
    // original release is unfinished. The same proof is re-read under custody.
    await plain(this.root);
    await plain(path.join(this.root, candidate.id));
    const before = await metadata(path.join(this.root, candidate.id, "identity.json"));
    if (!await this.readGeneration(before.value.operationId, before.value.generation)) return retained("release-not-completed-published");
    return this.withGenerationLease(candidate.id, async lease => {
      await lease.assertOwned();
      if (this.isStopping()) return retained("runtime-stopping");
      await plain(this.root);
      const root = path.join(this.root, candidate.id);
      await plain(root);
      const identity = await metadata(path.join(root, "identity.json"));
      if (identity.hash !== before.hash) return retained("release-generation-proof-mismatch");
      const value = identity.value;
      if (value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 1
          || typeof value.operationId !== "string" || !value.operationId || !path.isAbsolute(value.repositoryRoot ?? "")
          || hash(`${value.operationId}:${value.generation}:${value.repositoryRoot}`) !== value.identitySha256
          || value.identitySha256.slice(0, 24) !== candidate.id) return retained("unknown-release-generation");
      const proof = await this.readGeneration(value.operationId, value.generation);
      if (!proof) return retained("release-not-completed-published");
      const candidates = proof.candidates.filter(item => same(item.repositoryRoot, value.repositoryRoot));
      if (candidates.length !== 1 || !candidates[0].generationRoot
          || !same(await realpath(candidates[0].generationRoot), await realpath(root))) return retained("release-generation-proof-mismatch");
      const published = candidates[0];
      if (![published.commit, published.tree].every(item => /^[a-f0-9]{40,64}$/u.test(item ?? ""))
          || !/^[a-f0-9]{64}$/u.test(published.manifestHash ?? "")) return retained("release-generation-proof-mismatch");
      const owner = path.join(root, "release-repositories", taskRepositoryKey(value.repositoryRoot));
      await plain(path.dirname(owner)); await plain(owner);
      const repository = path.join(owner, "repository");
      await plain(repository); await plain(path.join(repository, ".git"));
      await plain(path.join(repository, ".git", "objects")); await plain(path.join(repository, ".git", "objects", "info"));
      if (await lstat(path.join(repository, ".git", "objects", "info", "alternates")).catch(absent)) return retained("release-borrowed-objects");
      await plain(path.join(repository, ".git", "info"));
      if (await lstat(path.join(repository, ".git", "info", "grafts")).catch(absent)) return retained("release-rewritten-object-history");
      const marker = await metadata(path.join(repository, ".git", "agent-hub-release-clone.json"));
      if (marker.value.kind !== "agent-hub-owned-release-clone"
          || !same(marker.value.primaryRoot, value.repositoryRoot)
          || !same(await realpath(marker.value.releaseRoot), await realpath(repository))) return retained("release-clone-owner-mismatch");
      const checkpoint = await metadata(path.join(owner, "checkpoint.json"));
      if (checkpoint.value.preReleaseHead !== published.commit || checkpoint.value.manifestHash !== published.manifestHash
          || checkpoint.value.phase !== "frozen") return retained("release-checkpoint-mismatch");
      const manifest = await metadata(path.join(owner, "evidence", `${published.manifestHash}.json`));
      if (manifest.hash !== published.manifestHash) return retained("release-manifest-changed");
      const git = (args, options) => this.gitAt(repository, args, { ...options, lease });
      const config = await git(["config", "--local", "--list"]);
      if (/^(extensions\.partialclone|remote\..*\.promisor)=/imu.test(config)) return retained("release-borrowed-objects");
      if (!same(await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])), await realpath(path.join(repository, ".git")))
          || await git(["rev-parse", "--is-shallow-repository"]) !== "false"
          || await git(["rev-parse", "HEAD^{commit}"]) !== published.commit
          || await git(["rev-parse", "HEAD^{tree}"]) !== published.tree
          || await git(["status", "--porcelain=v1", "--untracked-files=all"])) return retained("release-capture-work-pinned");
      const bundle = path.join(root, "source.bundle"), file = await transport(bundle);
      const stateHash = hash(JSON.stringify({ identity: identity.hash, marker: marker.hash, checkpoint: checkpoint.hash,
        manifest: manifest.hash, proof }));
      const assertCurrent = async () => {
        await lease.assertOwned();
        if (this.isStopping() || JSON.stringify(await this.readGeneration(value.operationId, value.generation)) !== JSON.stringify(proof)
            || (await metadata(path.join(root, "identity.json"))).hash !== identity.hash
            || (await metadata(path.join(owner, "checkpoint.json"))).hash !== checkpoint.hash
            || (await metadata(path.join(repository, ".git", "agent-hub-release-clone.json"))).hash !== marker.hash
            || (await metadata(path.join(owner, "evidence", `${published.manifestHash}.json`))).hash !== manifest.hash
            || await lstat(path.join(repository, ".git", "objects", "info", "alternates")).catch(absent)
            || await lstat(path.join(repository, ".git", "info", "grafts")).catch(absent)
            || /^(extensions\.partialclone|remote\..*\.promisor)=/imu.test(await git(["config", "--local", "--list"]))
            || await git(["rev-parse", "--is-shallow-repository"]) !== "false"
            || !same(await realpath(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])), await realpath(path.join(repository, ".git")))
            || await git(["rev-parse", "HEAD^{commit}"]) !== published.commit
            || await git(["status", "--porcelain=v1", "--untracked-files=all"])) throw new Error("release-transport-admission-changed");
      };
      return action({ bundle, file, git, lease, stateHash, assertCurrent, proof });
    });
  }

  async #preview(owned) {
    if (!owned.file) return retained("release-transport-absent");
    if (this.platform !== "win32") return retained("sealed-delete-unavailable");
    const heads = String(await owned.git(["bundle", "list-heads", owned.bundle])).split(/\r?\n/u).filter(Boolean);
    if (!heads.length || heads.length > 4096 || Buffer.byteLength(JSON.stringify(heads)) > 32 * 1024
        || heads.some(item => !/^[a-f0-9]{40,64} \S+$/u.test(item))) return retained("release-bundle-head-budget");
    await owned.git(["bundle", "verify", owned.bundle]);
    const input = `${heads.map(item => item.split(" ")[0]).join("\n")}\n`;
    const objects = String(await owned.git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input })).split(/\r?\n/u);
    if (objects.length !== heads.length || objects.some((item, i) => !new RegExp(`^${heads[i].split(" ")[0]} (commit|tag|tree|blob)$`, "u").test(item))) return retained("release-bundle-objects-unavailable");
    await owned.git(["rev-list", "--objects", "--quiet", "--missing=error", "--stdin"], { input });
    if (!await this.#anchored(owned, heads)) return retained("release-bundle-roots-unanchored");
    if (JSON.stringify(await transport(owned.bundle)) !== JSON.stringify(owned.file)) return retained("release-transport-changed");
    return { status: "eligible", binding: { file: owned.file, stateHash: owned.stateHash,
      operationId: owned.proof.operationId, generation: owned.proof.generation, generationIdentitySha256: owned.proof.identitySha256, heads } };
  }

  async #anchored(owned, heads) {
    // Present dangling objects can be discarded by a later ordinary Git GC.
    // Require retained refs/HEAD instead of inventing new keeper refs.
    const peeled = String(await owned.git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      input: heads.map(item => item.split(" ")[0] + "^{commit}").join("\n") + "\n",
    })).split(/\r?\n/u);
    if (peeled.length !== heads.length || peeled.some(item => !/^[a-f0-9]{40,64} commit$/u.test(item))
        || await owned.git(["rev-list", "--max-count=1", "--stdin", "--not", "--all"], {
          input: peeled.map(item => item.split(" ")[0]).join("\n") + "\n",
        })) return false;
    return true;
  }

  async preview({ candidate }) {
    try { return await this.#owned(candidate, owned => this.#preview(owned)); }
    catch { return retained("release-owner-verification-unavailable"); }
  }

  async prune({ candidate, binding }) {
    return this.#owned(candidate, async owned => {
      const preview = await this.#preview(owned);
      if (preview.status !== "eligible") return preview;
      if (JSON.stringify(preview.binding) !== JSON.stringify(binding)) return retained("release-preview-changed");
      await owned.assertCurrent();
      if (!await this.#anchored(owned, binding.heads)) return retained("release-bundle-roots-unanchored");
      const before = await freeBytes(this.root);
      await this.deleteTransport(await realpath(owned.bundle), binding.file);
      const after = await freeBytes(this.root);
      return { status: "removed", logicalBytes: Number(binding.file.size), freeBeforeBytes: before === null ? null : String(before),
        freeAfterBytes: after === null ? null : String(after), observedFreeDeltaBytes: before === null || after === null ? null : String(after - before) };
    });
  }

  async reconcile({ candidate, binding }) {
    try {
      const result = await this.#owned(candidate, async owned => {
        if (owned.stateHash !== binding.stateHash) return { status: "unknown", reason: "release-original-capture-changed" };
        return !owned.file ? { status: "already-removed", logicalBytes: 0 } : { status: "unknown", reason: "release-original-effect-unresolved" };
      });
      return result.status === "retained" ? { status: "unknown", reason: result.reason } : result;
    } catch { return { status: "unknown", reason: "release-original-owner-unavailable" }; }
  }
}
