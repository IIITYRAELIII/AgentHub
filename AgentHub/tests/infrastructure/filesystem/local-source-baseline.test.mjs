import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { LOCAL_SOURCE_BASELINE_PROVENANCE, localSourceSelectionHash,
  normalizedReleaseBaseProvenance } from "../../../src/domain/release-base-provenance.mjs";
import { assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";
import { runtimeHostSourceHash } from "../../../src/infrastructure/process/runtime-host-builder.mjs";
import { ReleasePreparationRejectedError } from "../../../src/domain/release-preparation.mjs";

const run = promisify(execFile);
const hash = value => createHash("sha256").update(value).digest("hex");
async function git(root, args, options = {}) {
  const { stdout } = await run("git", args, { cwd: root, windowsHide: true, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
  return options.rawOutput ? stdout : stdout.toString("utf8").trim();
}
async function save(root, name, value) {
  const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value);
}
async function commit(root, message) {
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture(t, { conflict = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-local-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git"), primary = path.join(root, "primary"), carry = path.join(root, "carry");
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["clone", origin, primary]);
  await git(primary, ["config", "core.autocrlf", "false"]);
  await save(primary, ".gitattributes", "* text eol=lf\n");
  await save(primary, "AgentHub/package.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12" }) + "\n");
  await save(primary, "AgentHub/package-lock.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12",
    packages: { "": { name: "agent-hub", version: "2026.10.12" } } }) + "\n");
  await save(primary, "AgentHub/server.mjs", "export const repair = 0;\n");
  const main = await commit(primary, "agreed main");
  await git(primary, ["push", "origin", "main"]);
  await git(primary, ["worktree", "add", "-b", "local-carry", carry, main]);
  await save(carry, "AgentHub/README.md", "Previously published OWN code.\n");
  const published = await commit(carry, "OWN publication");
  await git(carry, ["push", "origin", "HEAD:main"]);
  await save(carry, "AgentHub/server.mjs", "export const repair = 1;\n");
  const source = await commit(carry, "installed local repair");
  const feature = path.join(root, "feature");
  await git(primary, ["worktree", "add", "-b", "selected-feature", feature, main]);
  await save(feature, conflict ? "AgentHub/server.mjs" : "AgentHub/feature.mjs",
    conflict ? "export const repair = 2;\n" : "export const selected = true;\n");
  const resultCommit = await commit(feature, "selected feature");
  const tasks = [{ taskId: "only-selected", taskRevision: 2, baseCommit: main, resultCommit }];
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const runtimeRoot = defaultRuntimeRoot({ environment });
  const release = path.join(runtimeRoot, "releases", "installed-repair");
  const physical = Buffer.from("export const repair = 1;\r\n");
  await save(release, "server.mjs", physical);
  const manifest = Buffer.from(JSON.stringify({ releaseId: "installed-repair",
    files: [{ path: "server.mjs", bytes: physical.length, sha256: hash(physical) }] }));
  await save(release, "runtime-manifest.json", manifest);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "installed-repair" }));
  await save(runtimeRoot, "publication-state.json", JSON.stringify({ repositories: [{ root: primary, revision: published }] }));
  const p = { schemaVersion: 1, kind: LOCAL_SOURCE_BASELINE_PROVENANCE, publishedBaseCommit: published,
    agreedMainCommit: main, sourceBaseCommit: source, sourceBaseTree: await git(primary, ["rev-parse", source + "^{tree}"]),
    sourcePatchSha256: hash(await git(primary, ["diff", "--binary", "--full-index", "--no-renames", published, source], { rawOutput: true })),
    installedReleaseId: "installed-repair", installedManifestSha256: hash(manifest),
    planRevision: "exact-plan", selectionHash: localSourceSelectionHash(tasks) };
  const verify = (extra = {}) => assertInstalledLocalSourceBaseline({ provenance: p,
    git: (args, options) => git(primary, args, options), primaryMainCommit: main,
    publishedRevision: published, planRevision: "exact-plan", tasks, runtimeRoot, ...extra });
  return { root, primary, carry, main, published, source, tasks, environment, runtimeRoot, release, physical, manifest, p, verify };
}

