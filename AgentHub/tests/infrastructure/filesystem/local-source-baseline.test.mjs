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
async function fixture(t) {
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
  await save(feature, "AgentHub/feature.mjs", "export const selected = true;\n");
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
