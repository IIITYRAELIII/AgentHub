import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { agentHubReleaseSequence } from "./agent-hub-package.mjs";
import { artifactVersion, calendarVersion, manifestVersionIdentity, buildNumber, semanticVersion } from "../../domain/agent-hub-version.mjs";
import { captureRuntimeReleaseBinding, sameRuntimeBinding } from "./runtime-installation-custody.mjs";
import { runtimeRetirementCandidates } from "./runtime-release-retention-policy.mjs";
import { MaintenanceOperationStore } from "../persistence/maintenance-operation-store.mjs";
import { readArtifact } from "../process/publication-artifacts.mjs";
import { processIsAlive } from "../process/process-liveness.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
const samePath = (a, b) => process.platform === "win32"
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

async function plainPath(root, relative, directory = false) {
  let file = root;
  const parts = relative.split("/");
  const identities = [];
  for (const [index, part] of parts.entries()) {
    if (!part || [".", ".."].includes(part) || part.includes("\\")) throw new Error("Foreign allocation evidence path");
    file = path.join(file, part);
    const info = await lstat(file, { bigint: true });
    const isDirectory = index < parts.length - 1 || directory;
    if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())) {
      throw new Error("Allocation evidence link or type changed");
    }
    identities.push([String(info.dev), String(info.ino), String(info.birthtimeNs)]);
  }
  return { file, identities };
}