async function inheritedRepositoryFixture(t) {
  const f = await fixture(t);
  await save(f.primary, "TEAM_SKILLS/[Ж]/route.py", "accepted main routing\n");
  await save(f.primary, "CHANGELOG.md", "accepted main history\n");
  const main = await commit(f.primary, "accepted repository metadata after publication");
  await git(f.carry, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", main]);
  const source = await git(f.carry, ["rev-parse", "HEAD"]);
  const provenance = async (commitId = source) => ({ ...f.p, agreedMainCommit: main,
    sourceBaseCommit: commitId, sourceBaseTree: await git(f.primary, ["rev-parse", commitId + "^{tree}"]),
    sourcePatchSha256: hash(await git(f.primary, ["diff", "--binary", "--full-index", "--no-renames",
      f.published, commitId], { rawOutput: true })) });
  return { ...f, main, source, provenance,
    verifyInherited: async (extra = {}) => f.verify({ primaryMainCommit: main,
      provenance: await provenance(), ...extra }) };
}

test("valid installed source evidence is verified beyond the former record byte ceiling", async t => {
  const f = await fixture(t);
  const large = Buffer.concat([f.manifest, Buffer.alloc(17 * 1024 * 1024, 32)]);
  await save(f.release, "runtime-manifest.json", large);
  const result = await f.verify({ provenance: { ...f.p, installedManifestSha256: hash(large) } });
  assert.equal(result.runtimeFiles, 1);
  assert.deepEqual(await readFile(path.join(f.release, "runtime-manifest.json")), large);
  await assert.rejects(f.verify(), /installed manifest changed/u);
});

test("installed source preserves exact inherited repository files from agreed main", { timeout: 90000 }, async t => {
  const f = await inheritedRepositoryFixture(t);
  const result = await f.verifyInherited();
  assert.equal(result.runtimeFiles, 1);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
  assert.equal(await git(f.primary, ["show", f.source + ":TEAM_SKILLS/[Ж]/route.py"]), "accepted main routing");
  await git(f.carry, ["push", "origin", "HEAD:main"]);
  await assert.rejects(f.verifyInherited(), /origin differs from the pinned OWN publication/u);
});

test("installed source refuses changed, added, deleted or mode-shifted inherited repository files", { timeout: 90000 }, async t => {
  const f = await inheritedRepositoryFixture(t);
  for (const change of ["changed", "added", "deleted", "mode"]) {
    await git(f.carry, ["checkout", "--detach", f.source]);
    if (change === "changed") await save(f.carry, "TEAM_SKILLS/[Ж]/route.py", "unaccepted source override\n");
    if (change === "added") await save(f.carry, "other-component/tool.mjs", "unaccepted extra component\n");
    if (change === "deleted") await rm(path.join(f.carry, "CHANGELOG.md"));
    let changed;
    if (change === "mode") {
      await git(f.carry, ["update-index", "--chmod=+x", "TEAM_SKILLS/[Ж]/route.py"]);
      await git(f.carry, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "-m", "unaccepted outside mode"]);
      changed = await git(f.carry, ["rev-parse", "HEAD"]);
    } else changed = await commit(f.carry, "unaccepted outside " + change);
    await assert.rejects(f.verifyInherited({ provenance: await f.provenance(changed) }),
      error => error instanceof ReleasePreparationRejectedError && /repository files differ from agreed main/u.test(error.message));
    assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
    assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
  }
});

test("inherited repository proof refuses malformed or oversized raw Git manifests", { timeout: 90000 }, async t => {
  const f = await inheritedRepositoryFixture(t);
  for (const defect of ["unterminated", "duplicate", "oversized", 41, 63, 65]) {
    await assert.rejects(f.verifyInherited({ git: async (args, options) => {
      const result = await git(f.primary, args, options);
      if (args[0] !== "ls-tree" || !args.includes("--full-tree")) return result;
      const raw = Buffer.from(result);
      if (defect === "unterminated") return raw.subarray(0, raw.length - 1);
      if (defect === "duplicate") return Buffer.concat([raw, raw.subarray(0, raw.indexOf(0) + 1)]);
      if (typeof defect === "number") {
        const start = raw.indexOf(32, raw.indexOf(32) + 1) + 1;
        const end = raw.indexOf(9);
        return Buffer.concat([raw.subarray(0, start), Buffer.alloc(defect, 97), raw.subarray(end)]);
      }
      return Buffer.alloc(4 * 1024 * 1024 + 1);
    } }), /repository inventory/u);
  }
});

