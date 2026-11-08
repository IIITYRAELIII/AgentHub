import path from "node:path";
import { createHash } from "node:crypto";
import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { withInterprocessLocks } from "../process/interprocess-lock.mjs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { readRuntimeManifest, readRuntimePointer, captureRuntimeReleaseBinding, sameRuntimeBinding } from "./runtime-installation-custody.mjs";
const inside = (parent, child) => {
  const relative = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return relative === "" || relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};
const missing = e => { if (e.code === "ENOENT") return null; throw e; };
async function objectStores(source, retiredGenerationSource) {
  const stores = [], seen = new Set();
  let cursor = source, git = null;
  while (true) {
    const marker = path.join(cursor, ".git"), s = await lstat(marker).catch(missing);
    if (s) {
      if (s.isSymbolicLink()) throw new Error("Prepared source Git marker redirected");
      if (s.isDirectory()) git = marker;
      else {
        const m = /^gitdir: ([^\r\n]+)\r?\n?$/u.exec(await readFile(marker, "utf8"));
        if (!m) throw new Error("Prepared source Git marker unknown");
        git = path.resolve(cursor, m[1]);
      }
      break;
    }
    const next = path.dirname(cursor); if (cursor === next) break; cursor = next;
  }
  if (!git) {
    if (!await retiredGenerationSource()) throw new Error("Prepared source Git custody unavailable");
    // A restored borrower after the canonical read cannot inherit Gitless proof.
    for (let current = source;;) {
      if (await lstat(path.join(current, ".git")).catch(missing)) throw new Error("Prepared source Git custody changed");
      const next = path.dirname(current); if (next === current) break; current = next;
    }
    return [];
  }
  const common = await readFile(path.join(git, "commondir"), "utf8").catch(missing);
  if (common !== null) git = path.resolve(git, common.replace(/\r?\n$/u, ""));
  const pending = [path.join(git, "objects")];
  while (pending.length) {
    const store = pending.pop(), s = await lstat(store);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Prepared object-store path redirected");
    const resolved = await realpath(store), key = resolved.toLowerCase();
    if (seen.has(key)) continue; seen.add(key); stores.push(resolved);
    const raw = await readFile(path.join(store, "info", "alternates"), "utf8").catch(missing);
    if (raw !== null) for (const item of raw.split(/\r?\n/u).filter(Boolean)) pending.push(path.resolve(store, item));
  }
  return stores;
}

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function ordinarySourceHistory() {
  if (["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_INDEX_FILE", "GIT_REPLACE_REF_BASE"].some(name => process.env[name])) {
    throw new Error("Retired source requires ordinary local Git source custody");
  }
}
async function stableJson(file) {
  const before = await lstat(file, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 1024n * 1024n) throw new Error("Retired source archive metadata unproven");
  const bytes = await readFile(file), after = await lstat(file, { bigint: true });
  if (BigInt(bytes.length) !== before.size || ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"].some(k => before[k] !== after[k])) throw new Error("Retired source archive metadata changed");
  return { value: JSON.parse(bytes), sha256: digest(bytes) };
}
async function plainDirectory(directory) {
  const s = await lstat(directory);
  if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Retired source path redirected");
}
// A completed generation's owner archives these exact originals before removing
// its disposable clone. A retained Gitless remainder is still a source pin by
// path, but is not an object-store borrower after positive original proof.
// No source file, archive, Git ref or maintenance row is changed here.
async function retiredGenerationSource(runtimeRoot, source, manifest, readGeneration) {
  if (typeof readGeneration !== "function" || !samePath(manifest.sourceRoot, source)
      || !/^[a-f0-9]{40}$/u.test(manifest.publicationRevision ?? "")) return false;
  ordinarySourceHistory();
  const dataDir = path.join(runtimeRoot, "data"), gens = path.join(dataDir, "release-gens");
  const relative = path.relative(gens, source).split(path.sep);
  if (relative.length !== 5 || !/^[a-f0-9]{24}$/u.test(relative[0]) || relative[1] !== "release-repositories"
      || relative[3] !== "repository" || relative[4] !== "AgentHub") return false;
  const key = relative[0], generationRoot = path.join(gens, key), archive = path.join(dataDir, "release-generation-evidence", key);
  return withInterprocessLocks([path.join(dataDir, "locks", `release-generation-${key}`)], async lease => {
    await lease.assertOwned();
    for (const directory of [dataDir, gens, generationRoot, path.join(generationRoot, "release-repositories"),
      path.dirname(path.dirname(source)), path.dirname(source), source, path.dirname(archive), archive, path.join(archive, "evidence")]) await plainDirectory(directory);
    if (await lstat(path.join(generationRoot, "identity.json")).catch(missing)) return false;
    const identity = await stableJson(path.join(archive, "identity.json")), id = identity.value;
    if (id.schemaVersion !== 1 || typeof id.operationId !== "string" || !id.operationId
        || !Number.isSafeInteger(id.generation) || id.generation < 1 || !path.isAbsolute(id.repositoryRoot ?? "")
        || id.identitySha256 !== digest(`${id.operationId}:${id.generation}:${id.repositoryRoot}`)
        || id.identitySha256.slice(0, 24) !== key || relative[2] !== taskRepositoryKey(id.repositoryRoot)) return false;
    const proof = await readGeneration(id.operationId, id.generation);
    if (!proof || proof.kind || proof.operationId !== id.operationId || proof.generation !== id.generation || !proof.completedAt) return false;
    const candidates = proof.candidates.filter(c => samePath(c.repositoryRoot, id.repositoryRoot));
    if (candidates.length !== 1) return false;
    const candidate = candidates[0];
    if (!samePath(candidate.generationRoot ?? "", generationRoot) || !samePath(candidate.releaseRoot, path.dirname(source))
        || candidate.commit !== manifest.publicationRevision || !/^[a-f0-9]{64}$/u.test(candidate.manifestHash ?? "")) return false;
    const checkpoint = await stableJson(path.join(archive, "checkpoint.json"));
    const rawManifest = await stableJson(path.join(archive, "evidence", `${candidate.manifestHash}.json`));
    if (checkpoint.value.phase !== "frozen" || checkpoint.value.preReleaseHead !== candidate.commit
        || checkpoint.value.manifestHash !== candidate.manifestHash || rawManifest.sha256 !== candidate.manifestHash) return false;
    await lease.assertOwned();
    ordinarySourceHistory();
    if (JSON.stringify(await readGeneration(id.operationId, id.generation)) !== JSON.stringify(proof)
        || (await stableJson(path.join(archive, "identity.json"))).sha256 !== identity.sha256
        || (await stableJson(path.join(archive, "checkpoint.json"))).sha256 !== checkpoint.sha256
        || (await stableJson(path.join(archive, "evidence", `${candidate.manifestHash}.json`))).sha256 !== rawManifest.sha256) throw new Error("Retired source original proof changed");
    ordinarySourceHistory();
    if (await lstat(path.join(generationRoot, "identity.json")).catch(missing)) throw new Error("Retired source generation custody changed");
    return true;
  }, { timeoutMs: 250 });
}

// Called under the SAME installation lease as runtime preparation/retirement.
// Only manifests and their declared source/object chains, no disk/audit scan.
export async function assertNativeCaptureNotSourcePinned(runtimeRoot, repository, { readGeneration } = {}) {
  const pointer = await readRuntimePointer(runtimeRoot);
  if (!pointer?.current) throw new Error("Current runtime source custody unavailable");
  const retired = new Set((pointer.runtimeRetention?.retired || []).map(r => r.releaseId));
  for (const entry of await readdir(path.join(runtimeRoot, "releases"), { withFileTypes: true })) {
    if (retired.has(entry.name) && ![pointer.current, pointer.previous].includes(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.includes(".staging-")) throw new Error("Runtime preparation is unresolved");
    const releaseRoot = path.join(runtimeRoot, "releases", entry.name);
    const { manifest, sha256 } = await readRuntimeManifest(releaseRoot);
    if (!Object.hasOwn(manifest, "sourceRoot")) {
      const installed = [pointer.runtimeRetention?.current, pointer.runtimeRetention?.previous].find(b => b?.releaseId === entry.name);
      const actual = await captureRuntimeReleaseBinding(releaseRoot, entry.name);
      if (actual.manifestSha256 !== sha256 || !sameRuntimeBinding(actual, installed)) throw new Error("Prepared source-free runtime custody unavailable");
      continue;
    }
    if (!path.isAbsolute(manifest.sourceRoot || "")) throw new Error("Runtime source pin is malformed");
    if (inside(repository, manifest.sourceRoot)) throw new Error("Native capture is a runtime/prepared source");
    const s = await lstat(manifest.sourceRoot).catch(missing);
    if (!s) continue;
    const source = await realpath(manifest.sourceRoot);
    if (inside(repository, source)) throw new Error("Native capture is a runtime/prepared source");
    for (const objects of await objectStores(source, () => retiredGenerationSource(runtimeRoot, source, manifest, readGeneration))) if (inside(repository, objects)) {
      throw new Error("Native capture supplies a retained source object store");
    }
  }
}
