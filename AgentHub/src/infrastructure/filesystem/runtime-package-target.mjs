import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { verifyRuntimeManifest } from "./runtime-manifest-verifier.mjs";
import { waitForRuntimeReplacement } from "../../runtime/publication-readiness.mjs";

const REPOSITORY = "IIITYRAELIII/AgentHub";
const SHA = /^[a-f0-9]{64}$/u;
export const packageDigest = (value) => createHash("sha256").update(value).digest("hex");
export const packageBindingDigest = (value) => packageDigest(JSON.stringify(value));

export async function packageFile(file) {
  const absolute = path.resolve(file);
  const info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Package input must be a regular file");
  const resolved = await realpath(absolute);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolved)) hash.update(chunk);
  const after = await lstat(absolute);
  if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size
    || after.mtimeMs !== info.mtimeMs || await realpath(absolute) !== resolved) {
    throw new Error("Package input changed while reading");
  }
  return { file: resolved, bytes: info.size, sha256: hash.digest("hex") };
}

export async function packageDirectory(directory) {
  const physical = await realpath(directory), info = await lstat(physical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Package directory ownership is unavailable");
  return { directory: physical, dev: String(info.dev), ino: String(info.ino), birthtimeMs: info.birthtimeMs };
}

async function metadataFor(tag) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/tags/${tag}`, {
    redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/vnd.github+json", "User-Agent": "AgentHub-Package-Handoff",
      "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) throw new Error("Published package metadata is unavailable");
  const raw = await response.text();
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Release metadata exceeds budget");
  return JSON.parse(raw);
}

// Local files are evidence only after joining the canonical publisher's exact
// versioned inventory. Caller-supplied hashes alone cannot authorize execution.
export async function verifyPublicPackageTarget(input, { readMetadata = metadataFor } = {}) {
  const tag = String(input?.tag ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(tag) || tag === "latest") {
    throw new Error("Package handoff requires an exact published tag");
  }
  const metadata = await readMetadata(tag);
  if (metadata.tag_name !== tag || metadata.draft !== false || metadata.prerelease !== false
    || !metadata.published_at || !Array.isArray(metadata.assets) || metadata.assets.length > 100) {
    throw new Error("Package handoff requires a published stable release");
  }
  const target = { schema: 1, repository: REPOSITORY, tag };
  for (const [key, name] of [["archive", "AgentHub-win32-x64.zip"],
    ["descriptor", "AgentHub-win32-x64.zip.json"], ["installer", "install_release.py"]]) {
    const matches = metadata.assets.filter((asset) => asset.name === name);
    const asset = matches[0];
    if (matches.length !== 1 || asset.state !== "uploaded"
      || asset.browser_download_url !== `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`
      || !/^sha256:[a-f0-9]{64}$/u.test(asset.digest ?? "")) {
      throw new Error("Published package asset identity is missing or ambiguous");
    }
    const file = await packageFile(input[key]);
    if (file.bytes !== asset.size || `sha256:${file.sha256}` !== asset.digest) {
      throw new Error("Local package differs from the published asset");
    }
    target[key] = { ...file, url: asset.browser_download_url };
  }
  const descriptor = JSON.parse(await readFile(target.descriptor.file, "utf8"));
  if (descriptor.schema !== 1 || descriptor.repository !== REPOSITORY || descriptor.platform !== "win32-x64"
    || descriptor.asset !== "AgentHub-win32-x64.zip" || descriptor.bytes !== target.archive.bytes
    || descriptor.sha256 !== target.archive.sha256 || !SHA.test(descriptor.packageManifestSha256 ?? "")
    || !/^[a-f0-9]{40}$/u.test(descriptor.sourceCommit ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(descriptor.releaseId ?? "")
    || descriptor.publicVersion !== tag || descriptor.versionScheme !== "semver-build-v1"
    || descriptor.version !== `${tag}+build.${descriptor.buildNumber}`
    || !Number.isSafeInteger(descriptor.buildNumber) || descriptor.buildNumber < 1) {
    throw new Error("Published descriptor does not bind the exact package");
  }
  Object.assign(target, { releaseId: descriptor.releaseId, sourceCommit: descriptor.sourceCommit,
    version: descriptor.version, packageManifestSha256: descriptor.packageManifestSha256 });
  return target;
}

export async function assertPackageFiles(target) {
  for (const key of ["archive", "descriptor", "installer", ...(target.runtimeManifest ? ["runtimeManifest"] : [])]) {
    const actual = await packageFile(target[key].file);
    if (actual.sha256 !== target[key].sha256 || actual.bytes !== target[key].bytes) {
      throw new Error("Admitted public package bytes changed");
    }
  }
}

export async function capturePackageRuntime(runtimeRoot, dataDir, { pid = process.pid,
  hostPid = Number(process.env.AGENT_HUB_HOST_PID) } = {}) {
  const root = await realpath(runtimeRoot);
  const data = await realpath(dataDir);
  if (data !== await realpath(path.join(root, "data"))) {
    throw new Error("Package handoff requires the existing runtime data owner at runtime-root/data");
  }
  const currentRaw = await readFile(path.join(root, "current.json"));
  const pointer = JSON.parse(currentRaw);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pointer.current ?? "")) {
    throw new Error("Package handoff has no exact current release");
  }
  const releaseRoot = path.join(root, "releases", pointer.current);
  await verifyRuntimeManifest(releaseRoot, pointer.current);
  const manifest = await readFile(path.join(releaseRoot, "runtime-manifest.json"));
  const lockRaw = await readFile(path.join(data, "bot.lock"));
  const lock = JSON.parse(lockRaw);
  if (lock.pid !== pid || lock.releaseId !== pointer.current || lock.ready !== true
    || typeof lock.instanceToken !== "string" || !lock.instanceToken
    || !Number.isSafeInteger(hostPid) || hostPid <= 0) {
    throw new Error("Package handoff requires the exact ready installed Host cohort");
  }
  const launcher = await packageFile(path.join(root, "AgentHub.RuntimeHost.exe"));
  const declared = JSON.parse(manifest).files.find((entry) => entry.path === "AgentHub.RuntimeHost.exe");
  if (!declared || declared.sha256 !== launcher.sha256 || declared.bytes !== launcher.bytes) {
    throw new Error("Stable Host differs from the current runtime manifest");
  }
  await waitForRuntimeReplacement({ runtimeRoot: root, expectedReleaseId: pointer.current, timeoutMs: 10000 });
  if (!currentRaw.equals(await readFile(path.join(root, "current.json")))
    || !manifest.equals(await readFile(path.join(releaseRoot, "runtime-manifest.json")))
    || !lockRaw.equals(await readFile(path.join(data, "bot.lock")))) throw new Error("Old ready runtime drifted during admission");
  return { runtimeRoot: root, dataDir: data,
    roots: { runtime: await packageDirectory(root), data: await packageDirectory(data) },
    old: { releaseId: pointer.current,
    currentSha256: packageDigest(currentRaw), manifestSha256: packageDigest(manifest),
    pid, hostPid, instanceSha256: packageDigest(lock.instanceToken), launcher } };
}
