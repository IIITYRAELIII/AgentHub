import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { deleteSealedTransport } from "./sealed-transport-delete.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const absent = error => { if (error?.code === "ENOENT") return null; throw error; };
const retained = reason => ({ status: "retained", reason });

async function plain(target, directory = true) {
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error("transport-plain-path-required");
  return info;
}

async function stateAt(root) {
  const file = path.join(root, "merge.json");
  const info = await plain(file, false);
  if (info.nlink !== 1n || info.size > 256n * 1024n) throw new Error("transport-state-budget");
  const bytes = await readFile(file);
  if (BigInt(bytes.length) !== info.size) throw new Error("transport-state-changed");
  return { state: JSON.parse(bytes), hash: digest(bytes) };
}

async function bundleAt(file) {
  const info = await plain(file, false).catch(absent);
  if (!info) return null;
  if (info.nlink !== 1n) throw new Error("transport-hardlink-retained");
  if (info.size > 8n * 1024n ** 3n) throw new Error("transport-unit-size-budget");
  const handle = await open(file, "r");
  try {
    const before = await handle.stat({ bigint: true });
    const sha = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) sha.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].some(k => before[k] !== after[k] || before[k] !== info[k])) {
      throw new Error("transport-file-changed");
    }
    return { dev: String(info.dev), ino: String(info.ino), size: String(info.size), sha256: sha.digest("hex") };
  } finally { await handle.close(); }
}

async function freeBytes(root) {
  try { const info = await statfs(root, { bigint: true }); return String(info.bavail * info.bsize); }
  catch { return null; }
}

// This is the native merge owner's *transport* cleanup. It never retires a
// repository, Task branch, merge journal, resolution evidence or user files.
// A completed/published Task and the existing Task Git lease are mandatory.
export class NativeMergeTransportRetention {
  id = "native-merge-transport";

  constructor({ dataDir, taskBoard, taskGitWorkspaces, gitAt, deleteTransport = deleteSealedTransport,
    isStopping = () => false, platform = process.platform } = {}) {
    Object.assign(this, { root: path.join(dataDir, "task-native-merges"), taskBoard, taskGitWorkspaces,
      gitAt, deleteTransport, isStopping, platform });
  }

  async list({ after, limit }) {
    const root = await lstat(this.root).catch(absent);
    if (!root) return { items: [], done: true };
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("transport-root-not-plain");
    // Only this owner's flat capture names; no recursive walk or Task/history scan.
    const names = (await readdir(this.root)).filter(n => /^[a-f0-9]{24}$/u.test(n) && (!after || n > after)).sort();
    return { items: names.slice(0, limit).map(id => ({ id, cursor: id })), done: names.length <= limit };
  }

