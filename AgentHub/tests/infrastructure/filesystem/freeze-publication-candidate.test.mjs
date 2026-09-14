import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ReleaseGitWorkspaceService, assertReleaseCandidateContourSource } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";

const execute = promisify(execFile);
const git = async (cwd, ...args) => String((await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout).trimEnd();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-freeze-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", path.join(root, "origin.git"));
  await git(root, "clone", path.join(root, "origin.git"), primary);
  await git(primary, "config", "core.autocrlf", "false");
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23",
  }, null, 2)}\n`);
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23", packages: { "": { name: "agent-hub", version: "2026.8.23" } },
  }, null, 2)}\n`);
  await writeFile(path.join(primary, "app.txt"), "source\n");
  await writeFile(path.join(primary, "CHANGELOG.md"), "previous\n");
  await git(primary, "add", "-A");
  await git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
  await git(primary, "push", "-u", "origin", "main");
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "data") });
  const candidate = await service.prepareCandidate({ projectRoot: primary, workspaceId: "workspace", planRevision: "plan", frozenTasks: [] });
  await git(candidate.releaseRoot, "config", "core.autocrlf", "false");
  const checkpointFile = path.join(candidate.releaseRoot, "..", "checkpoint.json");
  const freeze = (options = {}) => service.freezePublicationCandidate({ projectRoot: primary, workspaceId: "workspace",
    expectedPlanRevision: "plan", expectedPreparedHead: candidate.preReleaseHead,
    changelogContent: Buffer.from("consolidated\n"), releaseDate: new Date(2026, 7, 24, 23, 59), ...options });
  return { primary, service, candidate, freeze, checkpointFile };
}

test("freeze commits only supplied CHANGELOG, promotes clone main and preserves dirty primary", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.primary, "app.txt"), "intentional primary bytes\r\n");
  const snapshot = async () => ({ head: await git(f.primary, "rev-parse", "HEAD"), branch: await git(f.primary, "symbolic-ref", "HEAD"),
    index: await git(f.primary, "write-tree"), status: await git(f.primary, "status", "--porcelain"), bytes: await readFile(path.join(f.primary, "app.txt"), "utf8") });
  const before = await snapshot();
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  const frozen = await f.freeze();
  assert.equal(frozen.phase, "frozen");
  assert.notEqual(frozen.preReleaseHead, f.candidate.preReleaseHead);
  assert.equal(await git(f.candidate.releaseRoot, "show", "-s", "--format=%P", frozen.preReleaseHead), f.candidate.preReleaseHead);
  assert.deepEqual((await git(f.candidate.releaseRoot, "diff", "--name-only", f.candidate.preReleaseHead, frozen.preReleaseHead))
    .split("\n").sort(), ["AgentHub/package-lock.json", "AgentHub/package.json", "CHANGELOG.md"]);
  assert.equal(JSON.parse(await readFile(path.join(f.candidate.releaseRoot, "AgentHub", "package.json"), "utf8")).version,
    "2026.8.24");
  assert.equal(await git(f.candidate.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  const manifestBytes = await readFile(frozen.manifestFile);
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), frozen.manifestHash);
  assert.equal(JSON.parse(manifestBytes).workspaceId, "workspace");
  assert.equal((await assertReleaseCandidateContourSource({ sourceRoot: path.join(f.candidate.releaseRoot, "AgentHub") })).headCommit, frozen.preReleaseHead);
  const repeat = await f.freeze({ validateBeforeCommit: () => assert.fail("frozen repeat must not require a changed Await plan") });
  assert.equal(repeat.reused, true);
  assert.equal(repeat.preReleaseHead, frozen.preReleaseHead);
  assert.deepEqual(await snapshot(), before);
});

test("freeze with unchanged CHANGELOG still commits the frozen CalVer", async (t) => {
  const f = await fixture(t);
  const frozen = await f.freeze({ changelogContent: Buffer.from("previous\n") });
  assert.notEqual(frozen.preReleaseHead, f.candidate.preReleaseHead);
  assert.equal(await git(f.candidate.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(f.candidate.releaseRoot, "status", "--porcelain"), "");
});

test("freeze rejects source edits, changed plan and mismatched supplied bytes before moving refs", async (t) => {
  const f = await fixture(t);
  const before = await readFile(f.checkpointFile, "utf8");
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  await writeFile(path.join(f.candidate.releaseRoot, "app.txt"), "unapproved source\n");
  await assert.rejects(f.freeze(), /only frozen release metadata/u);
  await writeFile(path.join(f.candidate.releaseRoot, "app.txt"), "source\n");
  await assert.rejects(f.freeze({ expectedPlanRevision: "other" }), /plan or Workspace changed/u);
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("different\n") }), /bytes changed/u);
  await assert.rejects(f.freeze({ validateBeforeCommit: () => { throw new Error("live plan changed"); } }), /live plan changed/u);
  assert.equal(await readFile(f.checkpointFile, "utf8"), before);
  assert.equal(await git(f.candidate.releaseRoot, "rev-parse", "HEAD"), f.candidate.preReleaseHead);
});

for (const phase of ["intent", "refs"]) test(`freeze resumes exact persisted commit after crash at ${phase}`, async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  await assert.rejects(f.freeze({ onPhase: (value) => { if (value === phase) throw new Error("simulated interruption"); } }), /simulated interruption/u);
  const pending = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  assert.equal(pending.phase, "freezing");
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "replaced\n");
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("replaced\n") }), /no longer matches frozen content/u);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\r\n");
  await assert.rejects(f.freeze({ changelogContent: Buffer.from("consolidated\r\n") }), /no longer matches frozen content/u);
  await writeFile(path.join(f.candidate.releaseRoot, "CHANGELOG.md"), "consolidated\n");
  const frozen = await f.freeze();
  assert.equal(frozen.preReleaseHead, pending.preReleaseHead);
  assert.equal(frozen.manifestHash, pending.manifestHash);
  assert.equal(frozen.phase, "frozen");
  assert.equal(await git(f.candidate.releaseRoot, "status", "--porcelain"), "");
  assert.equal(await git(f.candidate.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
});
