import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { publishChanged, selectedPublicationSteps } from "../../publish-changed.mjs";
import { resolveTestSelection, verifyTestPlan } from "../../src/domain/test-selection.mjs";
import { discoverReleaseTestInventory, releaseTestPlans } from "../../src/infrastructure/filesystem/release-test-inventory.mjs";
import { resolveTestContourSource } from "../../src/runtime/test-contour-manager.mjs";
import { preparePublicationTestSelection, readPublicationTestSelection } from "../../src/infrastructure/filesystem/publication-test-selection.mjs";

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

const digest = value => createHash("sha256").update(value).digest("hex");

async function selectionFixture(t, count = 1) {
  const f = await fixture(t);
  for (let index = 0; index < count; index += 1) {
    await writeFile(path.join(f.sourceRoot, "tests", `selected-${String(index).padStart(4, "0")}-${"x".repeat(32)}.test.mjs`), "// selection input only\n");
  }
  await writeFile(path.join(f.repository, ".gitignore"), "AgentHub/WIP/\n");
  // This bounded child exercises the production payload reader. The full test
  // executor is controlled here; no generated inventory body is executed.
  await writeFile(path.join(f.sourceRoot, "test-suite.mjs"), `
import { createHash } from "node:crypto";
import { readPublicationTestSelection } from ${JSON.stringify(new URL("../../src/infrastructure/filesystem/publication-test-selection.mjs", import.meta.url).href)};
const args = process.argv.slice(3);
const selection = args.some(arg => arg.startsWith("--selection-file="))
  ? await readPublicationTestSelection(args, { sourceRoot: import.meta.dirname })
  : JSON.parse(args[0].slice("--selection=".length));
console.log(JSON.stringify({ count: selection.ids.length, digest: createHash("sha256").update(JSON.stringify(selection)).digest("hex") }));
`);
  await git(f.repository, "add", ".");
  await git(f.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "selected receiver");
  f.head = await git(f.repository, "rev-parse", "HEAD");
  f.inventory = await discoverReleaseTestInventory(f.sourceRoot);
  f.plan = resolveTestSelection(all, f.inventory);
  return f;
}

function coreSelection(plan) {
  return { mode: "include", ids: plan.selectedIds.filter(id => !id.startsWith("check:")) };
}

test("publication launches an oversized whole selection through bounded argv and preserves completed checkpoints", async t => {
  const f = await selectionFixture(t, 850);
  const legacy = selectedPublicationSteps({ unknown: [] }, f.plan).find(step => step.args[0] === "test-suite.mjs");
  const legacyArgument = legacy.args.find(arg => arg.startsWith("--selection="));
  assert.ok(legacyArgument.length > 44741);
  if (process.platform === "win32") {
    await assert.rejects(async () => exec(legacy.command, legacy.args, { cwd: f.sourceRoot, windowsHide: true }), { code: "ENAMETOOLONG" });
  }
  let saved = null;
  let selectedLaunches = 0;
  let failWorker = true;
  const checkpoint = { read: async () => saved, write: async value => { saved = value; }, clear: async () => { saved = null; } };
  const options = {
    exclusive: operation => operation(), repositoryRoot: f.repository, runtimeRoot: path.join(f.root, "runtime"),
    diff: async () => ["AgentHub/tests/core.test.mjs"], readState: async () => null, writeState: async () => {}, checkpoint,
    run: async step => {
      if (step.args[0] === "test-suite.mjs") {
        selectedLaunches += 1;
        const result = await exec(step.command, step.args, { cwd: step.cwd, windowsHide: true, encoding: "utf8" });
        assert.equal(step.args.length, 4);
        assert.ok(step.args.every(arg => arg.length < 1024));
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), { count: coreSelection(f.plan).ids.length, digest: digest(JSON.stringify(coreSelection(f.plan))) });
        t.diagnostic(JSON.stringify({ legacyArgumentUtf16: legacyArgument.length,
          boundedArgc: step.args.length, largestArgumentUtf16: Math.max(...step.args.map(arg => arg.length)),
          selectedCoreIds: coreSelection(f.plan).ids.length, childJoined: true }));
      } else if (step.args.includes("worker:verify") && failWorker) throw new Error("controlled worker failure");
    },
  };
  const args = ["--from", f.head, `--test-plan=${JSON.stringify(f.plan)}`];
  await assert.rejects(publishChanged(args, options), /controlled worker failure/u);
  assert.equal(selectedLaunches, 1);
  assert.ok(saved.completedLabels.includes("Выбранные тесты Agent Hub"));
  assert.deepEqual(saved.identity.testPlan, f.plan);
  failWorker = false;
  assert.equal((await publishChanged(args, options)).status, "published");
  assert.equal(selectedLaunches, 1, "the completed selected step is reused through its existing checkpoint");
  assert.equal(saved, null);
  assert.equal(await git(f.repository, "status", "--porcelain=v1"), "");
});