// Deterministic Git port with real disposable inputs, manifest and artifact.
// The existing tests below separately exercise the native Git candidate owner.
async function hostFixture(t, { changed = "RuntimeHost/AgentHub.RuntimeHost.cs",
  artifact = "exact", manifestArtifact = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-local-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime"), inputs = path.join(root, "inputs");
  const release = path.join(runtimeRoot, "releases", "installed-host");
  const sources = new Map([
    ["RuntimeHost/AgentHub.RuntimeHost.cs", Buffer.from("// exact host input\n")],
    ["RuntimeHost/AgentHub.IconBuilder.cs", Buffer.from("// exact icon builder\n")],
    ["RuntimeHost/app.manifest", Buffer.from("<exact/>\n")],
    ["VSCodeExtension/media/agent-hub-mark.png", Buffer.from("synthetic image bytes")],
  ]);
  for (const [name, bytes] of sources) await save(inputs, name, bytes);
  const marker = Buffer.from(await runtimeHostSourceHash(inputs));
  const binary = Buffer.from("original compiled host artifact");
  const changedBinary = Buffer.from(binary); changedBinary[0] ^= 1;
  await save(release, "AgentHub.RuntimeHost.source.sha256", marker);
  if (artifact === "directory") await mkdir(path.join(release, "AgentHub.RuntimeHost.exe"), { recursive: true });
  else if (artifact !== "missing") await save(release, "AgentHub.RuntimeHost.exe",
    artifact === "changed" ? changedBinary :
      artifact === "truncated" ? binary.subarray(0, 5) : binary);
  const files = [{ path: "AgentHub.RuntimeHost.source.sha256", bytes: marker.length, sha256: hash(marker) }];
  if (manifestArtifact) files.push({ path: "AgentHub.RuntimeHost.exe", bytes: binary.length, sha256: hash(binary) });
  const manifest = Buffer.from(JSON.stringify({ releaseId: "installed-host", sourceRoot: inputs, files }));
  await save(release, "runtime-manifest.json", manifest);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "installed-host" }));
  const patch = Buffer.from("exact pinned diff for " + changed);
  const tasks = [{ taskId: "selected", taskRevision: 1, baseCommit: "1".repeat(40), resultCommit: "2".repeat(40) }];
  const p = { schemaVersion: 1, kind: LOCAL_SOURCE_BASELINE_PROVENANCE, publishedBaseCommit: "3".repeat(40),
    agreedMainCommit: "1".repeat(40), sourceBaseCommit: "4".repeat(40), sourceBaseTree: "5".repeat(40),
    sourcePatchSha256: hash(patch), installedReleaseId: "installed-host", installedManifestSha256: hash(manifest),
    planRevision: "exact-plan", selectionHash: localSourceSelectionHash(tasks) };
  const gitPort = async args => {
    if (args[0] === "ls-remote") return p.publishedBaseCommit + "\trefs/heads/main";
    if (args[0] === "merge-base") return "";
    if (args[0] === "rev-parse") return p.sourceBaseTree;
    if (args[0] === "diff") return args.includes("--binary") ? patch : "AgentHub/" + changed + "\0";
    if (args[0] === "ls-tree") return [...new Set([...sources.keys(), changed])]
      .map(name => "100644 blob " + "a".repeat(40) + "\tAgentHub/" + name + "\0").join("");
    if (args[0] === "show") {
      const name = args[1].split(":AgentHub/")[1];
      assert.ok(sources.has(name), "unexpected Git source read " + name);
      return sources.get(name);
    }
    throw new Error("unexpected Git operation " + args[0]);
  };
  return () => assertInstalledLocalSourceBaseline({ provenance: p, git: gitPort,
    primaryMainCommit: p.agreedMainCommit, publishedRevision: p.publishedBaseCommit,
    planRevision: p.planRevision, tasks, runtimeRoot });
}

test("compiled Host accepts only exact supported inputs and the manifest-matching artifact", async t => {
  for (const changed of ["RuntimeHost/AgentHub.RuntimeHost.cs", "RuntimeHost/AgentHub.IconBuilder.cs",
    "RuntimeHost/app.manifest", "VSCodeExtension/media/agent-hub-mark.png"]) {
    const verify = await hostFixture(t, { changed });
    assert.equal((await verify()).hostChanged, true);
  }
});

test("unknown Host scripts and sources cannot bypass installed evidence", async t => {
  for (const changed of ["RuntimeHost/uninstalled.ps1", "RuntimeHost/uninstalled.cs", "RuntimeHost/uninstalled.test.mjs"]) {
    const verify = await hostFixture(t, { changed });
    await assert.rejects(verify(), error => error instanceof ReleasePreparationRejectedError && /unsupported Host source/u.test(error.message));
  }
});

