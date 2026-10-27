import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash,
  normalizedReleaseBaseProvenance, assertHistoricalChangelogOriginal } from "../../domain/release-base-provenance.mjs";
import { runtimeRetirementCandidates } from "./runtime-release-retention-policy.mjs";
import { runtimeHostSourceHash } from "../process/runtime-host-builder.mjs";
import { ReleasePreparationRejectedError } from "../../domain/release-preparation.mjs";
import { readNativeUpstreamAdoptions, assertNativeUpstreamOrigin } from "./native-upstream-adoption.mjs";
import { publicationStateRepositories } from "../persistence/publication-state.mjs";
import { canonicalPath } from "./config.mjs";
import { taskGitIdentityHash } from "../../domain/task-git-reference.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reject = message => { throw new ReleasePreparationRejectedError(`Installed local source baseline: ${message}`); };
const normalized = bytes => Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/gu, "\n"));
const metadata = name => /^(?:docs|tests)\//u.test(name)
  || /(?:^|\/)[^/]+\.test\.(?:mjs|cjs|js)$/u.test(name) || /^(?:README|AGENTS)\.md$/u.test(name);
const hostInputs = new Set(["RuntimeHost/AgentHub.RuntimeHost.cs", "RuntimeHost/AgentHub.IconBuilder.cs",
  "RuntimeHost/app.manifest", "VSCodeExtension/media/agent-hub-mark.png"]);

// Existing OWN publication is authority for its exact immutable historical
// notes/version, independently of local installed-source carry. Callers seal
// and recheck this invocation-local identity; it never advances a base or ref.
export async function publishedMetadataContext({ publication, repositoryRoot, git }) {
  const entry = publicationStateRepositories(publication ?? {})
    .find(item => canonicalPath(item.root) === canonicalPath(repositoryRoot));
  if (!publication?.generation || !entry) return null;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.revision)
      || await git(["rev-parse", `${entry.revision}^{commit}`]) !== entry.revision) reject("published metadata identity changed");
  return { generation: publication.generation, repositoryRoot: canonicalPath(repositoryRoot),
    recordHash: taskGitIdentityHash(entry), commit: entry.revision,
    tree: await git(["rev-parse", `${entry.revision}^{tree}`]) };
}