// Read-only compatibility for an ORIGINAL admitted partial retirement. The raw
// installed seal, original maintenance intent and original artifact owner join;
// a directory name, declared version or arbitrary archived copy is insufficient.
async function retiredAndroidContent(releasesDir, retained, metadata, readFileImpl) {
  const runtimeRoot = await realpath(path.dirname(releasesDir));
  if (!samePath(await realpath(releasesDir), path.join(runtimeRoot, "releases"))) return null;
  const pointerPath = await plainPath(runtimeRoot, "current.json");
  const pointerBytes = await readFile(pointerPath.file);
  const pointer = JSON.parse(pointerBytes);
  const lockFile = path.join(runtimeRoot, "data", "bot.lock");
  const lockPath = await plainPath(runtimeRoot, "data/bot.lock").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const lockBytes = await readFile(lockFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const lock = JSON.parse(lockBytes ?? "{}");
  if (lockBytes && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0)) throw new Error("Unknown allocation process custody");
  const running = lockBytes && processIsAlive(lock.pid) ? lock.releaseId : null;
  const record = runtimeRetirementCandidates({ pointer, runningReleaseId: running }).candidates
    .find(item => item.releaseId === retained.manifest.releaseId);
  if (!record || record.phase !== "pruning" || typeof record.operationId !== "string" || !record.operationId) return null;
  const body = (await plainPath(runtimeRoot, `releases/${record.releaseId}`, true)).file;
  const actual = await captureRuntimeReleaseBinding(body, record.releaseId);
  if (actual.manifestSha256 !== retained.manifestSha256 || !sameRuntimeBinding(actual, record)) {
    throw new Error("Retired allocation custody changed");
  }
  const databasePath = await plainPath(runtimeRoot, "data/runtime.sqlite");
  const store = new MaintenanceOperationStore({ dataDir: path.join(runtimeRoot, "data") });
  const original = store.getReadonly(record.operationId);
  const key = sha(JSON.stringify({ releaseId: record.releaseId, manifestSha256: record.manifestSha256, root: record.root }));
  if (!original || original.kind !== "storage-retention" || !["running", "reconciling"].includes(original.status)
      || original.metadata?.version !== 1 || original.metadata.owner !== "runtime-release" || original.metadata.admitted !== true
      || original.metadata.candidate?.id !== key || original.metadata.candidate.releaseId !== record.releaseId
      || original.metadata.scope !== `runtime-release:${sha(key)}` || !sameRuntimeBinding(original.metadata.binding, record)) {
    throw new Error("Original retired allocation intent is unavailable");
  }
  if (!/^publication-[a-f0-9]{32}$/u.test(record.releaseId)) throw new Error("Retired allocation has no original artifact identity");
  const relative = `publication-artifacts/${record.releaseId.slice("publication-".length)}`;
  const archive = await plainPath(runtimeRoot, relative, true);
  const runtimeManifestPath = await plainPath(runtimeRoot, `${relative}/runtime/artifact.json`);
  const runtimeBytes = await readFile(runtimeManifestPath.file);
  const artifact = JSON.parse(runtimeBytes), identity = artifact.identity, frozen = identity?.runtimePublication;
  if (Object.keys(identity ?? {}).sort().join(",") !== "protocol,revision,runtimePublication,runtimeRoot,sourceRoot"
      || identity.protocol !== 1 || identity.revision !== retained.manifest.publicationRevision
      || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(identity.revision ?? "")
      || typeof identity.sourceRoot !== "string" || !path.isAbsolute(identity.sourceRoot)
      || identity.sourceRoot !== retained.manifest.sourceRoot
      || typeof identity.runtimeRoot !== "string" || !path.isAbsolute(identity.runtimeRoot)
      || !samePath(await realpath(identity.runtimeRoot), runtimeRoot)
      || sha(JSON.stringify(identity)).slice(0, 32) !== record.releaseId.slice("publication-".length)
      || Object.keys(frozen ?? {}).sort().join(",") !== "generation,operationId,sourceCommit,version"
      || !uuid(frozen.operationId) || !Number.isSafeInteger(frozen.generation) || frozen.generation < 1
      || frozen.sourceCommit !== identity.revision || frozen.version !== retained.manifest.releaseVersion
      || JSON.stringify(artifact.result) !== JSON.stringify({ releaseId: record.releaseId, manifestHash: record.manifestSha256 })) {
    throw new Error("Foreign original allocation artifact");
  }
  const receiptPath = await plainPath(runtimeRoot, `${relative}/runtime/payload/prepared-runtime.json`);
  const runtimeArtifact = await readArtifact(path.join(archive.file, "runtime"), identity);
  const receiptBytes = await readFile(receiptPath.file);
  const receipt = JSON.parse(receiptBytes);
  if (JSON.stringify(runtimeArtifact) !== JSON.stringify(artifact)
      || Object.keys(receipt).sort().join(",") !== "generation,manifestSha256,operationId,phase,releaseId,releaseRoot,schema,sourceCommit,version"
      || receipt.schema !== 1 || receipt.phase !== "PREPARED" || receipt.operationId !== frozen.operationId
      || receipt.generation !== frozen.generation || receipt.sourceCommit !== identity.revision
      || receipt.releaseId !== record.releaseId || receipt.version !== frozen.version
      || receipt.manifestSha256 !== record.manifestSha256 || typeof receipt.releaseRoot !== "string"
      || !samePath(await realpath(receipt.releaseRoot), body)) throw new Error("Original runtime preparation receipt changed");
  const androidPath = await plainPath(runtimeRoot, `${relative}/android/artifact.json`);
  const androidBytes = await readFile(androidPath.file);
  const contentPath = await plainPath(runtimeRoot, `${relative}/android/payload/update.json`);
  const android = await readArtifact(path.join(archive.file, "android"), identity);
  const declared = android?.files?.filter(item => item.path === "update.json");
  if (JSON.stringify(android) !== JSON.stringify(JSON.parse(androidBytes))
      || declared?.length !== 1 || declared[0].sha256 !== metadata.sha256) throw new Error("Foreign original Android artifact");
  const raw = await readFileImpl(contentPath.file);
  if (raw.length !== metadata.bytes || sha(raw) !== metadata.sha256) throw new Error("Retired Android metadata integrity mismatch");
  const version = manifestVersionIdentity(retained.manifest), mobile = JSON.parse(raw);
  if (mobile.versionCode !== version.buildNumber || mobile.versionName !== version.publicVersion) {
    throw new Error("Original Android artifact version changed");
  }
  // The final fence follows the final artifact read. Never certify an earlier
  // pointer/root/original observation after retirement or publication advances.
  for (const [relativePath, before] of [["current.json", pointerPath], ["data/runtime.sqlite", databasePath],
    [`${relative}/runtime/artifact.json`, runtimeManifestPath], [`${relative}/runtime/payload/prepared-runtime.json`, receiptPath],
    [`${relative}/android/artifact.json`, androidPath], [`${relative}/android/payload/update.json`, contentPath]]) {
    if (JSON.stringify((await plainPath(runtimeRoot, relativePath)).identities) !== JSON.stringify(before.identities)) {
      throw new Error("Allocation evidence custody changed during verification");
    }
  }
  const finalLock = await readFile(lockFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (finalLock !== null && (!lockPath || JSON.stringify((await plainPath(runtimeRoot, "data/bot.lock")).identities)
      !== JSON.stringify(lockPath.identities))) throw new Error("Allocation process custody changed");
  if (!(await readFile(pointerPath.file)).equals(pointerBytes)
      || !(await readFile(runtimeManifestPath.file)).equals(runtimeBytes) || !(await readFile(receiptPath.file)).equals(receiptBytes)
      || !(await readFile(androidPath.file)).equals(androidBytes) || !(await readFile(contentPath.file)).equals(raw)
      || JSON.stringify(store.getReadonly(record.operationId)) !== JSON.stringify(original)
      || !sameRuntimeBinding(await captureRuntimeReleaseBinding(body, record.releaseId), actual)
      || (finalLock === null) !== (lockBytes === null) || (finalLock !== null && !finalLock.equals(lockBytes))) {
    throw new Error("Original allocation evidence changed during verification");
  }
  return raw;
}

function retainedBuildNumber(manifest) {
  // The pre-migration producer appended .N to any stable numeric package
  // version, including 2.0.0. Observe that suffix only for allocation;
  // it is not a new artifact identity or permission to install old metadata.
  const core = "(?:0|[1-9][0-9]*)";
  const legacy = typeof manifest.releaseVersion === "string"
    ? new RegExp(`^(${core}\\.${core}\\.${core})\\.([1-9][0-9]*)$`, "u").exec(manifest.releaseVersion) : null;
  if (legacy && !calendarVersion(legacy[1])) {
    if (manifest.version !== legacy[1]
        || ["versionScheme", "publicVersion", "buildNumber"].some(key => Object.hasOwn(manifest, key))) {
      throw new Error("Invalid retained pre-migration version metadata");
    }
    semanticVersion(legacy[1]);
    return buildNumber(agentHubReleaseSequence(manifest.version, manifest.releaseVersion));
  }
  return manifestVersionIdentity(manifest).buildNumber;
}

export async function nextRuntimeReleaseVersion({
  releasesDir,
  packageVersion,
  readDirectoryImpl = readdir,
  readFileImpl = readFile,
  // On a new freeze use the existing Android epoch-minute floor. An original
  // frozen N carries that floor on preparation/retry, never the current clock.
  allocationFloor = Math.floor(Date.now() / 60_000),
} = {}) {
  const entries = await readDirectoryImpl(releasesDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  let maximumSequence = 0;
  const mobileGroups = new Map();
  const semantic = !calendarVersion(packageVersion);
  if (semantic) {
    if (!Number.isSafeInteger(allocationFloor) || allocationFloor < 0) throw new Error("Invalid allocation floor");
    maximumSequence = allocationFloor;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.includes(".staging-")) {
      if (semantic) throw new Error("Partial runtime allocation requires original-owner reconciliation");
      continue;
    }
    const manifestFile = path.join(releasesDir, entry.name, "runtime-manifest.json");
    const manifestBytes = await readFileImpl(manifestFile)
      .catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
    const manifest = manifestBytes === null ? null : JSON.parse(manifestBytes);
    if (!manifest) {
      if (semantic) throw new Error("Unknown retained runtime allocation");
      continue;
    }
    if (semantic) {
      if (manifest.releaseId !== entry.name || !Array.isArray(manifest.files)) throw new Error("Foreign retained runtime allocation");
      maximumSequence = Math.max(maximumSequence, retainedBuildNumber(manifest));
      const mobileEntry = manifest.files.filter(item => item.path === "assets/mobile/update.json");
      if (mobileEntry.length > 1) throw new Error("Ambiguous retained Android metadata");
      if (mobileEntry.length) {
        const metadata = mobileEntry[0];
        const key = `${metadata.sha256}:${metadata.bytes}`;
        if (!mobileGroups.has(key)) mobileGroups.set(key, { metadata, files: [] });
        mobileGroups.get(key).files.push({ file: path.join(releasesDir, entry.name, "assets", "mobile", "update.json"),
          manifest, manifestSha256: sha(manifestBytes) });
      }
      continue;
    }
    if (manifest.version !== packageVersion) continue;
    const sequence = manifest.releaseVersion == null
      ? 1
      : agentHubReleaseSequence(packageVersion, manifest.releaseVersion);
    maximumSequence = Math.max(maximumSequence, sequence);
  }
  for (const { metadata, files } of mobileGroups.values()) {
    let verified = false, missing = null;
    for (const { file } of files) {
      const raw = await readFileImpl(file).catch(error => {
        if (error.code !== "ENOENT") throw error;
        missing ??= error;
        return null;
      });
      if (raw === null) continue;
      if (raw.length !== metadata.bytes || createHash("sha256").update(raw).digest("hex") !== metadata.sha256) {
        throw new Error("Retained Android metadata integrity mismatch");
      }
      maximumSequence = Math.max(maximumSequence, buildNumber(JSON.parse(raw).versionCode));
      verified = true;
    }
    // Allocation needs the exact declared metadata content once, not every
    // duplicate physical copy. Missing unique content still refuses. This is
    // not a certificate of completeness/installation for any retained body.
    if (!verified) {
      for (const retained of files) {
        const raw = await retiredAndroidContent(releasesDir, retained, metadata, readFileImpl);
        if (raw === null) continue;
        maximumSequence = Math.max(maximumSequence, buildNumber(JSON.parse(raw).versionCode));
        verified = true;
        break;
      }
      if (!verified) throw missing ?? new Error("Retained Android metadata is unavailable");
    }
  }
  return semantic ? artifactVersion(packageVersion, maximumSequence + 1) : `${packageVersion}.${maximumSequence + 1}`;
}
