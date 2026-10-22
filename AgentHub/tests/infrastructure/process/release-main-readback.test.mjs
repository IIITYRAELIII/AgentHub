import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { PUBLICATION_STAGE_CONTRACT } from "../../../src/infrastructure/persistence/publication-run-store.mjs";

const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-main-readback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), candidateRoot = path.join(root, "candidate");
  await git(root, "init", "--initial-branch=main", primary);
  await git(primary, "config", "user.name", "Test"); await git(primary, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(primary, "base.txt"), "base"); await git(primary, "add", "."); await git(primary, "commit", "-m", "base");
  const base = await git(primary, "rev-parse", "HEAD");
  await git(root, "clone", primary, candidateRoot);
  await git(candidateRoot, "config", "user.name", "Test"); await git(candidateRoot, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(candidateRoot, "candidate.txt"), "candidate"); await git(candidateRoot, "add", "."); await git(candidateRoot, "commit", "-m", "old candidate");
  const commit = await git(candidateRoot, "rev-parse", "HEAD");
  await writeFile(path.join(primary, "current.txt"), "reviewed main"); await git(primary, "add", "."); await git(primary, "commit", "-m", "current main");
  const remote = await git(primary, "rev-parse", "HEAD");
  const operation = { operationId: "original" }, target = { targetId: "target", repositoryRoot: primary };
  const generation = { generation: 1, identitySha256: "a".repeat(64), candidates: [{ repositoryRoot: primary, releaseRoot: candidateRoot, commit, baseCommit: base }] };
  const layout = path.join(root, "release-operation-executions", createHash("sha256").update("original:1:target").digest("hex"));
  await mkdir(layout, { recursive: true });
  const runner = { operationId: "original", generation: 1, targetId: "target", candidate: generation.identitySha256,
    pid: 123, status: "exited", exitCode: 1, completedAt: "2026-10-22T00:00:00Z" };
  const saveRunner = () => writeFile(path.join(layout, "runner.json"), JSON.stringify(runner)); await saveRunner();
  const journal = { version: 2, stageContractVersion: 1, runId: "run", status: "failed", currentStep: null,
    finishedAt: runner.completedAt, progress: {}, identity: { revision: commit, labels: PUBLICATION_STAGE_CONTRACT.map(s => s.label) },
    steps: PUBLICATION_STAGE_CONTRACT.map((s, i) => ({ label: s.label, stageId: s.id, status: i === 0 ? "failed" : "pending" })) };
  const publication = new ReleaseOperationPublication({ dataDir: root, runtimeRoot: root, processAliveImpl: () => false,
    readPublicationStateImpl: async () => null, gitRemoteHeadImpl: async () => remote,
    publicationRunStoreFactory: () => ({ read: async () => journal }) });
  const input = { operation, generation, target, reviewedMain: { approvedRepositories: [{ projectRoot: primary, approvedOriginMainCommit: remote }] } };
  return { publication, input, journal, runner, saveRunner, root, primary, candidateRoot, remote, commit };
}

test("original failed pre-effect journal and real divergent Git history prove no old publication at freshly reviewed origin", async t => {
  const f = await setup(t);
  const before = await git(f.primary, "show-ref");
  assert.equal((await f.publication.readback({ ...f.input, reviewedMain: null })).status, "unknown");
  const result = await f.publication.readback(f.input);
  assert.equal(result.status, "not_applied"); assert.equal(result.evidence.candidateAbsentFromRemote, true);
  assert.equal(await git(f.primary, "show-ref"), before);
  assert.equal(await git(f.primary, "status", "--porcelain"), "");
  assert.equal(await git(f.primary, "config", "--get", "core.repositoryformatversion"), "0");
  await assert.rejects(readFile(path.join(f.primary, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  await rm(f.candidateRoot, { recursive: true });
  assert.equal((await f.publication.readback(f.input)).status, "not_applied", "canonical old checkout retirement does not erase complete current ancestry proof");
});

for (const condition of ["effect-stage", "partial", "live", "foreign-runner", "ancestor", "missing-origin-object", "shallow", "grafts", "different-origin"]) {
  test(`original ${condition} refuses reviewed-origin no-effect credit`, async t => {
    const f = await setup(t);
    if (condition === "effect-stage") f.journal.steps[3].status = "completed";
    if (condition === "partial") f.journal.progress.publicationState = { revision: f.commit };
    if (condition === "live") f.publication.processAlive = () => true;
    if (condition === "foreign-runner") { f.runner.operationId = "foreign"; await f.saveRunner(); }
    if (condition === "ancestor") { await git(f.primary, "fetch", f.candidateRoot, f.commit); await git(f.primary, "merge", "--no-edit", "-s", "ours", f.commit);
      f.publication.gitRemoteHead = async () => await git(f.primary, "rev-parse", "HEAD");
      f.input.reviewedMain.approvedRepositories[0].approvedOriginMainCommit = await f.publication.gitRemoteHead(); }
    if (condition === "missing-origin-object") { f.publication.gitRemoteHead = async () => "b".repeat(40); f.input.reviewedMain.approvedRepositories[0].approvedOriginMainCommit = "b".repeat(40); }
    if (condition === "shallow") await writeFile(path.join(f.primary, ".git", "shallow"), f.remote + "\n");
    if (condition === "grafts") await writeFile(path.join(f.primary, ".git", "info", "grafts"), f.remote + "\n");
    if (condition === "different-origin") f.input.reviewedMain.approvedRepositories[0].approvedOriginMainCommit = "b".repeat(40);
    assert.notEqual((await f.publication.readback(f.input)).status, "not_applied");
  });
}