async function regular(file) {
  const info = await lstat(file).catch(error => {
    if (error.code === "ENOENT") reject("required source or installed artifact is absent");
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink()) reject("source evidence must be a regular file");
  return readFile(file);
}

function sourceMatches(source, physical, relative) {
  const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/u
    .exec(normalized(source).toString("utf8"));
  if (pointer) return sha(physical) === pointer[1] && physical.length === Number(pointer[2]);
  if (!/\.(?:mjs|cjs|js|json|md|css|html|py|ps1|txt|manifest|cs|sh)$/iu.test(relative)
      || source.includes(0) || physical.includes(0)
      || !Buffer.from(source.toString("utf8")).equals(source)
      || !Buffer.from(physical.toString("utf8")).equals(physical)) return source.equals(physical);
  return normalized(source).equals(normalized(physical));
}

// One invocation-local object read, not a cache of mutable installation facts.
// OID framing handles arbitrary binary/newline bytes without interpreting paths
// as cat-file input. Check every returned object's identity/type/length/content.
export async function sourceBlobs(git, entries, paths) {
  const requested = new Map();
  for (const file of paths) {
    const entry = entries.get(file);
    if (!entry || entry.type !== "blob" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(entry.oid)) reject("Git source entry is absent or malformed");
    requested.set(entry.oid, null);
  }
  if (!requested.size) return new Map();
  const raw = Buffer.from(await git(["cat-file", "--batch"], {
    input: [...requested.keys()].join("\n") + "\n", rawOutput: true,
  }));
  let offset = 0;
  for (const oid of requested.keys()) {
    const end = raw.indexOf(10, offset);
    if (end < offset) reject("Git source batch is truncated");
    const header = /^([a-f0-9]+) blob (0|[1-9][0-9]*)$/u.exec(raw.subarray(offset, end).toString("utf8"));
    const size = header ? Number(header[2]) : NaN;
    if (!header || header[1] !== oid || !Number.isSafeInteger(size) || size > raw.length - end - 2) reject("Git source batch identity or size changed");
    const body = raw.subarray(end + 1, end + 1 + size);
    offset = end + size + 2;
    if (raw[offset - 1] !== 10 || createHash(oid.length === 40 ? "sha1" : "sha256")
      .update(`blob ${size}\0`).update(body).digest("hex") !== oid) reject("Git source batch bytes changed");
    requested.set(oid, body);
  }
  if (offset !== raw.length) reject("Git source batch has trailing data");
  return new Map(paths.map(file => [file, requested.get(entries.get(file).oid)]));
}

async function assertInheritedRepositoryFiles({ git, sourceCommit, agreedMainCommit }) {
  const outside = async commit => {
    const raw = Buffer.from(await git(["ls-tree", "-r", "-z", "--full-tree", commit], { rawOutput: true }));
    if (raw.length && raw.at(-1) !== 0) reject("repository inventory is malformed");
    const paths = new Set(), retained = [];
    let offset = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(0, offset);
      const record = raw.subarray(offset, end);
      const tab = record.indexOf(9);
      if (tab < 0 || !/^(?:100644 blob|100755 blob|120000 blob|160000 commit) (?:[a-f0-9]{40}|[a-f0-9]{64})$/u
        .test(record.subarray(0, tab).toString("utf8")) || tab + 1 === record.length) reject("repository inventory is malformed");
      const name = record.subarray(tab + 1);
      const key = name.toString("hex");
      if (paths.has(key)) reject("repository inventory has ambiguous paths");
      paths.add(key);
      if (!name.subarray(0, 9).equals(Buffer.from("AgentHub/"))) retained.push(record.toString("base64"));
      offset = end + 1;
    }
    return retained.sort();
  };
  const source = await outside(sourceCommit);
  const agreed = await outside(agreedMainCommit);
  if (JSON.stringify(source) !== JSON.stringify(agreed)) reject("repository files differ from agreed main");
}

// Read-only verifier inside the existing candidate owner. No base/ref, runtime
// overlay, adoption, receipt or additional recovery registry is written here.
export async function assertInstalledAgreedMainOrigin({ provenance, git }) {
  const p = normalizedReleaseBaseProvenance(provenance);
  if (p?.kind !== LOCAL_SOURCE_BASELINE_PROVENANCE || !Array.isArray(p.adoptions) || p.adoptions.length) {
    reject("missing exact agreed main origin authority");
  }
  if (await git(["rev-parse", "refs/heads/main^{commit}"]) !== p.agreedMainCommit
      || String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0]
        !== p.approvedOriginMainCommit) reject("agreed main origin changed");
}

export async function assertOwnGitPublicationOrigin({ provenance, git, readOwnGitPublication, repositoryRoot, tasks }) {
  const p = normalizedReleaseBaseProvenance(provenance), proof = p?.ownGitPublication;
  if (!proof || typeof readOwnGitPublication !== "function") reject("OWN Git publication owner is unavailable");
  const originCommit = String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0];
  const current = readOwnGitPublication({ repositoryRoot, localMainCommit: p.agreedMainCommit,
    publishedRevision: p.publishedBaseCommit, originCommit, taskIds: tasks.map(task => task.taskId) });
  if (JSON.stringify(current) !== JSON.stringify(proof) || originCommit !== proof.commit
      || await git(["rev-parse", "refs/heads/main^{commit}"]) !== p.agreedMainCommit
      || await git(["rev-parse", `${proof.commit}^{tree}`]) !== proof.tree) reject("OWN Git publication origin changed");
  await git(["merge-base", "--is-ancestor", p.agreedMainCommit, proof.commit]);
  await git(["merge-base", "--is-ancestor", p.sourceBaseCommit, proof.commit]);
}