test("compiled Host refuses changed, missing or unmanifested physical artifacts", async t => {
  for (const options of [{ artifact: "changed" }, { artifact: "truncated" }, { artifact: "missing" },
    { artifact: "directory" }, { manifestArtifact: false }]) {
    const verify = await hostFixture(t, options);
    await assert.rejects(verify(), error => error instanceof ReleasePreparationRejectedError && /bytes changed|absent|regular file/u.test(error.message));
  }
});

test("preparation native conflict is a definite refusal with prior candidate pins intact", { timeout: 180000 }, async t => {
  const f = await fixture(t, { conflict: true });
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data"), environment: f.environment });
  const common = { projectRoot: f.primary, workspaceId: "workspace", planRevision: f.p.planRevision, frozenTasks: f.tasks };
  const prior = await service.prepareCandidate({ ...common, approvedBaseCommit: f.main });
  const checkpoint = await readFile(prior.checkpointFile ?? (await service.frozenCandidate(f.primary)).checkpointFile);
  const guard = { primaryMainCommit: f.main, originMainCommit: f.published, checkpointHash: hash(checkpoint),
    manifestHash: prior.manifestHash, preReleaseHead: prior.preReleaseHead, tree: prior.tree,
    approvedBaseCommit: f.source, approvedTree: "0".repeat(40) };
  await assert.rejects(service.prepareCandidate({ ...common, approvedBaseCommit: f.source,
    baseProvenance: f.p, preparationGuard: guard }), error => {
    assert.equal(error.code, "RELEASE_PREPARATION_REJECTED");
    assert.ok(error instanceof ReleasePreparationRejectedError);
    assert.equal(typeof error.conflictRoot, "string");
    assert.deepEqual(error.conflicts, ["AgentHub/server.mjs"]);
    return true;
  });
  // Outside explicit preparation, preserve the native owner's existing error.
  await assert.rejects(service.prepareCandidate({ ...common, approvedBaseCommit: f.source,
    baseProvenance: f.p }), { code: "RELEASE_NATIVE_MERGE_CONFLICT" });
  await assert.rejects(service.prepareCandidate({ ...common, approvedBaseCommit: f.source,
    baseProvenance: f.p, preparationGuard: guard }), { code: "RELEASE_PREPARATION_REJECTED" });
  const after = await service.frozenCandidate(f.primary);
  assert.equal(after.preReleaseHead, prior.preReleaseHead);
  assert.equal(after.manifestHash, prior.manifestHash);
  assert.deepEqual(await readFile(after.checkpointFile), checkpoint);
  assert.equal(await git(f.primary, ["rev-parse", "HEAD"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});

test("installed local source rejects substituted pins, selection, source and actual runtime bytes", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.verify()).runtimeFiles, 1);
  for (const key of ["sourceBaseTree", "sourcePatchSha256", "installedManifestSha256"]) {
    const p = { ...f.p, [key]: "0".repeat(key === "sourceBaseTree" ? 40 : 64) };
    await assert.rejects(f.verify({ provenance: p }), /changed/);
  }
  await assert.rejects(f.verify({ primaryMainCommit: "0".repeat(40) }), /changed/);
  await assert.rejects(f.verify({ publishedRevision: "0".repeat(40) }), /changed/);
  await assert.rejects(f.verify({ planRevision: "another-plan" }), /changed/);
  await assert.rejects(f.verify({ tasks: [{ ...f.tasks[0], resultCommit: f.source }] }), /changed/);
  assert.throws(() => normalizedReleaseBaseProvenance({ ...f.p, skipIntegrity: true }), /exact/);
  await save(f.release, "server.mjs", "tampered\n");
  await assert.rejects(f.verify(), /installed bytes changed/);
  await save(f.release, "server.mjs", f.physical);
  await save(f.runtimeRoot, "current.json", JSON.stringify({ current: "another-release" }));
  await assert.rejects(f.verify(), /installed release changed/);
  await save(f.runtimeRoot, "current.json", JSON.stringify({ current: "installed-repair" }));
  await save(f.carry, "AgentHub/server.mjs", "export const repair = 2;\n");
  const substituted = await commit(f.carry, "uninstalled source");
  const p = { ...f.p, sourceBaseCommit: substituted,
    sourceBaseTree: await git(f.primary, ["rev-parse", substituted + "^{tree}"]),
    sourcePatchSha256: hash(await git(f.primary, ["diff", "--binary", "--full-index", "--no-renames", f.published, substituted], { rawOutput: true })) };
  await assert.rejects(f.verify({ provenance: p }), /source differs/);
  await save(f.carry, "AgentHub/server.mjs", "export const repair = 1;\n");
  await git(f.carry, ["add", "AgentHub/server.mjs"]);
  await git(f.carry, ["update-index", "--chmod=+x", "AgentHub/server.mjs"]);
  await git(f.carry, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "uninstalled mode"]);
  const modeSource = await git(f.carry, ["rev-parse", "HEAD"]);
  const modePin = { ...f.p, sourceBaseCommit: modeSource,
    sourceBaseTree: await git(f.primary, ["rev-parse", modeSource + "^{tree}"]),
    sourcePatchSha256: hash(await git(f.primary, ["diff", "--binary", "--full-index", "--no-renames", f.published, modeSource], { rawOutput: true })) };
  await assert.rejects(f.verify({ provenance: modePin }), /regular non-executable/);
  await git(f.carry, ["push", "origin", "HEAD:main"]);
  await assert.rejects(f.verify(), /origin differs/);
  assert.equal(await git(f.primary, ["rev-parse", "main"]), f.main);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});

