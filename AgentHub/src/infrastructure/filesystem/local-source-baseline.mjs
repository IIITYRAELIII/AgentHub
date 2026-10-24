import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash,
  normalizedReleaseBaseProvenance } from "../../domain/release-base-provenance.mjs";
import { runtimeHostSourceHash } from "../process/runtime-host-builder.mjs";
import { ReleasePreparationRejectedError } from "../../domain/release-preparation.mjs";
import { readNativeUpstreamAdoptions, assertNativeUpstreamOrigin } from "./native-upstream-adoption.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reject = message => { throw new ReleasePreparationRejectedError(`Installed local source baseline: ${message}`); };
const normalized = bytes => Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/gu, "\n"));
const metadata = name => /^(?:docs|tests)\//u.test(name)
  || /(?:^|\/)[^/]+\.test\.(?:mjs|cjs|js)$/u.test(name) || /^(?:README|AGENTS)\.md$/u.test(name);
const hostInputs = new Set(["RuntimeHost/AgentHub.RuntimeHost.cs", "RuntimeHost/AgentHub.IconBuilder.cs",
  "RuntimeHost/app.manifest", "VSCodeExtension/media/agent-hub-mark.png"]);

async function regular(file) {
  const info = await lstat(file).catch(error => {
    if (error.code === "ENOENT") reject("required source or installed artifact is absent");
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) reject("source evidence must be a bounded regular file");
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
async function sourceBlobs(git, entries, paths) {
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
    if (raw.length > 4 * 1024 * 1024 || (raw.length && raw.at(-1) !== 0)) reject("repository inventory is malformed or exceeds bound");
    const paths = new Set(), retained = [];
    let offset = 0, count = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(0, offset);
      const record = raw.subarray(offset, end);
      const tab = record.indexOf(9);
      if (tab < 0 || !/^(?:100644 blob|100755 blob|120000 blob|160000 commit) (?:[a-f0-9]{40}|[a-f0-9]{64})$/u
        .test(record.subarray(0, tab).toString("utf8")) || tab + 1 === record.length
        || ++count > 16_384) reject("repository inventory is malformed or exceeds bound");
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

export async function assertInstalledLocalSourceBaseline({
  provenance, git, primaryMainCommit, publishedRevision, planRevision, tasks, runtimeRoot,
  adoptionGit = git, repositoryRoot = null,
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
  if (patch.length > 4 * 1024 * 1024 || sha(patch) !== p.sourcePatchSha256) reject("source patch changed or exceeds migration bound");
  const current = JSON.parse(await regular(path.join(runtimeRoot, "current.json")));
  if (current.current !== p.installedReleaseId) reject("installed release changed");
  const releaseRoot = path.join(runtimeRoot, "releases", p.installedReleaseId);
  const manifestBytes = await regular(path.join(releaseRoot, "runtime-manifest.json"));
  if (sha(manifestBytes) !== p.installedManifestSha256) reject("installed manifest changed");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.releaseId !== p.installedReleaseId || !Array.isArray(manifest.files)
      || manifest.files.length > 16384 || manifest.files.some(file => typeof file.path !== "string"
        || !/^[a-f0-9]{64}$/u.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0)) reject("installed identity changed");
  const files = new Map(manifest.files.map(file => [file.path, file]));
  if (files.size !== manifest.files.length) reject("duplicate runtime paths");
  const changed = String(await git(["diff", "--name-only", "--no-renames", "-z", publishedRevision, p.sourceBaseCommit]))
    .split("\0").filter(Boolean);
  if (changed.length > 512) reject("carry exceeds migration path bound");
  const entries = String(await git(["ls-tree", "-r", "-z", p.sourceBaseCommit, "--", "AgentHub"]))
    .split("\0").filter(Boolean);
  if (entries.length > 8192) reject("source inventory exceeds migration bound");
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
  await validateOrigin();
  return { provenance: p, runtimeFiles, hostChanged, ...(p.adoptions ? { adoptions } : {}) };
}

// Test uses the same installed-byte proof as preparation. Only the manifest's
// retained source checkout supplies a candidate commit; it is not trusted until
// the complete ordinary baseline verifier above accepts it.
export async function installedNativeHistoryBaseline({ git, sourceGit, repositoryRoot,
  primaryMainCommit, publishedRevision, tasks, runtimeRoot, planRevision, adoptions = [] }) {
  const currentFile = path.join(runtimeRoot, "current.json");
  if (!await lstat(currentFile).catch(error => { if (error.code === "ENOENT") return null; throw error; })) return null;
  const current = JSON.parse(await regular(currentFile));
  if (!/^[A-Za-z0-9._-]{1,200}$/u.test(current.current) || current.current.includes("..")) reject("installed identity changed");
  const bytes = await regular(path.join(runtimeRoot, "releases", current.current, "runtime-manifest.json"));
  const manifest = JSON.parse(bytes);
  if (typeof manifest.sourceRoot !== "string" || !path.isAbsolute(manifest.sourceRoot)) reject("retained source root is absent");
  const sourceBaseCommit = await sourceGit(manifest.sourceRoot, ["rev-parse", "HEAD^{commit}"]);
  const sourceBaseTree = await sourceGit(manifest.sourceRoot, ["rev-parse", "HEAD^{tree}"]);
  if (await sourceGit(manifest.sourceRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) reject("retained source checkout changed");
  if (sourceBaseCommit === publishedRevision) return null;
  const agreedOrigin = !adoptions.length && primaryMainCommit !== publishedRevision
    && String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] === primaryMainCommit;
  const p = { schemaVersion: 1, kind: LOCAL_SOURCE_BASELINE_PROVENANCE, publishedBaseCommit: publishedRevision,
    agreedMainCommit: primaryMainCommit, sourceBaseCommit, sourceBaseTree,
    sourcePatchSha256: sha(await git(["diff", "--binary", "--full-index", "--no-renames", publishedRevision, sourceBaseCommit], { rawOutput: true })),
    installedReleaseId: current.current, installedManifestSha256: sha(bytes), planRevision,
    selectionHash: localSourceSelectionHash(tasks), ...(adoptions.length ? {
      approvedOriginMainCommit: adoptions[0].adoptedCommit,
      adoptions: adoptions.map(({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit }) =>
        ({ taskId, resultCommit, recordRef, recordHash, adoptedCommit, acceptedLocalMainCommit })),
    } : agreedOrigin ? { approvedOriginMainCommit: primaryMainCommit, adoptions: [] } : {}) };
  return (await assertInstalledLocalSourceBaseline({ provenance: p, git, repositoryRoot, primaryMainCommit,
    publishedRevision, planRevision, tasks, runtimeRoot })).provenance;
}