export async function assertHistoricalChangelog({ provenance, originalAuthority, tasks, repositoryRoot, git, runtimeRoot }) {
  const p = normalizedReleaseBaseProvenance(provenance), binding = p?.historicalChangelog;
  if (!binding) return [];
  assertHistoricalChangelogOriginal(p, originalAuthority, tasks, repositoryRoot);
  const pointer = JSON.parse(await regular(path.join(runtimeRoot, "current.json")));
  if (runtimeRetirementCandidates({ pointer, runningReleaseId: pointer.current }).reason !== null) reject("historical runtime retention is unproved");
  const retained = [pointer.runtimeRetention.current, pointer.runtimeRetention.previous, ...pointer.runtimeRetention.retired].filter(Boolean);
  if (retained.filter(r => r.releaseId === p.installedReleaseId && r.manifestSha256 === p.installedManifestSha256).length !== 1
      || retained.filter(r => r.releaseId === binding.installedReleaseId && r.manifestSha256 === binding.installedManifestSha256).length !== 1
      || binding.installedReleaseId === pointer.current) reject("historical installed manifest is not an exact retained binding");
  const bytes = await regular(path.join(runtimeRoot, "releases", binding.installedReleaseId, "runtime-manifest.json"));
  if (sha(bytes) !== binding.installedManifestSha256) reject("historical installed manifest changed");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.releaseId !== binding.installedReleaseId || typeof manifest.publicationRevision !== "string"
      || manifest.publicationRevision !== binding.sourceCommit || typeof manifest.sourceRoot !== "string"
      || !path.isAbsolute(manifest.sourceRoot)) reject("historical source manifest identity changed");
  const readGit = (args, options) => git(["--no-optional-locks", "--no-lazy-fetch", "--no-replace-objects",
    "-c", "core.fsmonitor=false", ...args], options);
  const root = await lstat(manifest.sourceRoot);
  if (!root.isDirectory() || root.isSymbolicLink()
      || await readGit(["-C", manifest.sourceRoot, "rev-parse", "HEAD^{commit}"]) !== binding.sourceCommit
      || await readGit(["-C", manifest.sourceRoot, "rev-parse", "HEAD^{tree}"]) !== binding.sourceTree
      || await readGit(["-C", manifest.sourceRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"])) reject("historical source HEAD/tree/clean custody changed");
  await readGit(["merge-base", "--is-ancestor", binding.sourceCommit, p.sourceBaseCommit]);
  const expected = `${binding.mode} blob ${binding.blob}\t${binding.path}\0`;
  for (const commit of [binding.sourceCommit, binding.resultCommit]) {
    if (String(await readGit(["--literal-pathspecs", "ls-tree", "--full-tree", "-z", commit, "--", binding.path], { rawOutput: true })) !== expected) {
      reject("historical root CHANGELOG path/mode/blob changed");
    }
  }
  return [{ taskId: binding.taskId, resultCommit: binding.resultCommit, path: binding.path, mode: binding.mode, blob: binding.blob }];
}

export async function assertInstalledLocalSourceBaseline({
  provenance, git, primaryMainCommit, publishedRevision, planRevision, tasks, runtimeRoot,
  adoptionGit = git, repositoryRoot = null,
  originalAuthority = null,
  readOwnGitPublication = null,
}) {
  const p = normalizedReleaseBaseProvenance(provenance);
  if (p?.kind !== LOCAL_SOURCE_BASELINE_PROVENANCE) reject("missing provenance");
  if (p.agreedMainCommit !== primaryMainCommit || p.publishedBaseCommit !== publishedRevision
      || p.planRevision !== planRevision || p.selectionHash !== localSourceSelectionHash(tasks)) reject("base, plan or selection changed");
  let adoptions = [];
  if (p.adoptions) {
    if (!repositoryRoot) reject("adoption repository is absent");
    adoptions = await readNativeUpstreamAdoptions({ git: adoptionGit, tasks, repositoryRoot,
      localMainCommit: primaryMainCommit });
    const pins = adoptions.map(({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }) =>
      ({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }));
    if (JSON.stringify(pins) !== JSON.stringify(p.adoptions)) reject("selected adoption receipts changed");
  } else if (String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] !== publishedRevision) reject("origin differs from the pinned OWN publication");
  const validateOrigin = async () => {
    if (p.ownGitPublication) return assertOwnGitPublicationOrigin({ provenance: p, git: adoptionGit,
      readOwnGitPublication, repositoryRoot, tasks });
    if (!p.adoptions) return;
    await adoptionGit(["merge-base", "--is-ancestor", publishedRevision, p.approvedOriginMainCommit]);
    if (adoptions.length) {
      await assertNativeUpstreamOrigin({ git: adoptionGit, adoptions, originCommit: p.approvedOriginMainCommit });
    } else {
      // No new incoming is adopted when origin is the exact already agreed main.
      // Seal that identity; an existing envelope cannot switch back to published.
      await git(["merge-base", "--is-ancestor", p.agreedMainCommit, p.sourceBaseCommit]);
      await assertInstalledAgreedMainOrigin({ provenance: p, git: adoptionGit });
    }
  };
  await validateOrigin();
  await git(["merge-base", "--is-ancestor", publishedRevision, p.sourceBaseCommit]);
  if (String(await git(["rev-parse", `${p.sourceBaseCommit}^{tree}`])) !== p.sourceBaseTree) reject("source tree changed");
  const patch = await git(["diff", "--binary", "--full-index", "--no-renames", publishedRevision, p.sourceBaseCommit], { rawOutput: true });
  if (sha(patch) !== p.sourcePatchSha256) reject("source patch changed");
  const current = JSON.parse(await regular(path.join(runtimeRoot, "current.json")));
  if (current.current !== p.installedReleaseId) reject("installed release changed");
  const releaseRoot = path.join(runtimeRoot, "releases", p.installedReleaseId);
  const manifestBytes = await regular(path.join(releaseRoot, "runtime-manifest.json"));
  if (sha(manifestBytes) !== p.installedManifestSha256) reject("installed manifest changed");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.releaseId !== p.installedReleaseId || !Array.isArray(manifest.files)
      || manifest.files.some(file => typeof file.path !== "string"
        || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) reject("installed identity changed");
  const files = new Map(manifest.files.map(file => [file.path, file]));
  if (files.size !== manifest.files.length) reject("duplicate runtime paths");
  const changed = String(await git(["diff", "--name-only", "--no-renames", "-z", publishedRevision, p.sourceBaseCommit]))
    .split("\0").filter(Boolean);
  const entries = String(await git(["ls-tree", "-r", "-z", p.sourceBaseCommit, "--", "AgentHub"]))
    .split("\0").filter(Boolean);
  const modes = new Map(entries.map(entry => {
    const split = entry.indexOf("\t");
    return [entry.slice(split + 1), entry.slice(0, 6)];
  }));
  const objects = new Map(entries.map(entry => {
    const split = entry.indexOf("\t"), [mode, type, oid] = entry.slice(0, split).split(" ");
    return [entry.slice(split + 1), { mode, type, oid }];
  }));
  const runtimePaths = changed.filter(file => file.startsWith("AgentHub/") && !metadata(file.slice(9))
    && !file.slice(9).startsWith("RuntimeHost/") && !hostInputs.has(file.slice(9)));
  for (const file of runtimePaths) {
    if (modes.get(file) !== "100644") reject("carry requires regular non-executable Git source entries");
  }
  const needsHost = changed.some(file => file.startsWith("AgentHub/") && hostInputs.has(file.slice(9)));
  const sources = await sourceBlobs(git, objects, [...new Set([...runtimePaths,
    ...(needsHost ? [...hostInputs].map(relative => `AgentHub/${relative}`) : [])])]);
  let runtimeFiles = 0;
  let hostChanged = false;
  let repositoryFilesVerified = false;
  for (const file of changed) {
    if (!file.startsWith("AgentHub/")) {
      if (!repositoryFilesVerified) {
        await assertInheritedRepositoryFiles({ git, sourceCommit: p.sourceBaseCommit,
          agreedMainCommit: primaryMainCommit });
        repositoryFilesVerified = true;
      }
      continue;
    }
    const relative = file.slice("AgentHub/".length);
    if (relative.startsWith("RuntimeHost/") && !hostInputs.has(relative)) reject(`unsupported Host source: ${relative}`);
    if (metadata(relative)) continue;
    if (modes.get(file) !== "100644") reject("carry requires regular non-executable Git source entries");
    if (hostInputs.has(relative)) { hostChanged = true; continue; }
    const installed = files.get(relative);
    // Non-runtime executable/source changes cannot hide in a carry envelope.
    if (!installed) reject(`carry path is absent from the installed runtime: ${relative}`);
    const physical = await regular(path.join(releaseRoot, relative));
    if (sha(physical) !== installed.sha256 || physical.length !== installed.bytes) reject(`installed bytes changed: ${relative}`);
    const source = sources.get(file);
    if (!sourceMatches(source, physical, relative)) reject(`source differs from installed bytes: ${relative}`);
    runtimeFiles += 1;
  }
  if (hostChanged) {
    const expected = files.get("AgentHub.RuntimeHost.source.sha256");
    const artifact = files.get("AgentHub.RuntimeHost.exe");
    if (!expected || !artifact || !manifest.sourceRoot) reject("compiled Host provenance or artifact manifest is absent");
    const binary = await regular(path.join(releaseRoot, artifact.path));
    if (sha(binary) !== artifact.sha256 || binary.length !== artifact.bytes) reject("compiled Host installed bytes changed");
    const bytes = await regular(path.join(releaseRoot, expected.path));
    if (sha(bytes) !== expected.sha256 || bytes.length !== expected.bytes
        || (await runtimeHostSourceHash(manifest.sourceRoot)) !== bytes.toString("utf8").trim()) reject("compiled Host source changed");
    for (const relative of hostInputs) {
      const source = sources.get(`AgentHub/${relative}`);
      if (!sourceMatches(source, await regular(path.join(manifest.sourceRoot, relative)), relative)) reject("Host Git source differs from compiled inputs");
    }
  }
  const metadataBases = [p.sourceBaseCommit, ...(p.ownGitPublication ? [p.ownGitPublication.commit] : [])];
  // Keep the exact installed source's inherited metadata when an explicitly
  // verified source base has incorporated a later agreed main. This identity
  // comes from the hash-pinned installed manifest, never from Task arguments.
  if (typeof manifest.publicationRevision === "string" && /^[a-f0-9]{40}$/u.test(manifest.publicationRevision)
      && typeof manifest.sourceRoot === "string" && path.isAbsolute(manifest.sourceRoot)) {
    const installedSource = manifest.publicationRevision;
    if (await git(["-C", manifest.sourceRoot, "rev-parse", "HEAD^{commit}"]) !== installedSource
        || await git(["-C", manifest.sourceRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all"])) {
      reject("retained installed source identity changed");
    }
    await git(["merge-base", "--is-ancestor", installedSource, p.sourceBaseCommit]);
    if (installedSource !== p.sourceBaseCommit) metadataBases.push(installedSource);
  }
  await validateOrigin();
  const changelogEntries = await assertHistoricalChangelog({ provenance: p, originalAuthority, tasks, repositoryRoot, git, runtimeRoot });
  return { provenance: p, runtimeFiles, hostChanged, metadataBases, ...(changelogEntries.length ? { changelogEntries } : {}), ...(p.adoptions ? { adoptions } : {}) };
}

// Test uses the same installed-byte proof as preparation. Only the manifest's
// retained source checkout supplies a candidate commit; it is not trusted until
// the complete ordinary baseline verifier above accepts it.
export async function installedNativeHistoryBaseline({ git, sourceGit, repositoryRoot,
  primaryMainCommit, publishedRevision, tasks, runtimeRoot, planRevision, adoptions = [], readOwnGitPublication = null }) {
  const currentFile = path.join(runtimeRoot, "current.json");
  if (!await lstat(currentFile).catch(error => { if (error.code === "ENOENT") return null; throw error; })) return null;
  const currentBytes = await regular(currentFile);
  const current = JSON.parse(currentBytes);
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(current.current) || current.current.includes("..")) reject("installed identity changed");
  const bytes = await regular(path.join(runtimeRoot, "releases", current.current, "runtime-manifest.json"));
  const manifest = JSON.parse(bytes);
  if (manifest.releaseId !== current.current) reject("installed identity changed");
  // A normal published runtime already names the caller's durable publication.
  // Its generation checkout is disposable: it supplies no additional installed
  // local-source authority. Return the same no-carry result as an exact retained
  // published HEAD, using the immutable object in the registered repository.
  // Legacy/local repairs still require the complete retained-checkout proof below.
  if (manifest.publicationRevision === publishedRevision) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(publishedRevision)
        || await git(["rev-parse", `${publishedRevision}^{commit}`]) !== publishedRevision) reject("published source identity changed");
    if (!currentBytes.equals(await regular(currentFile))) reject("installed release changed");
    if (!bytes.equals(await regular(path.join(runtimeRoot, "releases", current.current, "runtime-manifest.json")))) reject("installed manifest changed");
    return null;
  }
  if (typeof manifest.sourceRoot !== "string" || !path.isAbsolute(manifest.sourceRoot)) reject("retained source root is absent");
  const sourceBaseCommit = await sourceGit(manifest.sourceRoot, ["rev-parse", "HEAD^{commit}"]);
  const sourceBaseTree = await sourceGit(manifest.sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  if (await sourceGit(manifest.sourceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) reject("retained source checkout changed");
  if (sourceBaseCommit === publishedRevision) return null;
  const agreedOrigin = !adoptions.length && primaryMainCommit !== publishedRevision
    && String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] === primaryMainCommit;
  const ownGitPublication = !adoptions.length && !agreedOrigin && readOwnGitPublication
    ? readOwnGitPublication({ repositoryRoot, localMainCommit: primaryMainCommit, publishedRevision,
      originCommit: String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0],
      taskIds: tasks.map(task => task.taskId) }) : null;
  const p = { schemaVersion: 1, kind: LOCAL_SOURCE_BASELINE_PROVENANCE, publishedBaseCommit: publishedRevision,
    agreedMainCommit: primaryMainCommit, sourceBaseCommit, sourceBaseTree,
    sourcePatchSha256: sha(await git(["diff", "--binary", "--full-index", "--no-renames", publishedRevision, sourceBaseCommit], { rawOutput: true })),
    installedReleaseId: current.current, installedManifestSha256: sha(bytes), planRevision,
    selectionHash: localSourceSelectionHash(tasks), ...(adoptions.length ? {
      approvedOriginMainCommit: adoptions[0].adoptedCommit,
      adoptions: adoptions.map(({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }) =>
        ({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit })),
    } : ownGitPublication ? { approvedOriginMainCommit: ownGitPublication.commit, adoptions: [], ownGitPublication }
      : agreedOrigin ? { approvedOriginMainCommit: primaryMainCommit, adoptions: [] } : {}) };
  return (await assertInstalledLocalSourceBaseline({ provenance: p, git, repositoryRoot, primaryMainCommit,
    publishedRevision, planRevision, tasks, runtimeRoot, readOwnGitPublication })).provenance;
}
