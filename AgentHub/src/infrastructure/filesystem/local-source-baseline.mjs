import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash,
  normalizedReleaseBaseProvenance } from "../../domain/release-base-provenance.mjs";
import { runtimeHostSourceHash } from "../process/runtime-host-builder.mjs";
import { ReleasePreparationRejectedError } from "../../domain/release-preparation.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const reject = message => { throw new ReleasePreparationRejectedError(`Installed local source baseline: ${message}`); };
const normalized = bytes => Buffer.from(Buffer.from(bytes).toString("utf8").replace(/\r\n/gu, "\n"));
const metadata = name => /^(?:docs|tests)\//u.test(name)
  || /(?:^|\/)[^/]+\.test\.(?:mjs|cjs|js)$/u.test(name) || /^(?:README|AGENTS)\.md$/u.test(name);

async function regular(file) {
  const info = await lstat(file);
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

// Read-only verifier inside the existing candidate owner. No base/ref, runtime
// overlay, adoption, receipt or additional recovery registry is written here.
export async function assertInstalledLocalSourceBaseline({
  provenance, git, primaryMainCommit, publishedRevision, planRevision, tasks, runtimeRoot,
}) {
  const p = normalizedReleaseBaseProvenance(provenance);
  if (p?.kind !== LOCAL_SOURCE_BASELINE_PROVENANCE) reject("missing provenance");
  if (p.agreedMainCommit !== primaryMainCommit || p.publishedBaseCommit !== publishedRevision
      || p.planRevision !== planRevision || p.selectionHash !== localSourceSelectionHash(tasks)) reject("base, plan or selection changed");
  if (String(await git(["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0] !== publishedRevision) reject("origin differs from the pinned OWN publication");
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
  let runtimeFiles = 0;
  let hostChanged = false;
  for (const file of changed) {
    if (!file.startsWith("AgentHub/")) reject("carry contains another component");
    const relative = file.slice("AgentHub/".length);
    if (metadata(relative)) continue;
    if (modes.get(file) !== "100644") reject("carry requires regular non-executable Git source entries");
    if (relative.startsWith("RuntimeHost/")) { hostChanged = true; continue; }
    const installed = files.get(relative);
    // Non-runtime executable/source changes cannot hide in a carry envelope.
    if (!installed) reject(`carry path is absent from the installed runtime: ${relative}`);
    const physical = await regular(path.join(releaseRoot, relative));
    if (sha(physical) !== installed.sha256 || physical.length !== installed.bytes) reject(`installed bytes changed: ${relative}`);
    const source = Buffer.from(await git(["show", `${p.sourceBaseCommit}:${file}`], { rawOutput: true }));
    if (!sourceMatches(source, physical, relative)) reject(`source differs from installed bytes: ${relative}`);
    runtimeFiles += 1;
  }
  if (hostChanged) {
    const expected = files.get("AgentHub.RuntimeHost.source.sha256");
    if (!expected || !manifest.sourceRoot) reject("compiled Host provenance is absent");
    const bytes = await regular(path.join(releaseRoot, expected.path));
    if (sha(bytes) !== expected.sha256 || bytes.length !== expected.bytes
        || (await runtimeHostSourceHash(manifest.sourceRoot)) !== bytes.toString("utf8").trim()) reject("compiled Host source changed");
    for (const relative of ["RuntimeHost/AgentHub.RuntimeHost.cs", "RuntimeHost/AgentHub.IconBuilder.cs",
      "RuntimeHost/app.manifest", "VSCodeExtension/media/agent-hub-mark.png"]) {
      const source = Buffer.from(await git(["show", `${p.sourceBaseCommit}:AgentHub/${relative}`], { rawOutput: true }));
      if (!sourceMatches(source, await regular(path.join(manifest.sourceRoot, relative)), relative)) reject("Host Git source differs from compiled inputs");
    }
  }
  return { provenance: p, runtimeFiles, hostChanged };
}