  async #owned(candidate, action) {
    if (!/^[a-f0-9]{24}$/u.test(candidate?.id)) return retained("unknown-capture");
    await plain(this.root);
    const root = path.join(this.root, candidate.id);
    await plain(root);
    const first = await stateAt(root);
    const identity = first.state?.identity;
    if (first.state.version !== 1 || identity?.policy !== "native-dev-merge-v1"
        || !/^[a-f0-9-]{36}$/u.test(identity.taskId ?? "")
        || digest(JSON.stringify(identity)).slice(0, 24) !== candidate.id) return retained("unknown-capture");
    return this.taskGitWorkspaces.withTaskLock(identity.taskId, async lease => {
      await lease.assertOwned();
      if (this.isStopping()) return retained("runtime-stopping");
      await plain(this.root); await plain(root);
      const current = await stateAt(root);
      if (current.hash !== first.hash) return retained("capture-changed");
      const task = this.taskBoard.task(identity.taskId);
      if (task?.workflowStatus !== "done" || task.status !== "done" || !task.completedAt
          || !task.gitReferences?.length) return retained("task-not-completed");
      const publication = await this.taskGitWorkspaces.cleanupPreview(identity.taskId, {
        gitReferences: task.gitReferences, squashAbsorbedBy: task.squashAbsorbedBy,
      });
      if (publication.dirty || publication.unpublished.length
          || !publication.gitReferences.length || publication.gitReferences.some(r => !r.publishedRevision || !r.publicationGeneration)) {
        return retained("publication-or-work-pinned");
      }
      const state = current.state;
      if (state.next !== 1 || state.merges?.length !== 1 || state.conflict || state.merging
          || state.merges[0].taskId !== identity.taskId || state.merges[0].resultCommit !== identity.resultCommit) {
        return retained("merge-incomplete");
      }
      const repository = path.join(root, "repository");
      await plain(repository); await plain(path.join(repository, ".git"));
      await plain(path.join(repository, ".git", "objects"));
      await plain(path.join(repository, ".git", "objects", "info"));
      if (await lstat(path.join(repository, ".git", "objects", "info", "alternates")).catch(absent)) return retained("borrowed-objects");
      const git = (args, options) => this.gitAt(repository, args, { ...options, lease });
      if ((await realpath(path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])))).toLowerCase()
            !== (await realpath(path.join(repository, ".git"))).toLowerCase()
          || await git(["rev-parse", "--is-shallow-repository"]) !== "false"
          || await git(["rev-parse", "HEAD^{commit}"]) !== state.head
          || await git(["status", "--porcelain=v1", "--untracked-files=all"])) return retained("capture-work-pinned");
      for (const commit of [identity.before, identity.resultCommit, state.head]) await git(["cat-file", "-e", `${commit}^{commit}`]);
      const bundle = path.join(root, "source.bundle");
      const file = await bundleAt(bundle);
      const assertCurrent = async () => {
        await lease.assertOwned();
        if (this.isStopping() || this.taskBoard.task(identity.taskId)?.revision !== task.revision
            || (await stateAt(root)).hash !== current.hash
            || JSON.stringify(await this.taskGitWorkspaces.cleanupPreview(identity.taskId, {
              gitReferences: task.gitReferences, squashAbsorbedBy: task.squashAbsorbedBy,
            })) !== JSON.stringify(publication)) throw new Error("transport-admission-changed");
      };
      return action({ root, bundle, file, stateHash: current.hash, taskRevision: task.revision,
        publication, git, lease, assertCurrent });
    }, { timeoutMs: 250 });
  }

  async #preview(owned) {
    if (!owned.file) return retained("transport-absent");
    if (this.platform !== "win32") return retained("sealed-delete-unavailable");
    const heads = String(await owned.git(["bundle", "list-heads", owned.bundle])).split(/\r?\n/u).filter(Boolean);
    if (!heads.length || heads.length > 4096 || Buffer.byteLength(JSON.stringify(heads)) > 32 * 1024
        || heads.some(h => !/^[a-f0-9]{40,64} \S+$/u.test(h))) return retained("bundle-head-budget");
    await owned.git(["bundle", "verify", owned.bundle]);
    const input = `${heads.map(h => h.split(" ")[0]).join("\n")}\n`;
    const objects = String(await owned.git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input })).split(/\r?\n/u);
    if (objects.length !== heads.length || objects.some((entry, i) => !new RegExp(`^${heads[i].split(" ")[0]} (commit|tag|tree|blob)$`, "u").test(entry))) {
      return retained("bundle-objects-unavailable");
    }
    await owned.git(["rev-list", "--objects", "--quiet", "--missing=error", "--stdin"], {
      input,
    });
    await owned.lease.assertOwned();
    const checked = await bundleAt(owned.bundle);
    if (JSON.stringify(checked) !== JSON.stringify(owned.file)) return retained("transport-changed");
    return { status: "eligible", binding: { file: checked, stateHash: owned.stateHash,
      taskRevision: owned.taskRevision, publication: owned.publication, heads } };
  }

  async preview({ candidate }) {
    try { return await this.#owned(candidate, owned => this.#preview(owned)); }
    catch { return retained("owner-verification-unavailable"); }
  }

  async prune({ candidate, binding }) {
    return this.#owned(candidate, async owned => {
      const current = await this.#preview(owned);
      if (current.status !== "eligible") return current;
      if (JSON.stringify(current.binding) !== JSON.stringify(binding)) return retained("preview-changed");
      await owned.assertCurrent();
      const before = await freeBytes(this.root);
      await this.deleteTransport(await realpath(owned.bundle), binding.file);
      const after = await freeBytes(this.root);
      return { status: "removed", logicalBytes: Number(binding.file.size),
        freeBeforeBytes: before, freeAfterBytes: after,
        observedFreeDeltaBytes: before !== null && after !== null ? String(BigInt(after) - BigInt(before)) : null };
    });
  }

  async reconcile({ candidate, binding }) {
    const result = await this.#owned(candidate, async owned => {
      if (owned.stateHash !== binding.stateHash) return { status: "unknown", reason: "original-capture-changed" };
      if (!owned.file) return { status: "already-removed", logicalBytes: 0 };
      // There is no evidence that an interrupted destructive child is dead just
      // because its caller lost the reply. Preserve the SAME original intent.
      return { status: "unknown", reason: "original-effect-unresolved" };
    });
    return result.status === "retained" ? { status: "unknown", reason: "original-owner-unavailable" } : result;
  }
}