test("selection payload preserves small, empty and partial exact scopes", async t => {
  const f = await selectionFixture(t);
  const id = "tests/core.test.mjs";
  for (const selection of [all, { mode: "include", ids: [id] }, { mode: "exclude", ids: [id] }, { mode: "none", ids: [] }]) {
    const plan = resolveTestSelection(selection, f.inventory);
    const args = await preparePublicationTestSelection(plan, { repositoryRoot: f.repository, revision: f.head });
    assert.deepEqual(await readPublicationTestSelection(args, { sourceRoot: f.sourceRoot }), coreSelection(plan));
    assert.deepEqual(await preparePublicationTestSelection(plan, { repositoryRoot: f.repository, revision: f.head }), args);
  }
});

test("selection payload refuses changed bytes, incomplete arguments and malformed plans", async t => {
  const f = await selectionFixture(t);
  const args = await preparePublicationTestSelection(f.plan, { repositoryRoot: f.repository, revision: f.head });
  for (const invalid of [args.slice(0, 1), [...args, args[0]], [...args, '--selection={"mode":"none","ids":[]}']]) {
    await assert.rejects(readPublicationTestSelection(invalid, { sourceRoot: f.sourceRoot }), /exactly/u);
  }
  const file = args[0].slice("--selection-file=".length);
  const bytes = await readFile(file);
  await writeFile(file, "{}");
  await assert.rejects(readPublicationTestSelection(args, { sourceRoot: f.sourceRoot }), /digest changed/u);
  await assert.rejects(preparePublicationTestSelection(f.plan, { repositoryRoot: f.repository, revision: f.head }), /payload changed/u);
  const malformedArgs = [args[0], `--selection-sha256=${digest("{}")}`];
  await assert.rejects(readPublicationTestSelection(malformedArgs, { sourceRoot: f.sourceRoot }), /Invalid selected-test payload/u);
  const incomplete = { ...f.plan, selectedIds: f.plan.selectedIds.slice(1) };
  await assert.rejects(preparePublicationTestSelection(incomplete, { repositoryRoot: f.repository, revision: f.head }), /Frozen test plan changed/u);
  await writeFile(file, bytes);
});

test("selection payload refuses foreign roots, changed commits, dirty source and stale inventory", async t => {
  const f = await selectionFixture(t);
  const args = await preparePublicationTestSelection(f.plan, { repositoryRoot: f.repository, revision: f.head });
  const foreign = await selectionFixture(t);
  await assert.rejects(readPublicationTestSelection(args, { sourceRoot: foreign.sourceRoot }), /source changed/u);
  await writeFile(path.join(f.sourceRoot, "tests/core.test.mjs"), "// dirty\n");
  await assert.rejects(readPublicationTestSelection(args, { sourceRoot: f.sourceRoot }), /dirty working tree/u);
  await git(f.repository, "add", ".");
  await git(f.repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed source");
  await assert.rejects(readPublicationTestSelection(args, { sourceRoot: f.sourceRoot }), /source changed/u);
  const revision = await git(f.repository, "rev-parse", "HEAD");
  const stale = resolveTestSelection(all, [...f.inventory, { id: "tests/foreign.test.mjs" }]);
  const staleArgs = await preparePublicationTestSelection(stale, { repositoryRoot: f.repository, revision });
  await assert.rejects(readPublicationTestSelection(staleArgs, { sourceRoot: f.sourceRoot }), /Frozen test plan changed/u);
});
