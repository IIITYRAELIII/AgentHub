import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { selectedPublicationSteps } from "../../publish-changed.mjs";
import { resolveTestSelection, verifyTestPlan } from "../../src/domain/test-selection.mjs";
import { discoverReleaseTestInventory, releaseTestPlans } from "../../src/infrastructure/filesystem/release-test-inventory.mjs";
import { resolveTestContourSource } from "../../src/runtime/test-contour-manager.mjs";

const exec = promisify(execFile);
const all = { mode: "all", ids: [] };
const git = async (cwd, ...args) => String((await exec("git", ["-c", "core.autocrlf=false", ...args], { cwd, windowsHide: true })).stdout).trim();

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "frozen-inventory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const sourceRoot = path.join(repository, "AgentHub");
  await mkdir(path.join(sourceRoot, "tests"), { recursive: true });
  await git(repository, "init", "--initial-branch=main");
  await writeFile(path.join(sourceRoot, "tests", "core.test.mjs"), "// inventory only; never executed\n");
  await git(repository, "add", ".");
  await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "frozen source");
  const head = await git(repository, "rev-parse", "HEAD");
  const common = path.resolve(repository, await git(repository, "rev-parse", "--git-common-dir"));
  const markerFile = path.join(common, "agent-hub-release-clone.json");
  const marker = { schemaVersion: 1, kind: "agent-hub-owned-release-clone", releaseRoot: repository,
    releaseGitCommonDir: common, primaryRoot: path.join(root, "primary"), primaryGitCommonDir: path.join(root, "primary.git") };
  await writeFile(markerFile, JSON.stringify(marker));
  return { root, repository, sourceRoot, head, marker, markerFile };
}

test("frozen main all-plan dispatches exact candidate contour and every core check without dev preview", async t => {
  const f = await fixture(t);
  const [{ plan }] = await releaseTestPlans([{ repositoryRoot: f.repository, releaseRoot: f.repository }], all);
  const steps = selectedPublicationSteps({ unknown: [] }, plan);
  const contours = steps.filter(step => step.args.includes("contour:verify"));
  // Follow the real command's source-kind choice through the real Git owner.
  // The parent starts a second dev-only command and refuses this main checkout.
  for (const step of contours) {
    const source = await resolveTestContourSource({ root: path.join(f.root, "contour"), sourceRoot: f.sourceRoot,
      sourceKind: step.args.includes("--release-candidate") ? "release-candidate" : "dev" });
    assert.equal(source.kind, "release-candidate");
    assert.equal(source.branch, "main");
    assert.equal(source.headCommit, f.head);
  }
  assert.equal(contours.length, 1);
  assert.equal(contours[0].args.includes("--require-installed"), true);
  const core = plan.inventory.filter(id => !id.startsWith("check:"));
  assert.ok(core.includes("tests/core.test.mjs"));
  const suite = steps.find(step => step.args[0] === "test-suite.mjs");
  const selected = JSON.parse(suite.args.find(arg => arg.startsWith("--selection=")).slice(12));
  assert.deepEqual(selected, { mode: "include", ids: core });
  assert.ok(steps.some(step => step.args.includes("worker:verify")));
  assert.deepEqual(plan.selectedIds, plan.inventory);
  assert.deepEqual(plan.notSelectedIds, []);
  assert.equal(await git(f.repository, "status", "--porcelain=v1"), "");
  assert.equal(await git(f.repository, "rev-parse", "HEAD"), f.head);
});

test("frozen inventory rejects stale and foreign plans instead of silently excluding their checks", async t => {
  const f = await fixture(t);
  const inventory = await discoverReleaseTestInventory(f.sourceRoot);
  assert.throws(() => resolveTestSelection({ mode: "include", ids: ["check:contour"] }, inventory), /Unknown test selector/u);
  const stale = resolveTestSelection(all, [...inventory, { id: "check:contour" }]);
  assert.throws(() => verifyTestPlan(stale, inventory), /Frozen test plan changed/u);
  const foreign = resolveTestSelection(all, [...inventory, { id: "tests/foreign.test.mjs" }]);
  assert.throws(() => verifyTestPlan(foreign, inventory), /Frozen test plan changed/u);
});

test("ordinary dev preview retains exact dev source and refuses an unknown source kind", async t => {
  const f = await fixture(t);
  await git(f.repository, "checkout", "-b", "dev");
  const source = await resolveTestContourSource({ root: path.join(f.root, "contour"), sourceRoot: f.sourceRoot });
  assert.equal(source.kind, "dev");
  assert.equal(source.branch, "dev");
  assert.equal(source.headCommit, f.head);
  await assert.rejects(resolveTestContourSource({ root: path.join(f.root, "contour"), sourceRoot: f.sourceRoot,
    sourceKind: "foreign" }), /Unknown Test Contour source kind/u);
  await assert.rejects(resolveTestContourSource({ root: path.join(f.root, "contour"), sourceRoot: f.sourceRoot,
    sourceKind: "release-candidate" }), /must be attached to main/u);
});

test("frozen contour keeps dirty and foreign clone ownership refusals", async t => {
  const f = await fixture(t);
  const options = { root: path.join(f.root, "contour"), sourceRoot: f.sourceRoot, sourceKind: "release-candidate" };
  await writeFile(path.join(f.sourceRoot, "tests", "core.test.mjs"), "// changed\n");
  await assert.rejects(resolveTestContourSource(options), /must be clean/u);
  await git(f.repository, "restore", "AgentHub/tests/core.test.mjs");
  await writeFile(f.markerFile, JSON.stringify({ ...f.marker, releaseRoot: path.join(f.root, "foreign") }));
  await assert.rejects(resolveTestContourSource(options), /marker does not match/u);
});
