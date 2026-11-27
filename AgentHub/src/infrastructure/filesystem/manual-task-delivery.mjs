import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { runtimeLayout, runtimeReleaseDirectory } from "./runtime-layout.mjs";
import { observeRuntimeContent } from "./runtime-installation-custody.mjs";
import { verifyInstalledRuntime, runtimeStatus, stableRuntimeFiles } from "../../runtime/runtime-manager.mjs";
import { isRuntimeSourceFile, releasePath } from "./runtime-manifest-verifier.mjs";
import { sourceBlobs, sourceMatches } from "./local-source-baseline.mjs";
import { RUNTIME_HOST_SOURCE_INPUTS, runtimeHostSourceHash } from "../process/runtime-host-source-identity.mjs";
import { callDesktopControl, readDesktopControlEndpoint } from "../process/desktop-control.mjs";
import { taskRepositoryKey } from "../../domain/task-git-reference.mjs";
import { parseGitHubRemote } from "../persistence/github-publication-baseline.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");

// Discover the existing clone marker, never a caller-supplied replacement root.
// The primary remains the registered Task/dev repository and is read-only here.
export async function readManualPublishedRepository({ dataDir, repositoryRoot, revision, gitAt, verifyOrigin = true }) {
  const primaryRoot = path.resolve(repositoryRoot);
  const managedRoot = path.join(dataDir, "release-repositories");
  const root = path.join(managedRoot, taskRepositoryKey(primaryRoot), "repository");
  const exists = await lstat(root).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (!exists) return { root: primaryRoot };
  const same = (a, b) => typeof a === "string" && typeof b === "string"
    && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const physical = async file => {
    const entry = await lstat(file, { bigint: true });
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw Error("Manual published repository directory changed");
    return `${await realpath(file)}:${entry.dev}:${entry.ino}`;
  };
  const directory = await physical(root), commonDirectory = await physical(path.join(root, ".git"));
  const common = path.resolve(primaryRoot, await gitAt(primaryRoot, ["rev-parse", "--git-common-dir"]));
  const releaseCommon = path.resolve(root, await gitAt(root, ["rev-parse", "--git-common-dir"]));
  const markerRaw = await readFile(path.join(releaseCommon, "agent-hub-release-clone.json"));
  const marker = JSON.parse(markerRaw);
  if (marker.schemaVersion !== 1 || marker.kind !== "agent-hub-owned-release-clone"
      || !same(marker.managedRoot, managedRoot) || !same(marker.primaryRoot, primaryRoot)
      || !same(marker.primaryGitCommonDir, common) || !same(marker.releaseRoot, root)
      || !same(marker.releaseGitCommonDir, releaseCommon) || !same(releaseCommon, path.join(root, ".git"))
      || same(common, releaseCommon) || !same(await gitAt(root, ["rev-parse", "--show-toplevel"]), root)) {
    throw Error("Manual published repository is not bound to the registered primary");
  }
  const remote = async cwd => {
    const value = await gitAt(cwd, ["remote", "get-url", "origin"]);
    const github = parseGitHubRemote(value);
    return { value, identity: github ? JSON.stringify(github) : value };
  };
  const [primaryRemote, publishedRemote] = await Promise.all([remote(primaryRoot), remote(root)]);
  if (primaryRemote.identity !== publishedRemote.identity) throw Error("Manual published origin differs from registered origin");
  const [head, branch, main, origin, actualRemote, dirty, primaryMain] = await Promise.all([
    gitAt(root, ["rev-parse", "HEAD^{commit}"]), gitAt(root, ["symbolic-ref", "HEAD"]),
    gitAt(root, ["rev-parse", "refs/heads/main^{commit}"]),
    gitAt(root, ["rev-parse", "refs/remotes/origin/main^{commit}"]),
    verifyOrigin ? gitAt(root, ["ls-remote", "--exit-code", "origin", "refs/heads/main"]) : null,
    gitAt(root, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
    gitAt(primaryRoot, ["rev-parse", "refs/heads/main^{commit}"]),
  ]);
  if (head !== revision || main !== revision || origin !== revision || branch !== "refs/heads/main" || dirty
      || verifyOrigin && actualRemote !== `${revision}\trefs/heads/main`) throw Error("Manual published main/origin/current remote differs");
  if (directory !== await physical(root) || commonDirectory !== await physical(releaseCommon)) {
    throw Error("Manual published repository directory changed during verification");
  }
  return { root, primaryRoot, primaryMain, primaryDirectory: await physical(primaryRoot),
    primaryCommonDirectory: await physical(common), directory,
    commonDirectory, markerSha256: sha(markerRaw),
    originIdentitySha256: sha(publishedRemote.identity), revision };
}

// This reads actual installation and Git state. It never writes publication history.
export async function readManualTaskDelivery({ runtimeRoot, input, git, resultCommits = [],
  hostSourceRoot = null,
  verifyInstalled = verifyInstalledRuntime, status = runtimeStatus,
  readEndpoint = readDesktopControlEndpoint, probe = callDesktopControl, onVerified = null } = {}) {
  if (!runtimeRoot || !input || Object.keys(input).some(k => !["revision", "releaseId", "manifestSha256"].includes(k))
      || !/^[a-f0-9]{40}$/u.test(input.revision ?? "") || !/^[a-f0-9]{64}$/u.test(input.manifestSha256 ?? "")) {
    throw Error("Exact manual delivery revision, release and manifest hash are required");
  }
  const releaseRoot = runtimeReleaseDirectory(runtimeRoot, input.releaseId);
  const manifestPath = path.join(releaseRoot, "runtime-manifest.json");
  const pointerPath = runtimeLayout(runtimeRoot).currentFile;
  const [manifestRaw, pointerRaw] = await Promise.all([readFile(manifestPath), readFile(pointerPath)]);
  const manifest = JSON.parse(manifestRaw), pointer = JSON.parse(pointerRaw);
  if (sha(manifestRaw) !== input.manifestSha256 || manifest.releaseId !== input.releaseId
      || manifest.publicationRevision !== input.revision || pointer.current !== input.releaseId
      || manifest.distributionSource?.commit && manifest.distributionSource.commit !== input.revision) {
    throw Error("Manual delivery manifest, source or installed pointer differs");
  }
  const inspect = async () => {
    const endpoint = await readEndpoint(runtimeRoot);
    const [main, origin, observed] = await Promise.all([
      git(["rev-parse", "--verify", "refs/heads/main^{commit}"]),
      git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]),
      status({ runtimeRoot, requireProcessEvidence: true }),
    ]);
    if (main !== input.revision || origin !== input.revision || !observed.running || !observed.ready
        || observed.current !== input.releaseId || observed.runningRelease !== input.releaseId || observed.restartRequired) {
      throw Error("Manual delivery requires exact main/origin and the same ready installed runtime");
    }
    const health = await probe("runtime-health", {}, { runtimeRoot, timeoutMs: 10_000 });
    const confirmedEndpoint = await readEndpoint(runtimeRoot);
    if (health?.live !== true || health?.ready !== true || health?.process?.pid !== observed.pid
        || health?.process?.releaseId !== input.releaseId
        || JSON.stringify(confirmedEndpoint) !== JSON.stringify(endpoint)) {
      throw Error("Manual delivery requires the same authenticated ready runtime control endpoint");
    }
    return { pid: observed.pid, releaseId: observed.runningRelease, endpoint,
      instanceId: health.process.instanceId ?? null };
  };
  const running = await inspect();
  const observedFiles = onVerified && Array.isArray(manifest.files) ? await observeRuntimeContent([
    manifestPath, pointerPath,
    ...manifest.files.map(file => releasePath(releaseRoot, file.path)),
    ...stableRuntimeFiles(runtimeLayout(runtimeRoot), releaseRoot).flatMap(file => [file.source, file.target]),
    ...(hostSourceRoot ? RUNTIME_HOST_SOURCE_INPUTS.map(file => path.join(hostSourceRoot, file)) : []),
  ], releaseRoot) : null;
  if (!await verifyInstalled({ runtimeRoot, releaseId: input.releaseId, releaseRoot })) {
    throw Error("Manual delivery installed runtime verification failed");
  }
  const entries = new Map(String(await git(["ls-tree", "-r", "-z", input.revision, "--", "AgentHub"]))
    .split("\0").filter(Boolean).map(row => {
      const [meta, file] = row.split("\t"), [mode, type, oid] = meta.split(" ");
      return [file, { mode, type, oid }];
    }).filter(([file]) => isRuntimeSourceFile(file.slice(9))));
  const files = new Map((manifest.files ?? []).map(file => [file.path, file]));
  if (!Array.isArray(manifest.files) || files.size !== manifest.files.length) throw Error("Manual runtime manifest paths differ");
  const bodies = await sourceBlobs(git, entries, [...entries.keys()]);
  for (const [file, body] of bodies) {
    if (RUNTIME_HOST_SOURCE_INPUTS.includes(file.slice(9))) continue;
    const declared = files.get(file.slice(9));
    const physical = declared ? await readFile(path.join(releaseRoot, declared.path)) : null;
    if (!physical || declared.bytes !== physical.length || declared.sha256 !== sha(physical)
        || !sourceMatches(body, physical, file.slice(9))) {
      throw Error(`Manual runtime source differs from delivered Git: ${file}`);
    }
  }
  if (files.has("AgentHub.RuntimeHost.source.sha256") || RUNTIME_HOST_SOURCE_INPUTS.some(p => bodies.has(`AgentHub/${p}`))) {
    const hostInputs = new Map();
    for (const file of RUNTIME_HOST_SOURCE_INPUTS) {
      const source = bodies.get(`AgentHub/${file}`);
      if (!source) throw Error("Manual delivery compiled Host Git inputs are missing");
      const compiledInput = hostSourceRoot ? await readFile(path.join(hostSourceRoot, file)) : source;
      if (!sourceMatches(source, compiledInput, file)) throw Error("Manual delivery Host Git source differs from compiled inputs");
      hostInputs.set(file, compiledInput);
    }
    const hash = await runtimeHostSourceHash("", { readSource: file => {
      const body = hostInputs.get(file.replaceAll("\\", "/"));
      if (!body) throw Error("Manual delivery compiled Host Git inputs are missing");
      return body;
    } });
    const declared = files.get("AgentHub.RuntimeHost.source.sha256");
    const body = declared && await readFile(path.join(releaseRoot, declared.path));
    if (!body || sha(body) !== declared.sha256 || body.toString("utf8").trim() !== hash) {
      throw Error("Manual delivery compiled Host source differs from Git");
    }
  }
  for (const result of resultCommits) {
    if (!/^[a-f0-9]{40}$/u.test(result ?? "")) throw Error("Exact Task result is required");
    await git(["merge-base", "--is-ancestor", result, input.revision]);
  }
  const assertCurrent = async () => {
    if (!(await readFile(manifestPath)).equals(manifestRaw) || !(await readFile(pointerPath)).equals(pointerRaw)
        || JSON.stringify(await inspect()) !== JSON.stringify(running)) throw Error("Manual delivery changed during verification");
    await observedFiles?.();
  };
  await assertCurrent();
  onVerified?.(assertCurrent);
  return { kind: "verified-manual-task-delivery-v1", runtimeRoot: path.resolve(runtimeRoot),
    ...input, pointerSha256: sha(pointerRaw), running, resultCommits: [...resultCommits] };
}