test("native candidate retains installed local source and selected result through reuse, generation and freeze", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data"), environment: f.environment });
  const request = { projectRoot: f.primary, workspaceId: "workspace", planRevision: f.p.planRevision,
    frozenTasks: f.tasks, approvedBaseCommit: f.source, baseProvenance: f.p };
  const before = await git(f.primary, ["rev-parse", "HEAD"]);
  const candidate = await service.prepareCandidate(request);
  assert.equal(await git(candidate.releaseRoot, ["show", candidate.preReleaseHead + ":AgentHub/server.mjs"]), "export const repair = 1;");
  assert.equal(await git(candidate.releaseRoot, ["show", candidate.preReleaseHead + ":AgentHub/feature.mjs"]), "export const selected = true;");
  assert.deepEqual(candidate.manifest.tasks.map(x => x.taskId), ["only-selected"]);
  const again = await service.prepareCandidate(request);
  assert.equal(again.preReleaseHead, candidate.preReleaseHead);
  assert.equal(again.manifestHash, candidate.manifestHash);
  await assert.rejects(service.prepareCandidate({ ...request, baseProvenance: { ...f.p, selectionHash: "0".repeat(64) } }), /selection changed/);
  assert.equal((await service.frozenCandidate(f.primary)).preReleaseHead, candidate.preReleaseHead);
  await assert.rejects(service.prepareCandidate({ ...request, validateBeforeCommit: async () => {
    await save(f.runtimeRoot, "current.json", JSON.stringify({ current: "raced-release" }));
  } }), /installed release changed/);
  await save(f.runtimeRoot, "current.json", JSON.stringify({ current: "installed-repair" }));
  assert.equal((await service.frozenCandidate(f.primary)).preReleaseHead, candidate.preReleaseHead);
  const notes = Buffer.from("# Release\n\nSelected feature.\n");
  await save(candidate.releaseRoot, "CHANGELOG.md", notes);
  const generationInput = { ...request, operationId: "one-release-original", generation: 1, changelogContent: notes };
  const generation = await service.prepareGeneration(generationInput);
  assert.equal(generation.checkpointPhase, "frozen");
  assert.equal(generation.manifest.baseProvenance.sourceBaseCommit, f.source);
  assert.equal(await git(generation.releaseRoot, ["show", generation.preReleaseHead + ":AgentHub/server.mjs"]), "export const repair = 1;");
  const repeated = await service.prepareGeneration(generationInput);
  assert.equal(repeated.preReleaseHead, generation.preReleaseHead);
  assert.equal(repeated.manifestHash, generation.manifestHash);
  const frozen = await service.freezePublicationCandidate({ projectRoot: f.primary, workspaceId: "workspace",
    expectedPlanRevision: f.p.planRevision, expectedPreparedHead: candidate.preReleaseHead,
    changelogContent: notes, releaseDate: new Date("2026-10-16T00:00:00Z") });
  assert.equal(frozen.phase, "frozen");
  assert.equal((await service.frozenCandidate(f.primary)).manifest.baseProvenance.sourceBaseCommit, f.source);
  assert.equal(await git(f.primary, ["rev-parse", "HEAD"]), before);
  assert.equal(await git(f.primary, ["status", "--porcelain=v1"]), "");
});
