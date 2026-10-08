import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assertReleaseCandidateContourSource,
  assertReleaseCloneForPublication,
  ReleaseGitWorkspaceService,
} from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { canonicalPath } from "../../../src/infrastructure/filesystem/config.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { taskBranchName, taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { createTaskBoardMutationOwner } from "../../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceReleaseService } from "../../../src/application/workspace-release-service.mjs";
import {
  PUBLICATION_STAGE_CONTRACT,
  publicationRunPaths,
  publicationRunStore,
} from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import {
  resolveTestContourSource,
  TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
} from "../../../src/runtime/test-contour-manager.mjs";
import { assertPreparationTree } from "../../../src/infrastructure/filesystem/release-preparation-guard.mjs";

const execFileAsync = promisify(execFile);
const RECOVERY_SOURCE = { commit: "c".repeat(40), ownerSha256: "d".repeat(64) };

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

function gitWithInput(cwd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args[0]} exited with ${code}`));
    });
    child.stdin.end(input);
  });
}

async function commit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-git-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  const dataDir = path.join(root, "data");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await git(primary, "config", "core.autocrlf", "false");
  // core.autocrlf наследуется из системной конфигурации Windows; нормализация
  // делает рабочее дерево клона релиза детерминированным на всех платформах.
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n", "utf8");
  await mkdir(path.join(primary, ".team"));
  await mkdir(path.join(primary, "1C_ACCESS"));
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, "app.txt"), "main\n", "utf8");
  await writeFile(path.join(primary, ".team", "participant.json"), "team-main\n", "utf8");
  await writeFile(path.join(primary, "1C_ACCESS", "access.json"), "access-main\n", "utf8");
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23", packages: { "": { name: "agent-hub", version: "2026.8.23" } },
  }, null, 2)}\n`, "utf8");
  const baseCommit = await commit(primary, "main");
  await git(primary, "push", "-u", "origin", "main");
  const canonicalRoot = canonicalPath(root);
  const canonicalOrigin = canonicalPath(origin);
  const canonicalPrimary = canonicalPath(primary);
  const canonicalDataDir = canonicalPath(dataDir);
  const service = new ReleaseGitWorkspaceService({ dataDir: canonicalDataDir });
  const prepare = service.prepareCandidate.bind(service);
  // These legacy fixtures explicitly publish their synthetic baseline to the
  // bare repository. Production obtains this authority from publication state.
  service.prepareCandidate = async (request) => prepare({
    approvedBaseCommit: await git(canonicalOrigin, "rev-parse", "main"), ...request,
  });
  return {
    root: canonicalRoot,
    origin: canonicalOrigin,
    primary: canonicalPrimary,
    dataDir: canonicalDataDir,
    baseCommit,
    service,
  };
}

async function taskResult({ root, primary }, context, {
  branch = "HUB-126-fixture", file = "feature.txt", content = "feature\n",
} = {}) {
  const taskRoot = path.join(root, `task-${branch.replaceAll(/[^a-z0-9]+/giu, "-")}`);
  await git(primary, "worktree", "add", "-b", branch, taskRoot, "main");
  context.after(() => git(primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await mkdir(path.dirname(path.join(taskRoot, file)), { recursive: true });
  await writeFile(path.join(taskRoot, file), content, "utf8");
  return commit(taskRoot, branch);
}

async function publishCandidate(candidate) {
  await git(candidate.releaseRoot, "checkout", "main");
  await git(candidate.releaseRoot, "merge", "--ff-only", candidate.preReleaseHead);
  await git(candidate.releaseRoot, "push", "origin", "main");
  return git(candidate.releaseRoot, "rev-parse", "HEAD");
}

async function registeredTaskBranch(setup, context, { taskId, startCommit, baseCommit = setup.baseCommit }) {
  const branch = taskBranchName(taskId, setup.primary);
  const taskRoot = path.join(setup.root, `task-${taskId}`);
  await git(setup.primary, "worktree", "add", "-b", branch, taskRoot, startCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  await git(setup.primary, "update-ref",
    `refs/agent-hub/task-bases/${taskId}/${taskRepositoryKey(setup.primary)}`, baseCommit);
  return { branch, taskRoot };
}

for (const disposition of ["success", "tree-refusal", "callback-refusal", "callback-unknown"]) {
  test(`preparation-only native full15 precommit and ${disposition} retain canonical rollback boundary`, { timeout: 60000 }, async (t) => {
    const setup = await fixture(t);
    const initial = await setup.service.prepareCandidate({ planRevision: "prepare-plan", projectRoot: setup.primary });
    const prior = await setup.service.frozenCandidate(setup.primary);
    const rawCheckpoint = await readFile(prior.checkpointFile);
    const branch = "HUB-prepare-full15";
    const firstResult = await taskResult(setup, t, { branch, file: "owned/01.txt", content: "own-01\n" });
    const taskRoot = path.join(setup.root, "task-hub-prepare-full15");
    for (let index = 2; index <= 15; index += 1) {
      await writeFile(path.join(taskRoot, "owned", `${String(index).padStart(2, "0")}.txt`), `own-${index}\n`);
    }
    const resultCommit = await commit(taskRoot, "full15");
    const expectedTree = await git(taskRoot, "rev-parse", "HEAD^{tree}");
    const guard = { checkpointHash: createHash("sha256").update(rawCheckpoint).digest("hex"),
      manifestHash: initial.manifestHash, preReleaseHead: initial.preReleaseHead, tree: initial.tree,
      primaryMainCommit: setup.baseCommit, originMainCommit: setup.baseCommit,
      approvedBaseCommit: setup.baseCommit, publishedRevision: setup.baseCommit,
      approvedTree: disposition === "tree-refusal" ? "0".repeat(40) : expectedTree,
      argumentsHash: "a".repeat(64), sourceCommit: "b".repeat(40), sourceTree: "c".repeat(40),
      sourceClosureHash: "d".repeat(64), publicationHash: "e".repeat(64) };
    let callbackCalls = 0;
    const operation = () => setup.service.prepareCandidate({
      planRevision: "prepare-plan", projectRoot: setup.primary, workspaceId: "workspace-1",
      preflightRequestId: "native-preparation-original", preparationGuard: guard, preserveFrozen: true,
      frozenTasks: [{ taskId: "full15", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit,
        integrations: [{ commit: firstResult, parent: setup.baseCommit, order: 1 },
          { commit: resultCommit, parent: firstResult, order: 2 }] }],
      commitPrepared: async (candidate) => {
        callbackCalls += 1;
        assert.equal(candidate.tree, expectedTree);
        for (let index = 1; index <= 15; index += 1) {
          const file = `owned/${String(index).padStart(2, "0")}.txt`;
          assert.equal(await git(candidate.releaseRoot, "ls-tree", candidate.preReleaseHead, "--", file),
            await git(taskRoot, "ls-tree", resultCommit, "--", file));
        }
        assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`), "main");
        if (disposition === "callback-refusal") throw new Error("definitive receipt refusal");
        if (disposition === "callback-unknown") {
          const error = new Error("ambiguous receipt write");
          error.code = "AWAIT_ACCEPTANCE_UNKNOWN";
          throw error;
        }
      },
    });
    if (disposition === "success") {
      const candidate = await operation();
      assert.equal(candidate.tree, expectedTree);
      assert.equal(candidate.manifest.preparationIdentity.argumentsHash, guard.argumentsHash);
      assert.equal((await setup.service.frozenCandidate(setup.primary)).preflightRequestId, "native-preparation-original");
    } else {
      await assert.rejects(operation(), disposition === "tree-refusal"
        ? /reviewed tree/ : disposition === "callback-refusal" ? /definitive/ : { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
      const after = await setup.service.frozenCandidate(setup.primary);
      if (disposition === "callback-unknown") {
        assert.equal(after.tree, expectedTree);
        assert.notEqual(after.preReleaseHead, prior.preReleaseHead);
      } else {
        assert.equal(after.preReleaseHead, prior.preReleaseHead);
        assert.deepEqual(await readFile(prior.checkpointFile), rawCheckpoint);
      }
    }
    assert.equal(callbackCalls, disposition === "tree-refusal" ? 0 : 1);
    assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
    assert.equal(await git(setup.primary, "status", "--porcelain"), "");
  });
}

test("preparation-only matching approved tree still refuses outside-owned entries", async (t) => {
  const setup = await fixture(t);
  const ownCommit = await taskResult(setup, t, { branch: "HUB-outside-guard", file: "own.txt" });
  const taskRoot = path.join(setup.root, "task-hub-outside-guard");
  await writeFile(path.join(taskRoot, "unselected.txt"), "unselected\n");
  const foreign = await commit(taskRoot, "unselected witness");
  const tree = await git(taskRoot, "rev-parse", `${foreign}^{tree}`);
  const readGit = async (args, options = {}) => {
    const { stdout } = await execFileAsync("git", args, { cwd: taskRoot, windowsHide: true,
      encoding: options.rawOutput ? "buffer" : "utf8" });
    return options.rawOutput ? stdout : String(stdout).trim();
  };
  await assert.rejects(assertPreparationTree({ guard: { approvedTree: tree,
    approvedBaseCommit: setup.baseCommit, publishedRevision: setup.baseCommit }, tree,
    baseCommit: setup.baseCommit, tasks: [{ baseCommit: setup.baseCommit, resultCommit: ownCommit }],
    git: readGit }), /outside/);
});

test("one operation generation isolates source bundles per repository", { timeout: 30000 }, async (context) => {
  const first = await fixture(context);
  const second = await fixture(context);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "rg-"));
  context.after(() => rm(dataDir, { recursive: true, force: true }));
  const service = new ReleaseGitWorkspaceService({ dataDir });
  const common = {
    operationId: "operation-multi-repository",
    generation: 1,
    planRevision: "plan-multi-repository",
    workspaceId: "workspace",
    frozenTasks: [],
  };
  const firstCandidate = await service.prepareGeneration({
    ...common,
    projectRoot: first.primary,
    approvedBaseCommit: first.baseCommit,
    changelogContent: Buffer.from("prepared release notes\n", "utf8"),
  });
  const secondCandidate = await service.prepareGeneration({
    ...common,
    projectRoot: second.primary,
    approvedBaseCommit: second.baseCommit,
  });
  assert.notEqual(firstCandidate.generationRoot, secondCandidate.generationRoot);
  assert.equal(canonicalPath(firstCandidate.repositoryRoot), canonicalPath(first.primary));
  assert.equal(canonicalPath(secondCandidate.repositoryRoot), canonicalPath(second.primary));
  assert.equal(firstCandidate.checkpointPhase, "frozen");
  assert.equal(secondCandidate.checkpointPhase, "frozen");
  assert.equal(await git(firstCandidate.releaseRoot, "rev-parse", "HEAD"), firstCandidate.preReleaseHead);
  assert.equal(await git(secondCandidate.releaseRoot, "rev-parse", "HEAD"), secondCandidate.preReleaseHead);
  assert.equal(await git(firstCandidate.releaseRoot, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(await git(secondCandidate.releaseRoot, "symbolic-ref", "--short", "HEAD"), "main");
  assert.equal(await git(firstCandidate.releaseRoot, "show", `${firstCandidate.preReleaseHead}:CHANGELOG.md`), "prepared release notes");
  await service.discardGenerationCandidate(firstCandidate);
  await service.discardGenerationCandidate(secondCandidate);
  await assert.rejects(stat(firstCandidate.generationRoot), { code: "ENOENT" });
  await assert.rejects(stat(secondCandidate.generationRoot), { code: "ENOENT" });
  const firstArchive = path.join(dataDir, "release-generation-evidence", path.basename(firstCandidate.generationRoot));
  const secondArchive = path.join(dataDir, "release-generation-evidence", path.basename(secondCandidate.generationRoot));
  assert.equal((await readFile(path.join(firstArchive, "identity.json"), "utf8")).includes(common.operationId), true);
  assert.equal((await readFile(path.join(firstArchive, "evidence", `${firstCandidate.manifestHash}.json`))).length > 0, true);
  assert.equal((await readFile(path.join(secondArchive, "evidence", `${secondCandidate.manifestHash}.json`))).length > 0, true);
});

for (const binaryOnly of [false, true]) test(`PreRelease preserves ${binaryOnly ? "terminal binary patch delimiters" : "binary patch bytes and a trailing blank context line"}`, { timeout: 20000 }, async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "z-final.txt"), "before\nunchanged\n\n", "utf8");
  await writeFile(path.join(setup.primary, "binary.bin"), Buffer.from([0, 255, 1, 2, 3]));
  await commit(setup.primary, "base with trailing blank line and binary");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-HUB-patch-bytes");
  await git(setup.primary, "worktree", "add", "-b", "HUB-patch-bytes", taskRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  if (!binaryOnly) await writeFile(path.join(taskRoot, "z-final.txt"), "after\nunchanged\n\n", "utf8");
  const binary = Buffer.from([0, 254, 128, 7, 9, 0]);
  await writeFile(path.join(taskRoot, "binary.bin"), binary);
  const resultCommit = await commit(taskRoot, "binary result");
  const request = { planRevision: "plan-raw-patch", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-patch-bytes", taskRevision: 2, resultCommit }] };
  const candidate = await setup.service.prepareCandidate(request);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", `${candidate.preReleaseHead}^{tree}`),
    await git(taskRoot, "rev-parse", `${resultCommit}^{tree}`));
  const releasedText = await execFileAsync("git", ["show", `${candidate.preReleaseHead}:z-final.txt`], {
    cwd: candidate.releaseRoot, windowsHide: true,
  });
  assert.equal(releasedText.stdout, `${binaryOnly ? "before" : "after"}\nunchanged\n\n`);
  assert.deepEqual(await readFile(path.join(candidate.releaseRoot, "binary.bin")), binary);
  const retry = await setup.service.prepareCandidate(request);
  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, candidate.preReleaseHead);
});

test("candidate requires a pinned base and excludes newer remote and local main content", async (context) => {
  const setup = await fixture(context);
  const service = new ReleaseGitWorkspaceService({ dataDir: setup.dataDir });
  const request = { planRevision: "pinned-base", projectRoot: setup.primary, frozenTasks: [] };
  await assert.rejects(service.prepareCandidate(request), /requires an exact published, adopted, or explicitly reviewed base/u);
  const first = await service.prepareCandidate({ ...request, approvedBaseCommit: setup.baseCommit });
  await writeFile(path.join(setup.primary, "unreviewed.txt"), "unreviewed\n");
  const incoming = await commit(setup.primary, "unreviewed local and remote main");
  await git(setup.primary, "push", "origin", "main");
  const retry = await service.prepareCandidate({ ...request, approvedBaseCommit: setup.baseCommit });
  assert.equal(retry.preReleaseHead, first.preReleaseHead);
  assert.equal(retry.baseCommit, setup.baseCommit);
  assert.equal(await git(retry.releaseRoot, "rev-parse", "refs/remotes/origin/main"), incoming);
  await assert.rejects(git(retry.releaseRoot, "show", "PreRelease:unreviewed.txt"));
  assert.equal(await git(setup.primary, "rev-parse", "main"), incoming);
});

test("release candidate uses an independent clone and leaves a clean primary attached to main", async (context) => {
  const setup = await fixture(context);
  await taskResult(setup, context, { branch: "dev", file: "dev-only.txt", content: "must-not-release\n" });
  const resultCommit = await taskResult(setup, context);
  const before = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
  };

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-clean",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-clean", taskRevision: 3, resultCommit }],
  });

  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.equal(candidate.primaryPreserved, true);
  assert.equal(candidate.independentGitCommonDir, true);
  assert.notEqual(candidate.releaseGitCommonDir, candidate.primaryGitCommonDir);
  assert.equal(await git(candidate.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:feature.txt`), "feature");
  assert.equal(JSON.parse(await readFile(candidate.manifestFile, "utf8")).tasks[0].taskRevision, 3);
  await assert.rejects(git(candidate.releaseRoot, "cat-file", "-e", `${candidate.preReleaseHead}:dev-only.txt`));
  assert.equal((await assertReleaseCloneForPublication({ repositoryRoot: candidate.releaseRoot })).kind,
    "agent-hub-owned-release-clone");
  await assert.rejects(
    assertReleaseCloneForPublication({ repositoryRoot: setup.primary }),
    /requires an Agent Hub-owned independent release clone/u,
  );
});

async function interruptedFreezeFixture(context, {
  recoveryEvidenceWrite = (handle, value) => handle.writeFile(value, "utf8"),
  recoveryPhase = async () => {},
} = {}) {
  const setup = await fixture(context);
  const environment = { ...process.env, LOCALAPPDATA: path.join(setup.root, "state") };
  const resultCommit = await taskResult(setup, context, { branch: "HUB-recovery" });
  const planRevision = "7".repeat(64);
  const baseProvenance = {
    schemaVersion: 1,
    kind: "explicit-reviewed-main-v1",
    publishedBaseCommit: setup.baseCommit,
    approvedLocalMainCommit: setup.baseCommit,
    approvedOriginMainCommit: setup.baseCommit,
  };
  const candidate = await setup.service.prepareCandidate({
    planRevision, projectRoot: setup.primary, workspaceId: "workspace-recovery",
    approvedBaseCommit: setup.baseCommit, baseProvenance,
    frozenTasks: [{ taskId: "task-recovery", taskRevision: 2, resultCommit }],
  });
  const changelog = Buffer.from("# release\n\nrecovery fixture\n", "utf8");
  await writeFile(path.join(candidate.releaseRoot, "CHANGELOG.md"), changelog);
  const frozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace-recovery",
    expectedPlanRevision: planRevision, expectedPreparedHead: candidate.preReleaseHead,
    changelogContent: changelog, releaseDate: new Date("2026-09-21T00:00:00Z"),
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", taskRepositoryKey(setup.primary), "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
  checkpoint.phase = "freezing";
  await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  const publicationStateFile = path.join(environment.LOCALAPPDATA, "AgentHub", "publication-state.json");
  await mkdir(path.dirname(publicationStateFile), { recursive: true });
  await writeFile(publicationStateFile, `${JSON.stringify({ repositories: [{
    root: setup.primary, revision: setup.baseCommit,
  }] }, null, 2)}\n`, "utf8");
  const expected = {
    planRevision,
    manifestHash: checkpoint.manifestHash,
    preparedHead: checkpoint.publicationFreeze.preparedHead,
    frozenHead: checkpoint.preReleaseHead,
    frozenTree: await git(candidate.releaseRoot, "rev-parse", `${checkpoint.preReleaseHead}^{tree}`),
    publishedRevision: setup.baseCommit,
    approvedOriginMain: setup.baseCommit,
  };
  return {
    ...setup, candidate, checkpointFile, expected, environment,
    service: new ReleaseGitWorkspaceService({
      dataDir: setup.dataDir, environment, recoveryEvidenceWrite, recoveryPhase,
    }),
  };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableRecoveryValue = (value) => {
  if (Array.isArray(value)) return value.map(stableRecoveryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableRecoveryValue(item)]));
};
const recoveryHash = (value) => sha256(`${JSON.stringify(stableRecoveryValue(value))}\n`);

async function failedFrozenFixture(context, {
  legacyPublicationStages = false,
  failedStage = "full-tests",
  checkpointKind = "current",
  ...serviceOptions
} = {}) {
  const setup = await interruptedFreezeFixture(context, serviceOptions);
  const checkpoint = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  checkpoint.phase = "frozen";
  await writeFile(setup.checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  const stateRoot = path.join(setup.environment.LOCALAPPDATA, "AgentHub");
  const runId = "failed-frozen-run";
  const labels = PUBLICATION_STAGE_CONTRACT.map((stage) => stage.label);
  const identity = {
    mode: "changed", from: "test", revision: setup.expected.frozenHead,
    runtimeRoot: path.join(setup.root, "runtime"), worktreeRoot: setup.candidate.releaseRoot,
    validationMode: "full", artifactProtocol: 1, labels,
    release: {
      workspaceId: "workspace-recovery", planRevision: setup.expected.planRevision,
      manifestHash: setup.expected.manifestHash, baseCommit: checkpoint.baseCommit,
      preReleaseHead: setup.expected.frozenHead, primaryRoot: setup.primary,
    },
  };
  const runFile = publicationRunPaths(setup.environment).statusFile;
  const publicationCheckpointFile = path.join(stateRoot, "publication-checkpoint.json");
  const checkpointScope = {
    mode: "changed", from: identity.from, runtimeRoot: identity.runtimeRoot, validationMode: "full",
  };
  if (checkpointKind === "prior") {
    const priorIdentity = {
      ...identity,
      revision: "1".repeat(40),
      release: {
        ...identity.release,
        planRevision: "2".repeat(64), manifestHash: "3".repeat(64), preReleaseHead: "4".repeat(40),
      },
    };
    await publicationCheckpointStore(publicationCheckpointFile).write({
      identity: priorIdentity,
      checkpointScope: {
        mode: "changed", from: priorIdentity.from, runtimeRoot: priorIdentity.runtimeRoot,
        validationMode: priorIdentity.validationMode,
      },
      completedLabels: [labels[0]],
      completedFingerprints: { [labels[0]]: failedStage === "full-tests" ? "fixture-0" : "prior-contour" },
    });
  }
  let run;
  if (legacyPublicationStages) {
    const logDirectory = path.join(stateRoot, "publication-runs");
    await mkdir(logDirectory, { recursive: true });
    const logFile = path.join(logDirectory, `${runId}.log`);
    await writeFile(logFile, "full tests failed before publication effects\n", "utf8");
    run = {
      version: 2, runId, ownerPid: 999999, status: "failed", startedAt: "2026-09-21T00:00:00.000Z",
      finishedAt: "2026-09-21T00:01:00.000Z", currentStep: null, progress: {}, identity, logFile,
      steps: PUBLICATION_STAGE_CONTRACT.map((stage, index) => ({
        label: stage.label, status: index === 0 ? "completed" : index === 1 ? "failed" : "pending",
      })),
    };
    await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, "utf8");
    await publicationCheckpointStore(publicationCheckpointFile).write({
      identity, checkpointScope, completedLabels: [labels[0]],
      completedFingerprints: { [labels[0]]: "fixture-contour" },
    });
  } else {
    const journal = publicationRunStore({
      environment: setup.environment,
      createId: () => runId,
      ownerPid: () => 999999,
      now: (() => {
        let second = 0;
        return () => new Date(Date.UTC(2026, 8, 22, 0, 0, second++));
      })(),
    });
    const failedLabel = labels[failedStage === "contour" ? 0 : 1];
    await assert.rejects(runPublicationSteps(PUBLICATION_STAGE_CONTRACT.map((stage, index) => ({
      label: stage.label, fingerprint: `fixture-${index}`,
    })), {
      run: async ({ label }) => {
        if (label === failedLabel) throw new Error(`${failedStage} failed before publication effects`);
      },
      journal,
      checkpoint: publicationCheckpointStore(publicationCheckpointFile),
      identity,
      checkpointScope,
    }), /failed before publication effects/u);
    await journal.finish("failed", new Error(`${failedStage} failed before publication effects`));
    run = JSON.parse(await readFile(runFile, "utf8"));
  }
  const runBytes = await readFile(runFile);
  const publicationCheckpointBytes = await readFile(publicationCheckpointFile).catch((error) => (
    error?.code === "ENOENT" ? null : Promise.reject(error)
  ));
  const publicationCheckpoint = publicationCheckpointBytes
    ? JSON.parse(publicationCheckpointBytes.toString("utf8")) : null;
  const logBytes = await readFile(run.logFile);
  return {
    ...setup, checkpoint, run, runFile, publicationCheckpoint, publicationCheckpointFile,
    frozenExpected: {
      ...setup.expected, publicationRunId: runId, publicationRunSha256: sha256(runBytes),
      ...(publicationCheckpointBytes
        ? { publicationCheckpointSha256: sha256(publicationCheckpointBytes) }
        : { publicationCheckpointAbsent: true }),
      publicationLogSha256: sha256(logBytes),
    },
  };
}

async function pushReviewedOriginAdvance(setup, context, {
  content = "reviewed upstream release note\n", parent = null,
} = {}) {
  const writer = path.join(setup.root, `reviewed-origin-${randomUUID()}`);
  await git(setup.root, "clone", setup.origin, writer);
  context.after(() => rm(writer, { recursive: true, force: true }));
  if (parent) await git(writer, "checkout", "--detach", parent);
  await writeFile(path.join(writer, "CHANGELOG.md"), content, "utf8");
  const reviewedOriginMain = await commit(writer, "reviewed upstream advance");
  await git(writer, "push", "--force", "origin", `${reviewedOriginMain}:refs/heads/main`);
  const reviewedOriginParent = (await git(writer, "show", "-s", "--format=%P", reviewedOriginMain))
    .split(/\s+/u).filter(Boolean);
  const reviewedOriginTree = await git(writer, "rev-parse", `${reviewedOriginMain}^{tree}`);
  const diff = (await execFileAsync("git", ["diff", "--binary", setup.baseCommit, reviewedOriginMain], {
    cwd: writer, windowsHide: true, encoding: null,
  })).stdout;
  const reviewedOriginPatchId = String(await gitWithInput(writer, ["patch-id", "--stable"], diff))
    .trim().split(/\s+/u)[0];
  const reviewedOriginDiffHashObject = String(await gitWithInput(writer, ["hash-object", "--stdin"], diff)).trim();
  const originUrl = await git(setup.candidate.releaseRoot, "remote", "get-url", "origin");
  return {
    reviewedOriginMain,
    reviewedOriginParent: reviewedOriginParent.length === 1 ? reviewedOriginParent[0] : "0".repeat(40),
    reviewedOriginTree,
    reviewedOriginDiffSha256: sha256(diff),
    reviewedOriginDiffHashObject,
    reviewedOriginPatchId,
    releaseTrackingOriginMain: await git(setup.candidate.releaseRoot,
      "rev-parse", "refs/remotes/origin/main^{commit}"),
    originUrlSha256: sha256(originUrl),
  };
}

const failedFrozenRequest = (setup, requestId = "recover-failed-frozen") => ({
  projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId,
  sourceIdentity: RECOVERY_SOURCE, recoveryMode: "abandon-failed-frozen-candidate-v1",
  expected: setup.frozenExpected,
});

test("failed frozen recovery binds the executable pre-effect stage contract and preserves terminal records", async (context) => {
  const setup = await failedFrozenFixture(context, { legacyPublicationStages: true });
  const request = failedFrozenRequest(setup);
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  assert.equal(preview.identity.publicationStageEvidence.failedStageId, "agent-hub-full-tests");
  assert.equal(preview.identity.publicationStageEvidence.stageContractVersion, "legacy-hash-bound-v1");
  const completed = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(completed.status, "abandoned");
  assert.equal(sha256(await readFile(setup.runFile)), setup.frozenExpected.publicationRunSha256);
  assert.equal(sha256(await readFile(setup.publicationCheckpointFile)),
    setup.frozenExpected.publicationCheckpointSha256);
  await writeFile(setup.runFile, "foreign terminal bytes\n", "utf8");
  const replay = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(replay.reused, true);
  assert.equal(replay.proofHash, preview.proofHash);
});

test("full-test failure preserves a scope-compatible checkpoint that reused contour", async (context) => {
  const setup = await failedFrozenFixture(context, { failedStage: "full-tests", checkpointKind: "prior" });
  assert.equal(setup.run.steps[0].status, "reused");
  const beforeCheckpoint = await readFile(setup.publicationCheckpointFile);
  const request = failedFrozenRequest(setup, "recover-reused-contour");
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  assert.equal(preview.identity.publicationStageEvidence.failedStageId, "agent-hub-full-tests");
  assert.equal(preview.identity.publicationStageEvidence.checkpointObservation, "retained-prior-generation");
  const completed = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(completed.status, "abandoned");
  assert.deepEqual(await readFile(setup.publicationCheckpointFile), beforeCheckpoint);
});

for (const checkpointKind of ["absent", "prior"]) {
  test(`contour-failed frozen recovery binds ${checkpointKind} checkpoint evidence and replays once`, async (context) => {
    const setup = await failedFrozenFixture(context, { failedStage: "contour", checkpointKind });
    const request = failedFrozenRequest(setup, `recover-contour-failed-${checkpointKind}`);
    const beforeCheckpoint = setup.publicationCheckpointFile
      ? await readFile(setup.publicationCheckpointFile).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))
      : null;
    if (checkpointKind === "absent") {
      await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
        ...request,
        expected: { ...request.expected, publicationCheckpointSha256: "f".repeat(64) },
      }), /exactly one checkpoint digest or explicit absence/u);
    }
    const preview = await setup.service.recoverFreezingPublicationCandidate(request);
    assert.equal(preview.identity.publicationStageEvidence.failedStageId, "release-candidate-contour");
    assert.equal(preview.identity.publicationStageEvidence.checkpointObservation,
      checkpointKind === "prior" ? "retained-prior-generation" : "absent");
    const completed = await setup.service.recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    });
    assert.equal(completed.status, "abandoned");
    const afterCheckpoint = await readFile(setup.publicationCheckpointFile)
      .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    assert.deepEqual(afterCheckpoint, beforeCheckpoint);
    const replay = await setup.service.recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    });
    assert.equal(replay.reused, true);
  });
}

test("contour-failed recovery rejects effectful, mixed and changed checkpoint evidence", async (context) => {
  const effectful = await failedFrozenFixture(context, { failedStage: "contour", checkpointKind: "prior" });
  effectful.publicationCheckpoint.completedLabels.push(PUBLICATION_STAGE_CONTRACT[2].label);
  effectful.publicationCheckpoint.completedFingerprints[PUBLICATION_STAGE_CONTRACT[2].label] = "effect";
  const effectBytes = Buffer.from(`${JSON.stringify(effectful.publicationCheckpoint, null, 2)}\n`);
  await writeFile(effectful.publicationCheckpointFile, effectBytes);
  await assert.rejects(effectful.service.recoverFreezingPublicationCandidate({
    ...failedFrozenRequest(effectful, "effectful-prior-checkpoint"),
    expected: { ...effectful.frozenExpected, publicationCheckpointSha256: sha256(effectBytes) },
  }), /checkpoint reached an effect stage/u);

  const mixed = await failedFrozenFixture(context, { failedStage: "contour", checkpointKind: "prior" });
  mixed.publicationCheckpoint.identity.release.manifestHash = mixed.run.identity.release.manifestHash;
  const mixedBytes = Buffer.from(`${JSON.stringify(mixed.publicationCheckpoint, null, 2)}\n`);
  await writeFile(mixed.publicationCheckpointFile, mixedBytes);
  await assert.rejects(mixed.service.recoverFreezingPublicationCandidate({
    ...failedFrozenRequest(mixed, "mixed-prior-checkpoint"),
    expected: { ...mixed.frozenExpected, publicationCheckpointSha256: sha256(mixedBytes) },
  }), /mixed candidate identity/u);

  const foreignScope = await failedFrozenFixture(context, { failedStage: "contour", checkpointKind: "prior" });
  foreignScope.publicationCheckpoint.identity.runtimeRoot = path.join(foreignScope.root, "foreign-runtime");
  foreignScope.publicationCheckpoint.checkpointScope.runtimeRoot = foreignScope.publicationCheckpoint.identity.runtimeRoot;
  const foreignScopeBytes = Buffer.from(`${JSON.stringify(foreignScope.publicationCheckpoint, null, 2)}\n`);
  await writeFile(foreignScope.publicationCheckpointFile, foreignScopeBytes);
  await assert.rejects(foreignScope.service.recoverFreezingPublicationCandidate({
    ...failedFrozenRequest(foreignScope, "foreign-scope-prior-checkpoint"),
    expected: { ...foreignScope.frozenExpected, publicationCheckpointSha256: sha256(foreignScopeBytes) },
  }), /checkpoint schema or scope changed/u);

  let stopAtIntent = true;
  const changed = await failedFrozenFixture(context, {
    failedStage: "contour", checkpointKind: "absent",
    recoveryPhase: async (phase) => {
      if (phase === "intent" && stopAtIntent) {
        stopAtIntent = false;
        throw new Error("stop after absent checkpoint admission");
      }
    },
  });
  const changedRequest = failedFrozenRequest(changed, "changed-absent-checkpoint");
  const changedPreview = await changed.service.recoverFreezingPublicationCandidate(changedRequest);
  await assert.rejects(changed.service.recoverFreezingPublicationCandidate({
    ...changedRequest, confirm: true, expectedProofHash: changedPreview.proofHash,
  }), /stop after absent checkpoint admission/u);
  await writeFile(changed.publicationCheckpointFile, "{}\n", "utf8");
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: changed.dataDir, environment: changed.environment,
  }).recoverFreezingPublicationCandidate({
    ...changedRequest, confirm: true, expectedProofHash: changedPreview.proofHash,
  }), /durable external evidence changed after admission/u);
});

test("admitted failed frozen recovery survives unrelated remote drift but rejects publication of its candidate", async (context) => {
  let stopAtIntent = true;
  const setup = await failedFrozenFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent" && stopAtIntent) {
        stopAtIntent = false;
        throw new Error("stop after frozen recovery admission");
      }
    },
  });
  const request = failedFrozenRequest(setup, "recover-failed-frozen-drift");
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /stop after frozen recovery admission/u);
  const remoteWriter = path.join(setup.root, "remote-writer");
  await git(setup.root, "clone", setup.origin, remoteWriter);
  await writeFile(path.join(remoteWriter, "unrelated.txt"), "unrelated remote drift\n");
  const unrelated = await commit(remoteWriter, "unrelated remote drift");
  await git(remoteWriter, "push", "origin", "main");
  const resumed = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(resumed.status, "abandoned");
  assert.equal(await git(setup.origin, "rev-parse", "main"), unrelated);

  const published = await failedFrozenFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent") throw new Error("stop candidate publication fixture");
    },
  });
  const publishedRequest = failedFrozenRequest(published, "recover-failed-frozen-published");
  const publishedPreview = await published.service.recoverFreezingPublicationCandidate(publishedRequest);
  await assert.rejects(published.service.recoverFreezingPublicationCandidate({
    ...publishedRequest, confirm: true, expectedProofHash: publishedPreview.proofHash,
  }), /stop candidate publication fixture/u);
  await git(published.candidate.releaseRoot, "push", "origin",
    `${published.expected.frozenHead}:refs/heads/main`);
  const resumedService = new ReleaseGitWorkspaceService({ dataDir: published.dataDir, environment: published.environment });
  await assert.rejects(resumedService.recoverFreezingPublicationCandidate({
    ...publishedRequest, confirm: true, expectedProofHash: publishedPreview.proofHash,
  }), /foreign publication effect/u);
});

test("failed frozen recovery binds one reviewed upstream advance without moving release tracking", async (context) => {
  let stopAtIntent = true;
  const setup = await failedFrozenFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent" && stopAtIntent) {
        stopAtIntent = false;
        throw new Error("stop after reviewed origin admission");
      }
    },
  });
  const advance = await pushReviewedOriginAdvance(setup, context);
  const unchangedRefs = {
    main: await git(setup.candidate.releaseRoot, "rev-parse", "main"),
    preRelease: await git(setup.candidate.releaseRoot, "rev-parse", "PreRelease"),
    tracking: await git(setup.candidate.releaseRoot, "rev-parse", "refs/remotes/origin/main"),
  };
  const baseRequest = failedFrozenRequest(setup, "recover-reviewed-origin");
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate(baseRequest),
    /approved origin main changed/u);
  assert.deepEqual({
    main: await git(setup.candidate.releaseRoot, "rev-parse", "main"),
    preRelease: await git(setup.candidate.releaseRoot, "rev-parse", "PreRelease"),
    tracking: await git(setup.candidate.releaseRoot, "rev-parse", "refs/remotes/origin/main"),
  }, unchangedRefs);

  const request = { ...baseRequest, expected: { ...baseRequest.expected, ...advance } };
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  assert.equal(preview.identity.baseProvenance.approvedOriginMainCommit, setup.baseCommit);
  assert.equal(preview.identity.originMain, advance.reviewedOriginMain);
  assert.equal(preview.identity.trackingOriginMain, setup.baseCommit);
  assert.deepEqual(preview.identity.reviewedOriginAdvance, {
    ...advance, objectProof: "isolated-remote-objects-v1",
  });
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /stop after reviewed origin admission/u);
  const admitted = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  const evidence = JSON.parse(await readFile(admitted.recovery.evidenceFile, "utf8"));
  assert.deepEqual(evidence.reviewedOriginAdvance, preview.identity.reviewedOriginAdvance);

  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  }).recoverFreezingPublicationCandidate({
    ...baseRequest, confirm: true, expectedProofHash: preview.proofHash,
  }), /reviewed origin advance identity changed/u);
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  }).recoverFreezingPublicationCandidate({
    ...request,
    expected: { ...request.expected, reviewedOriginDiffSha256: "f".repeat(64) },
    confirm: true,
    expectedProofHash: preview.proofHash,
  }), /reviewed origin advance identity changed/u);
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  }).recoverFreezingPublicationCandidate({
    ...baseRequest,
    expected: { ...baseRequest.expected, reviewedOriginMain: advance.reviewedOriginMain },
    confirm: true,
    expectedProofHash: preview.proofHash,
  }), /reviewed origin advance identity is incomplete/u);

  const completed = await new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  }).recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(completed.status, "abandoned");
  assert.equal(await git(setup.origin, "rev-parse", "main"), advance.reviewedOriginMain);
  assert.equal(await git(setup.candidate.releaseRoot,
    "rev-parse", "refs/remotes/origin/main"), setup.baseCommit);
});

test("reviewed origin recovery rejects remote movement after durable admission", async (context) => {
  const setup = await failedFrozenFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent") throw new Error("stop after reviewed origin admission");
    },
  });
  const advance = await pushReviewedOriginAdvance(setup, context);
  const baseRequest = failedFrozenRequest(setup, "recover-reviewed-origin-moved-after-admission");
  const request = { ...baseRequest, expected: { ...baseRequest.expected, ...advance } };
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /stop after reviewed origin admission/u);
  const refsBefore = await git(setup.candidate.releaseRoot, "for-each-ref",
    "--format=%(refname):%(objectname)");
  const checkpointBefore = await readFile(setup.checkpointFile);

  await pushReviewedOriginAdvance(setup, context, { content: "unreviewed post-admission tip\n" });
  const resumedService = new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  });
  await assert.rejects(resumedService.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /reviewed origin changed after admission/u);
  assert.deepEqual(await readFile(setup.checkpointFile), checkpointBefore);
  assert.equal(await git(setup.candidate.releaseRoot, "for-each-ref",
    "--format=%(refname):%(objectname)"), refsBefore);
});

test("reviewed origin recovery rejects unreviewed bytes and movement after preview", async (context) => {
  const wrongBytes = await failedFrozenFixture(context);
  const wrongAdvance = await pushReviewedOriginAdvance(wrongBytes, context);
  const wrongRequest = failedFrozenRequest(wrongBytes, "recover-wrong-reviewed-origin");
  await assert.rejects(wrongBytes.service.recoverFreezingPublicationCandidate({
    ...wrongRequest,
    expected: { ...wrongRequest.expected, ...wrongAdvance, reviewedOriginDiffSha256: "f".repeat(64) },
  }), /reviewed origin advance proof changed/u);

  const moved = await failedFrozenFixture(context);
  const firstAdvance = await pushReviewedOriginAdvance(moved, context, { content: "reviewed first tip\n" });
  const movedRequest = failedFrozenRequest(moved, "recover-moving-reviewed-origin");
  const exactRequest = { ...movedRequest, expected: { ...movedRequest.expected, ...firstAdvance } };
  const preview = await moved.service.recoverFreezingPublicationCandidate(exactRequest);
  await pushReviewedOriginAdvance(moved, context, { content: "unreviewed second tip\n" });
  await assert.rejects(moved.service.recoverFreezingPublicationCandidate({
    ...exactRequest, confirm: true, expectedProofHash: preview.proofHash,
  }), /approved origin main changed/u);
  const checkpoint = JSON.parse(await readFile(moved.checkpointFile, "utf8"));
  assert.equal(checkpoint.phase, "frozen");
  assert.equal(checkpoint.recovery, undefined);
});

test("reviewed origin recovery rejects divergence and release tracking movement", async (context) => {
  const tracking = await failedFrozenFixture(context);
  const trackedAdvance = await pushReviewedOriginAdvance(tracking, context);
  await git(tracking.candidate.releaseRoot, "fetch", "--no-write-fetch-head", "origin",
    trackedAdvance.reviewedOriginMain);
  await git(tracking.candidate.releaseRoot, "update-ref", "refs/remotes/origin/main", trackedAdvance.reviewedOriginMain);
  const trackingRequest = failedFrozenRequest(tracking, "recover-moved-tracking-origin");
  await assert.rejects(tracking.service.recoverFreezingPublicationCandidate({
    ...trackingRequest, expected: { ...trackingRequest.expected, ...trackedAdvance },
  }), /approved origin main changed/u);

  const divergent = await failedFrozenFixture(context);
  const writer = path.join(divergent.root, `divergent-origin-${randomUUID()}`);
  await git(divergent.root, "clone", divergent.origin, writer);
  context.after(() => rm(writer, { recursive: true, force: true }));
  await git(writer, "checkout", "--orphan", "divergent-main");
  await git(writer, "rm", "-r", "--cached", ".");
  await writeFile(path.join(writer, "divergent.txt"), "unrelated history\n", "utf8");
  const divergentTip = await commit(writer, "divergent upstream");
  await git(writer, "push", "--force", "origin", `${divergentTip}:refs/heads/main`);
  const divergentDiff = (await execFileAsync("git", ["diff", "--binary", divergent.baseCommit, divergentTip], {
    cwd: writer, windowsHide: true, encoding: null,
  })).stdout;
  const divergentPatchId = String(await gitWithInput(writer, ["patch-id", "--stable"], divergentDiff))
    .trim().split(/\s+/u)[0];
  const divergentRequest = failedFrozenRequest(divergent, "recover-divergent-reviewed-origin");
  await assert.rejects(divergent.service.recoverFreezingPublicationCandidate({
    ...divergentRequest,
    expected: { ...divergentRequest.expected,
      reviewedOriginMain: divergentTip,
      reviewedOriginParent: "0".repeat(40),
      reviewedOriginTree: await git(writer, "rev-parse", `${divergentTip}^{tree}`),
      reviewedOriginDiffSha256: sha256(divergentDiff),
      reviewedOriginDiffHashObject: String(await gitWithInput(writer,
        ["hash-object", "--stdin"], divergentDiff)).trim(),
      reviewedOriginPatchId: divergentPatchId,
      releaseTrackingOriginMain: divergent.baseCommit,
      originUrlSha256: sha256(await git(divergent.candidate.releaseRoot, "remote", "get-url", "origin")),
    },
  }), /not an approved descendant/u);

  const published = await failedFrozenFixture(context);
  await git(published.candidate.releaseRoot, "push", "--force", "origin",
    `${published.expected.frozenHead}:refs/heads/main`);
  await git(published.candidate.releaseRoot, "update-ref", "refs/remotes/origin/main", published.baseCommit);
  const candidateDiff = (await execFileAsync("git", ["diff", "--binary",
    published.baseCommit, published.expected.frozenHead], {
    cwd: published.candidate.releaseRoot, windowsHide: true, encoding: null,
  })).stdout;
  const candidatePatchId = String(await gitWithInput(published.candidate.releaseRoot,
    ["patch-id", "--stable"], candidateDiff)).trim().split(/\s+/u)[0];
  const candidateParents = (await git(published.candidate.releaseRoot, "show", "-s", "--format=%P",
    published.expected.frozenHead)).split(/\s+/u).filter(Boolean);
  const publishedRequest = failedFrozenRequest(published, "recover-published-reviewed-origin");
  await assert.rejects(published.service.recoverFreezingPublicationCandidate({
    ...publishedRequest,
    expected: { ...publishedRequest.expected,
      reviewedOriginMain: published.expected.frozenHead,
      reviewedOriginParent: candidateParents[0],
      reviewedOriginTree: published.expected.frozenTree,
      reviewedOriginDiffSha256: sha256(candidateDiff),
      reviewedOriginDiffHashObject: String(await gitWithInput(published.candidate.releaseRoot,
        ["hash-object", "--stdin"], candidateDiff)).trim(),
      reviewedOriginPatchId: candidatePatchId,
      releaseTrackingOriginMain: published.baseCommit,
      originUrlSha256: sha256(await git(published.candidate.releaseRoot, "remote", "get-url", "origin")),
    },
  }), /candidate acquired a foreign publication effect/u);
});

test("fresh failed frozen admission rejects unknown stages and reached effect stages", async (context) => {
  const unknown = await failedFrozenFixture(context);
  unknown.run.steps.push({ label: "Unknown future publisher stage", status: "pending" });
  unknown.run.identity.labels.push("Unknown future publisher stage");
  const unknownBytes = Buffer.from(`${JSON.stringify(unknown.run, null, 2)}\n`, "utf8");
  await writeFile(unknown.runFile, unknownBytes);
  await assert.rejects(unknown.service.recoverFreezingPublicationCandidate({
    ...failedFrozenRequest(unknown, "unknown-stage"),
    expected: { ...unknown.frozenExpected, publicationRunSha256: sha256(unknownBytes) },
  }), /unknown or incomplete publication stage contract/u);

  const effect = await failedFrozenFixture(context);
  effect.run.steps[2].status = "completed";
  const effectBytes = Buffer.from(`${JSON.stringify(effect.run, null, 2)}\n`, "utf8");
  await writeFile(effect.runFile, effectBytes);
  await assert.rejects(effect.service.recoverFreezingPublicationCandidate({
    ...failedFrozenRequest(effect, "reached-effect-stage"),
    expected: { ...effect.frozenExpected, publicationRunSha256: sha256(effectBytes) },
  }), /publication effect or ambiguous stage evidence/u);
});

test("fresh failed frozen admission requires the canonical attached main checkout", async (context) => {
  const setup = await failedFrozenFixture(context);
  await git(setup.candidate.releaseRoot, "checkout", "--detach", setup.expected.frozenHead);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate(
    failedFrozenRequest(setup, "detached-fresh-frozen"),
  ), /refs or checkout changed/u);
  const checkpoint = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  assert.equal(checkpoint.phase, "frozen");
  assert.equal(checkpoint.recovery, undefined);
});

test("admitted failed frozen recovery preserves and rechecks the exact publication log", async (context) => {
  let stopAtIntent = true;
  const setup = await failedFrozenFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent" && stopAtIntent) {
        stopAtIntent = false;
        throw new Error("stop before publication log drift");
      }
    },
  });
  const request = failedFrozenRequest(setup, "recover-failed-frozen-log-drift");
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /stop before publication log drift/u);
  const admitted = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  const evidence = JSON.parse(await readFile(admitted.recovery.evidenceFile, "utf8"));
  assert.equal(sha256(Buffer.from(evidence.publicationLogBytesBase64, "base64")),
    setup.frozenExpected.publicationLogSha256);
  await writeFile(setup.run.logFile, "tampered terminal publication log\n", "utf8");
  await assert.rejects(new ReleaseGitWorkspaceService({
    dataDir: setup.dataDir, environment: setup.environment,
  }).recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /durable external evidence changed after admission/u);
  assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.expected.frozenHead);
});

for (const crashPhase of ["detached", "main", "refs", "checkout", "completed"]) {
  test(`admitted failed frozen recovery resumes after exact Git boundary ${crashPhase}`, async (context) => {
    let interrupt = true;
    const setup = await failedFrozenFixture(context, {
      recoveryPhase: async (phase) => {
        if (phase === crashPhase && interrupt) {
          interrupt = false;
          throw new Error(`simulated failed-frozen ${crashPhase} interruption`);
        }
      },
    });
    const request = failedFrozenRequest(setup, `recover-failed-frozen-${crashPhase}`);
    const preview = await setup.service.recoverFreezingPublicationCandidate(request);
    await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    }), new RegExp(`simulated failed-frozen ${crashPhase} interruption`, "u"));
    const resumed = await new ReleaseGitWorkspaceService({
      dataDir: setup.dataDir, environment: setup.environment,
    }).recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    });
    assert.equal(resumed.status, "abandoned");
    assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.baseCommit);
    assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "PreRelease"), setup.expected.preparedHead);
  });
}

test("new owner resumes and replays an admitted legacy freezing recovery", async (context) => {
  let stopAtIntent = true;
  const setup = await interruptedFreezeFixture(context, {
    recoveryPhase: async (phase) => {
      if (phase === "intent" && stopAtIntent) {
        stopAtIntent = false;
        throw new Error("convert admitted operation to legacy schema");
      }
    },
  });
  const request = {
    projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId: "recover-legacy-admitted",
    sourceIdentity: RECOVERY_SOURCE, expected: setup.expected,
  };
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /convert admitted operation to legacy schema/u);
  const checkpoint = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  const evidence = JSON.parse(await readFile(checkpoint.recovery.evidenceFile, "utf8"));
  const {
    proofHash: ignoredProof, sourceCheckpointBytesBase64, sourceManifestBytesBase64,
    sourceCheckpoint, sourceManifest, publicationState, publicationRun, publicationCheckpoint,
    ...identity
  } = evidence;
  identity.schemaVersion = 1;
  delete identity.trackingOriginMain;
  delete identity.originUrlSha256;
  identity.publicationStateSha256 = recoveryHash(publicationState.repositories[0]);
  const legacyProof = recoveryHash(identity);
  const legacyEvidence = {
    ...identity, proofHash: legacyProof, sourceCheckpointBytesBase64, sourceManifestBytesBase64,
    sourceCheckpoint, sourceManifest, publicationState, publicationRun, publicationCheckpoint,
  };
  const legacyEvidenceBytes = Buffer.from(`${JSON.stringify(legacyEvidence, null, 2)}\n`, "utf8");
  await writeFile(checkpoint.recovery.evidenceFile, legacyEvidenceBytes);
  checkpoint.recovery = {
    operationId: request.requestId, proofHash: legacyProof,
    evidenceFile: checkpoint.recovery.evidenceFile, evidenceSha256: sha256(legacyEvidenceBytes),
    sourceIdentity: RECOVERY_SOURCE, sourceCheckpointSha256: identity.sourceCheckpointSha256,
    sourceManifestSha256: identity.sourceManifestSha256, oldMain: identity.oldMain,
    oldPreRelease: identity.oldPreRelease, frozenHead: identity.frozenHead, frozenTree: identity.frozenTree,
  };
  await writeFile(setup.checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
  const service = new ReleaseGitWorkspaceService({ dataDir: setup.dataDir, environment: setup.environment });
  const completed = await service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: legacyProof,
  });
  assert.equal(completed.status, "abandoned");
  const repeated = await service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: legacyProof,
  });
  assert.equal(repeated.status, "abandoned");
  assert.equal(repeated.reused, true);
});

test("freezing recovery previews exact proof and abandons with preserved evidence", async (context) => {
  const setup = await interruptedFreezeFixture(context);
  const request = {
    projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId: "recover-one",
    sourceIdentity: RECOVERY_SOURCE, expected: setup.expected,
  };
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  assert.equal(preview.status, "preview");
  assert.deepEqual(preview.effects, [
    `refs/heads/main:${setup.expected.frozenHead}->${setup.baseCommit}`,
    `refs/heads/PreRelease:${setup.expected.frozenHead}->${setup.expected.preparedHead}`,
    `checkout:refs/heads/PreRelease@${setup.expected.preparedHead}`,
  ]);
  assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.expected.frozenHead);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request,
    sourceIdentity: { commit: "e".repeat(40), ownerSha256: "f".repeat(64) },
    confirm: true,
    expectedProofHash: preview.proofHash,
  }), /confirmation proof changed/u);
  const completed = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(completed.status, "abandoned");
  assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.baseCommit);
  assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "PreRelease"), setup.expected.preparedHead);
  assert.equal(await git(setup.candidate.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/PreRelease");
  assert.equal(await git(setup.candidate.releaseRoot, "status", "--porcelain=v1"), "");
  const finalCheckpoint = JSON.parse(await readFile(setup.checkpointFile, "utf8"));
  assert.equal(finalCheckpoint.phase, "abandoned");
  assert.equal(finalCheckpoint.recovery.proofHash, preview.proofHash);
  assert.equal((await stat(finalCheckpoint.recovery.evidenceFile)).isFile(), true);
  assert.equal((await stat(path.join(setup.dataDir, "release-repositories", taskRepositoryKey(setup.primary),
    "evidence", `${setup.expected.manifestHash}.json`))).isFile(), true);
  assert.equal(await git(setup.candidate.releaseRoot, "cat-file", "-t", setup.expected.frozenHead), "commit");
  const stateRoot = path.join(setup.environment.LOCALAPPDATA, "AgentHub");
  await writeFile(path.join(stateRoot, "publication-state.json"), `${JSON.stringify({ repositories: [{
    root: setup.primary, revision: "f".repeat(40),
  }] }, null, 2)}\n`);
  await writeFile(path.join(stateRoot, "publication-status.json"), `${JSON.stringify({
    version: 2, status: "running", identity: { planRevision: setup.expected.planRevision },
  }, null, 2)}\n`);
  const reused = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(reused.reused, true);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, requestId: "recover-other",
  }), /belongs to another exact operation/u);
});

for (const crashPhase of [
  "evidence-temporary", "evidence", "intent", "detached", "main", "refs", "prepared-detached", "checkout", "completed",
]) {
  test(`freezing recovery resumes the same operation after ${crashPhase}`, async (context) => {
    let interrupt = true;
    const setup = await interruptedFreezeFixture(context, {
      recoveryPhase: async (phase) => {
        if (phase === crashPhase && interrupt) {
          interrupt = false;
          throw new Error(`simulated ${crashPhase} interruption`);
        }
      },
    });
    const request = {
      projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId: `recover-${crashPhase}`,
      sourceIdentity: RECOVERY_SOURCE, expected: setup.expected,
    };
    const preview = await setup.service.recoverFreezingPublicationCandidate(request);
    await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    }), new RegExp(`simulated ${crashPhase} interruption`, "u"));
    if (crashPhase === "evidence") {
      const foreignRequest = { ...request, requestId: "recover-foreign-after-evidence" };
      const foreignPreview = await setup.service.recoverFreezingPublicationCandidate(foreignRequest);
      await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
        ...foreignRequest, confirm: true, expectedProofHash: foreignPreview.proofHash,
      }), /evidence conflicts with the exact operation/u);
    }
    const resumedService = new ReleaseGitWorkspaceService({ dataDir: setup.dataDir, environment: setup.environment });
    const resumed = await resumedService.recoverFreezingPublicationCandidate({
      ...request, confirm: true, expectedProofHash: preview.proofHash,
    });
    assert.equal(resumed.status, "abandoned");
    assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.baseCommit);
    assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "PreRelease"), setup.expected.preparedHead);
  });
}

test("freezing recovery removes a partial temporary evidence write and retries exactly", async (context) => {
  let interruptWrite = true;
  const setup = await interruptedFreezeFixture(context, {
    recoveryEvidenceWrite: async (handle, value) => {
      if (interruptWrite) {
        interruptWrite = false;
        await handle.writeFile(value.slice(0, Math.floor(value.length / 2)), "utf8");
        await handle.sync();
        throw new Error("simulated partial evidence write");
      }
      await handle.writeFile(value, "utf8");
    },
  });
  const request = {
    projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId: "recover-partial-evidence",
    sourceIdentity: RECOVERY_SOURCE, expected: setup.expected,
  };
  const preview = await setup.service.recoverFreezingPublicationCandidate(request);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  }), /simulated partial evidence write/u);
  const evidenceRoot = path.join(setup.dataDir, "release-repositories", taskRepositoryKey(setup.primary), "evidence");
  assert.equal((await readdir(evidenceRoot)).some((file) => file.startsWith(".freeze-recovery-")), false);
  assert.equal((await readdir(evidenceRoot)).some((file) => file.startsWith("freeze-recovery-")), false);
  const completed = await setup.service.recoverFreezingPublicationCandidate({
    ...request, confirm: true, expectedProofHash: preview.proofHash,
  });
  assert.equal(completed.status, "abandoned");
});

test("freezing recovery rejects drift and publication evidence before effects", async (context) => {
  const setup = await interruptedFreezeFixture(context);
  const request = {
    projectRoot: setup.primary, workspaceId: "workspace-recovery", requestId: "recover-drift",
    sourceIdentity: RECOVERY_SOURCE, expected: setup.expected,
  };
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate({
    ...request, expected: { ...setup.expected, approvedOriginMain: "a".repeat(40) },
  }), /approved origin main changed/u);
  const statusFile = path.join(setup.environment.LOCALAPPDATA, "AgentHub", "publication-status.json");
  await writeFile(statusFile, `${JSON.stringify({ version: 2, status: "running", identity: {} }, null, 2)}\n`);
  await assert.rejects(setup.service.recoverFreezingPublicationCandidate(request), /active or ambiguous publication run/u);
  assert.equal(await git(setup.candidate.releaseRoot, "rev-parse", "main"), setup.expected.frozenHead);
});

test("abandoned freeze rebuild preserves reviewed incoming base and composes the fixed publisher Task", async (context) => {
  const setup = await fixture(context);
  const environment = { ...process.env, LOCALAPPDATA: path.join(setup.root, "state") };
  await setup.service.prepareCandidate({
    planRevision: "1".repeat(64), projectRoot: setup.primary, workspaceId: "workspace-rebuild",
    approvedBaseCommit: setup.baseCommit, frozenTasks: [],
  });
  const incomingRoot = path.join(setup.root, "incoming");
  await git(setup.root, "clone", setup.origin, incomingRoot);
  await git(incomingRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(incomingRoot, "incoming.txt"), "approved incoming\n");
  const incomingCommit = await commit(incomingRoot, "approved incoming main");
  await git(incomingRoot, "push", "origin", "main");
  await git(setup.primary, "fetch", "origin", "main");
  const initialPlan = "2".repeat(64);
  const provenance = {
    schemaVersion: 1, kind: "explicit-reviewed-main-v1",
    publishedBaseCommit: setup.baseCommit,
    approvedLocalMainCommit: setup.baseCommit,
    approvedOriginMainCommit: incomingCommit,
  };
  const prepared = await setup.service.prepareCandidate({
    planRevision: initialPlan, projectRoot: setup.primary, workspaceId: "workspace-rebuild",
    approvedBaseCommit: incomingCommit, baseProvenance: provenance, frozenTasks: [],
  });
  const changelog = Buffer.from("# incoming release\n", "utf8");
  await writeFile(path.join(prepared.releaseRoot, "CHANGELOG.md"), changelog);
  await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace-rebuild", expectedPlanRevision: initialPlan,
    expectedPreparedHead: prepared.preReleaseHead, changelogContent: changelog,
    releaseDate: new Date("2026-09-21T00:00:00Z"),
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", taskRepositoryKey(setup.primary), "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
  checkpoint.phase = "freezing";
  await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);
  const stateFile = path.join(environment.LOCALAPPDATA, "AgentHub", "publication-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({ repositories: [{ root: setup.primary, revision: setup.baseCommit }] }, null, 2)}\n`);
  const recovery = new ReleaseGitWorkspaceService({ dataDir: setup.dataDir, environment });
  const request = {
    projectRoot: setup.primary, workspaceId: "workspace-rebuild", requestId: "recover-before-rebuild",
    sourceIdentity: RECOVERY_SOURCE,
    expected: {
      planRevision: initialPlan, manifestHash: checkpoint.manifestHash,
      preparedHead: checkpoint.publicationFreeze.preparedHead, frozenHead: checkpoint.preReleaseHead,
      frozenTree: await git(prepared.releaseRoot, "rev-parse", `${checkpoint.preReleaseHead}^{tree}`),
      publishedRevision: setup.baseCommit, approvedOriginMain: incomingCommit,
    },
  };
  const preview = await recovery.recoverFreezingPublicationCandidate(request);
  await recovery.recoverFreezingPublicationCandidate({ ...request, confirm: true, expectedProofHash: preview.proofHash });

  const taskRoot = path.join(setup.root, "task-HUB-256");
  await git(setup.primary, "worktree", "add", "-b", "HUB-256-rebuild", taskRoot, incomingCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  const helperFile = path.join(taskRoot, "AgentHub", "src", "infrastructure", "filesystem", "freeze-publication-candidate.mjs");
  const publisherFile = path.join(taskRoot, "AgentHub", "publish-changed.mjs");
  await mkdir(path.dirname(helperFile), { recursive: true });
  await writeFile(helperFile, "export const persistedPayloadOwner = 'HUB-256';\n");
  await writeFile(publisherFile,
    "import { persistedPayloadOwner } from './src/infrastructure/filesystem/freeze-publication-candidate.mjs';\n"
    + "export const freezeOwnerReadback = () => persistedPayloadOwner;\n");
  const hub256Result = await commit(taskRoot, "HUB-256 fixed public publisher");
  const rebuilt = await recovery.prepareCandidate({
    planRevision: "3".repeat(64), projectRoot: setup.primary, workspaceId: "workspace-rebuild",
    approvedBaseCommit: incomingCommit, baseProvenance: provenance,
    frozenTasks: [{ taskId: "HUB-256", taskRevision: 6, resultCommit: hub256Result }],
  });
  const rebuiltManifest = JSON.parse(await readFile(rebuilt.manifestFile, "utf8"));
  assert.deepEqual(rebuiltManifest.tasks.map((task) => task.taskId), ["HUB-256"]);
  assert.equal(await git(rebuilt.releaseRoot, "show", `${rebuilt.preReleaseHead}:incoming.txt`), "approved incoming");
  const rebuiltPublisherFile = path.join(rebuilt.releaseRoot, "AgentHub", "publish-changed.mjs");
  const publisher = await import(`${pathToFileURL(rebuiltPublisherFile).href}?fixture=${Date.now()}`);
  assert.equal(publisher.freezeOwnerReadback(), "HUB-256");
  assert.equal(await git(rebuilt.releaseRoot, "rev-parse", "main"), setup.baseCommit);
  assert.equal(await git(setup.origin, "rev-parse", "main"), incomingCommit);
});

test("frozen candidate readback validates prepared manifest identity and request binding", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-readback",
    workspaceId: "workspace-1",
    preflightRequestId: "preflight-readback-1",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-readback", taskRevision: 3, baseCommit: setup.baseCommit, resultCommit,
    }],
  });

  const readback = await setup.service.frozenCandidate(setup.primary);

  assert.equal(readback.checkpointPhase, "prepared");
  assert.equal(readback.planRevision, "plan-readback");
  assert.equal(readback.preReleaseHead, candidate.preReleaseHead);
  assert.equal(readback.preflightRequestId, "preflight-readback-1");
  assert.equal(readback.manifest.workspaceId, "workspace-1");
  assert.equal(readback.manifest.preflightRequestId, "preflight-readback-1");
  assert.deepEqual(readback.manifest.taskIds, ["task-readback"]);
  assert.deepEqual(readback.manifest.tasks, [{
    taskId: "task-readback",
    taskRevision: 3,
    baseCommit: setup.baseCommit,
    resultCommit,
  }]);

  const mergeHeadFile = await git(candidate.releaseRoot, "rev-parse", "--git-path", "MERGE_HEAD");
  const mergePath = path.resolve(candidate.releaseRoot, mergeHeadFile);
  await writeFile(mergePath, `${resultCommit}\n`, "utf8");
  await assert.rejects(() => setup.service.frozenCandidate(setup.primary), /unfinished Git operation: MERGE_HEAD/u);
  await rm(mergePath);
  const rebasePath = path.resolve(candidate.releaseRoot, await git(candidate.releaseRoot, "rev-parse", "--git-path", "rebase-merge"));
  await mkdir(rebasePath);
  await assert.rejects(() => setup.service.frozenCandidate(setup.primary), /unfinished Git operation: rebase-merge/u);
  await rm(rebasePath, { recursive: true });
  assert.equal((await setup.service.frozenCandidate(setup.primary)).preReleaseHead, candidate.preReleaseHead);

  const checkpointBefore = JSON.parse(await readFile(readback.checkpointFile, "utf8"));
  await writeFile(readback.checkpointFile, `${JSON.stringify({
    ...checkpointBefore,
    preflightRequestId: "different-request",
  }, null, 2)}\n`, "utf8");
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /request identity disagrees/u,
  );
  await writeFile(readback.checkpointFile, `${JSON.stringify(checkpointBefore, null, 2)}\n`, "utf8");

  await writeFile(candidate.manifestFile, "{}\n", "utf8");
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /manifest digest changed/u,
  );
});

test("request-bound prepared checkpoint is not usable after the final primary guard fails", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    branch: "HUB-final-guard",
    file: "guard.txt",
    content: "guard\n",
  });

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-final-guard",
      workspaceId: "workspace-probe",
      preflightRequestId: "request-probe",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-guard", taskRevision: 4, resultCommit }],
      validateBeforeCommit: async () => {
        await git(setup.primary, "checkout", "--detach", setup.baseCommit);
      },
    }),
    /HEAD must remain attached to refs\/heads\/main/u,
  );

  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
  await assert.rejects(
    () => setup.service.frozenCandidate(setup.primary),
    /HEAD must remain attached to refs\/heads\/main/u,
  );
});

test("main review discloses every commit since the last successful publication", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "AgentHub", "external.mjs"), "export const external = true;\n", "utf8");
  await git(setup.primary, "add", "AgentHub/external.mjs");
  await git(setup.primary,
    "-c", "user.name=External Author",
    "-c", "user.email=12345+external-user@users.noreply.github.com",
    "commit", "-m", "external runtime change");
  const externalCommit = await git(setup.primary, "rev-parse", "HEAD");
  await git(setup.primary, "push", "origin", "main");

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
  });

  assert.equal(pending.localMain, externalCommit);
  assert.equal(pending.originMain, externalCommit);
  assert.equal(pending.approvalRequired, true);
  assert.equal(pending.commits.length, 1);
  assert.equal(pending.commits[0].commit, externalCommit);
  assert.equal(pending.commits[0].author.githubLogin, "external-user");
  assert.equal(pending.commits[0].committer.githubLogin, "external-user");
  assert.deepEqual(pending.commits[0].files, ["AgentHub/external.mjs"]);
  assert.deepEqual(pending.commits[0].impact, ["runtime"]);

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
    approvedLocalMainCommit: externalCommit,
    approvedOriginMainCommit: externalCommit,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
});

test("main review preserves an old dirty primary while auditing newer origin main", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "local-only.txt"), "local\n", "utf8");
  const localCommit = await commit(setup.primary, "local main preserved");
  const remoteWriter = path.join(setup.root, "remote-writer");
  await git(setup.root, "clone", setup.origin, remoteWriter);
  context.after(() => rm(remoteWriter, { recursive: true, force: true }));
  await writeFile(path.join(remoteWriter, "remote-only.txt"), "remote\n", "utf8");
  const originCommit = await commit(remoteWriter, "origin main advanced");
  await git(remoteWriter, "push", "origin", "main");
  const dirtyBytes = Buffer.from("local synthetic access remains dirty\n", "utf8");
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), dirtyBytes);
  const before = {
    head: await git(setup.primary, "rev-parse", "HEAD"),
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
  });

  assert.equal(pending.localMain, localCommit);
  assert.equal(pending.originMain, originCommit);
  assert.equal(pending.diverged, true);
  assert.equal(pending.approvalRequired, true);
  assert.deepEqual(pending.commits.map((item) => item.commit).sort(), [localCommit, originCommit].sort());

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision: setup.baseCommit,
    approvedLocalMainCommit: localCommit,
    approvedOriginMainCommit: originCommit,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), before.access);
});

test("main review accepts a preserved old primary when the published revision is newer origin main", async (context) => {
  const setup = await fixture(context);
  const localCommit = await git(setup.primary, "rev-parse", "HEAD");
  const remoteWriter = path.join(setup.root, "bookworm-origin-writer");
  await git(setup.root, "clone", setup.origin, remoteWriter);
  context.after(() => rm(remoteWriter, { recursive: true, force: true }));
  await writeFile(path.join(remoteWriter, "app.txt"), "published newer origin\n", "utf8");
  const publishedRevision = await commit(remoteWriter, "published revision newer than primary");
  await git(remoteWriter, "push", "origin", "main");
  await writeFile(path.join(setup.primary, "app.txt"), "old primary dirty bytes\n", "utf8");
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), "dirty access bytes\n", "utf8");
  const before = {
    head: await git(setup.primary, "rev-parse", "HEAD"),
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    app: await readFile(path.join(setup.primary, "app.txt")),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };

  const pending = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
  });

  assert.equal(pending.localMain, localCommit);
  assert.equal(pending.originMain, publishedRevision);
  assert.equal(pending.diverged, true);
  assert.equal(pending.localContainsPublished, false);
  assert.equal(pending.publishedContainsLocal, true);
  assert.equal(pending.originContainsPublished, true);
  assert.equal(pending.approvalRequired, true);
  assert.ok(pending.commits.some((item) => item.commit === publishedRevision && item.inLocalMain === false));

  const stale = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
    approvedLocalMainCommit: publishedRevision,
    approvedOriginMainCommit: publishedRevision,
  });
  assert.equal(stale.approvalRequired, true);

  const approved = await setup.service.inspectMainChanges({
    projectRoot: setup.primary,
    publishedRevision,
    approvedLocalMainCommit: localCommit,
    approvedOriginMainCommit: publishedRevision,
  });
  assert.equal(approved.approved, true);
  assert.equal(approved.approvalRequired, false);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), before.head);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), before.branch);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), before.status);
  assert.deepEqual(await readFile(path.join(setup.primary, "app.txt")), before.app);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), before.access);
});

test("release candidate aggregates effective dev deltas instead of replaying conflicting Task snapshots", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-effective-1", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-effective-2", file: "app.txt", content: "second\n",
  });
  const devRoot = path.join(setup.root, "dev-effective");
  await git(setup.primary, "worktree", "add", "-b", "dev-effective", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", firstResult);
  const firstIntegration = await git(devRoot, "rev-parse", "HEAD");
  await assert.rejects(
    git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "merge", "--no-ff", "--no-edit", secondResult),
  );
  await writeFile(path.join(devRoot, "app.txt"), "first + second\n", "utf8");
  await git(devRoot, "add", "app.txt");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--no-edit");
  const secondIntegration = await git(devRoot, "rev-parse", "HEAD");

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-effective-deltas",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-effective-1",
      taskRevision: 4,
      resultCommit: firstResult,
      integrations: [{ commit: firstIntegration, parent: setup.baseCommit, order: 1 }],
    }, {
      taskId: "task-effective-2",
      taskRevision: 6,
      resultCommit: secondResult,
      integrations: [{ commit: secondIntegration, parent: firstIntegration, order: 2 }],
    }],
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`), "first + second");
  assert.equal((await git(candidate.releaseRoot, "show", "-s", "--format=%P", candidate.preReleaseHead)).split(" ").length, 3);
});

test("release candidate three-way applies an Await delta over a later non-overlapping main change", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-base\n", "utf8");
  const taskBase = await commit(setup.primary, "task base");
  await git(setup.primary, "push", "origin", "main");
  const taskRoot = path.join(setup.root, "task-three-way");
  const devRoot = path.join(setup.root, "dev-three-way");
  await git(setup.primary, "worktree", "add", "-b", "HUB-three-way", taskRoot, taskBase);
  await git(setup.primary, "worktree", "add", "-b", "dev-three-way", devRoot, taskBase);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", taskRoot).catch(() => {}));
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await writeFile(path.join(taskRoot, "app.txt"), "task-change\nstable\nmain-base\n", "utf8");
  const resultCommit = await commit(taskRoot, "task change");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", resultCommit);
  const integrationCommit = await git(devRoot, "rev-parse", "HEAD");
  await writeFile(path.join(setup.primary, "app.txt"), "task-base\nstable\nmain-change\n", "utf8");
  await commit(setup.primary, "main advances independently");
  await git(setup.primary, "push", "origin", "main");

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-three-way",
    projectRoot: setup.primary,
    frozenTasks: [{
      taskId: "task-three-way",
      taskRevision: 8,
      resultCommit,
      integrations: [{ commit: integrationCommit, parent: taskBase, order: 1 }],
    }],
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:app.txt`),
    "task-change\nstable\nmain-change");
});

test("failed PreRelease rebuild preserves the last good branch and checkpoint", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, {
    branch: "HUB-atomic-first", file: "app.txt", content: "first\n",
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-atomic-second", file: "app.txt", content: "second\n",
  });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-atomic-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", path.basename(path.dirname(first.releaseRoot)), "checkpoint.json");
  const checkpointBefore = JSON.parse(await readFile(checkpointFile, "utf8"));

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-atomic-conflict",
      projectRoot: setup.primary,
      frozenTasks: [
        { taskId: "task-first", taskRevision: 2, resultCommit: firstResult },
        { taskId: "task-second", taskRevision: 3, resultCommit: secondResult },
      ],
    }),
    /PreRelease delta/u,
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
  assert.deepEqual(JSON.parse(await readFile(checkpointFile, "utf8")), checkpointBefore);
});

test("candidate validation failure cannot replace the last good PreRelease", async (context) => {
  const setup = await fixture(context);
  const firstResult = await taskResult(setup, context, { branch: "HUB-cas-first" });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-cas-first",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit: firstResult }],
  });
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-cas-second", file: "second.txt", content: "second\n",
  });

  await assert.rejects(
    () => setup.service.prepareCandidate({
      planRevision: "plan-cas-stale",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-second", taskRevision: 4, resultCommit: secondResult }],
      validateBeforeCommit: async () => { throw new Error("release plan revision changed"); },
    }),
    /release plan revision changed/u,
  );

  assert.equal(await git(first.releaseRoot, "rev-parse", "refs/heads/PreRelease"), first.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "PreRelease");
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
});

test("automatic Await preparation preserves frozen evidence after push until finalization", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, { branch: "HUB-frozen-automatic" });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-frozen-automatic", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit }],
  });
  await writeFile(path.join(first.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-frozen-automatic",
    expectedPreparedHead: first.preReleaseHead, changelogContent: Buffer.from("release\n"),
  });
  const checkpointFile = path.join(path.dirname(first.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  const secondResult = await taskResult(setup, context, {
    branch: "HUB-next-automatic", file: "next.txt", content: "next\n",
  });
  const request = {
    planRevision: "plan-next-automatic", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-next", taskRevision: 2, resultCommit: secondResult }],
    preserveFrozen: true,
  };
  await assert.rejects(setup.service.prepareCandidate(request), { code: "RELEASE_CANDIDATE_FROZEN" });
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "main");
  assert.equal((await setup.service.frozenCandidate(setup.primary)).preReleaseHead, frozen.preReleaseHead);

  await git(first.releaseRoot, "push", "origin", "main");
  await assert.rejects(setup.service.prepareCandidate(request), { code: "RELEASE_CANDIDATE_FROZEN" });
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  await setup.service.synchronizePublishedPrimary({
    projectRoot: setup.primary, publishedRevision: frozen.preReleaseHead,
    planRevision: "plan-frozen-automatic",
  });
  const next = await setup.service.prepareCandidate(request);
  assert.equal(next.baseCommit, frozen.preReleaseHead);
  assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:next.txt`), "next");
  assert.equal(await git(next.releaseRoot, "show", `${next.preReleaseHead}:feature.txt`), "feature");
  assert.equal((await setup.service.frozenCandidate(setup.primary)).checkpointPhase, "prepared");
});

test("failed explicit composition restores the exact frozen checkout and readable checkpoint", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, { branch: "HUB-frozen-restore" });
  const first = await setup.service.prepareCandidate({
    planRevision: "plan-frozen-restore", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-first", taskRevision: 2, resultCommit }],
  });
  await writeFile(path.join(first.releaseRoot, "CHANGELOG.md"), "release\n");
  const frozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-frozen-restore",
    expectedPreparedHead: first.preReleaseHead, changelogContent: Buffer.from("release\n"),
  });
  const checkpointFile = path.join(path.dirname(first.releaseRoot), "checkpoint.json");
  const checkpointBefore = await readFile(checkpointFile, "utf8");
  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-rejected", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [], validateBeforeCommit: () => { throw new Error("membership changed"); },
  }), /membership changed/u);
  assert.equal(await readFile(checkpointFile, "utf8"), checkpointBefore);
  assert.equal(await git(first.releaseRoot, "branch", "--show-current"), "main");
  assert.equal(await git(first.releaseRoot, "rev-parse", "HEAD"), frozen.preReleaseHead);
  assert.equal(await git(first.releaseRoot, "status", "--porcelain=v1"), "");
  assert.equal((await setup.service.frozenCandidate(setup.primary)).checkpointPhase, "frozen");
});

test("release contour resolves the exact clean main from a real managed clone without a dev checkout", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    file: "AgentHub/release-only.mjs",
    content: "export const releaseOnly = true;\n",
  });
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-release-contour",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-release-contour", taskRevision: 2, resultCommit }],
  });
  const releaseHead = await publishCandidate(candidate);
  const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
  const contourRoot = path.join(setup.root, "release-contour");

  const asserted = await assertReleaseCandidateContourSource({ sourceRoot });
  const resolved = await resolveTestContourSource({
    root: contourRoot,
    sourceRoot,
    sourceKind: TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE,
    prepareSource: async () => assert.fail("release contour must not prepare a dev checkout"),
  });

  assert.equal(asserted.branch, "main");
  assert.equal(asserted.headCommit, releaseHead);
  assert.equal(resolved.kind, TEST_CONTOUR_RELEASE_CANDIDATE_SOURCE);
  assert.equal(resolved.branch, "main");
  assert.equal(resolved.headCommit, releaseHead);
  assert.equal(path.resolve(resolved.sourceRoot), path.resolve(sourceRoot));
  await assert.rejects(stat(path.join(contourRoot, "task-git")), { code: "ENOENT" });
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), "");
});

test("release contour fails closed for dirty or non-main managed clone state", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-release-contour-guard",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-release-contour-guard", taskRevision: 2, resultCommit }],
  });
  const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
  await assert.rejects(
    assertReleaseCandidateContourSource({ sourceRoot }),
    /must be attached to main/u,
  );
  await publishCandidate(candidate);
  await writeFile(path.join(sourceRoot, "dirty.mjs"), "export {};\n", "utf8");
  await assert.rejects(
    assertReleaseCandidateContourSource({ sourceRoot }),
    /must be clean/u,
  );
});

test("an unmarked repository at the managed clone path is never adopted", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);

  await assert.rejects(
    setup.service.prepareCandidate({
      planRevision: "plan-unmarked",
      projectRoot: setup.primary,
      frozenTasks: [{ taskId: "task-unmarked", taskRevision: 2, resultCommit }],
    }),
    /unmarked release repository requires explicit migration/u,
  );
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), setup.baseCommit);
});

test("startup audits a detached registered primary and linked holder with an empty data directory", async (context) => {
  const setup = await fixture(context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  await git(setup.primary, "checkout", "--detach", setup.baseCommit);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-1",
      registrationSource: "runtime_default",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].workspaceId, "workspace-1");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /attached to refs\/heads\/main/u);
  assert.equal(reconciliation.repositories[0].primary.branch, null);
  assert.ok(reconciliation.repositories[0].primary.legacyLinkedHolders.some(
    (item) => path.resolve(item.path) === path.resolve(legacyRoot),
  ));
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  await assert.rejects(stat(path.join(setup.dataDir, "release-repositories")), { code: "ENOENT" });
});

test("startup counts a registered runtime root even when it is not a Git repository", async (context) => {
  const setup = await fixture(context);
  const runtimeRoot = path.join(setup.root, "runtime-default-project");
  await mkdir(runtimeRoot, { recursive: true });

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-runtime-default",
      registrationSource: "runtime_default",
      projectRoot: runtimeRoot,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].source, "registered_workspace");
  assert.equal(reconciliation.repositories[0].registrationSource, "runtime_default");
  assert.equal(reconciliation.repositories[0].projectRoot, runtimeRoot);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.match(reconciliation.repositories[0].reason, /not a git repository/u);
});

test("startup rejects an orphan unmarked clone at the exact managed release path", async (context) => {
  const setup = await fixture(context);
  const releaseRoot = path.join(
    setup.dataDir,
    "release-repositories",
    taskRepositoryKey(setup.primary),
    "repository",
  );
  await mkdir(path.dirname(releaseRoot), { recursive: true });
  await git(path.dirname(releaseRoot), "clone", "--no-checkout", setup.primary, releaseRoot);
  const primaryBefore = {
    branch: await git(setup.primary, "symbolic-ref", "HEAD"),
    head: await git(setup.primary, "rev-parse", "HEAD"),
    status: await git(setup.primary, "status", "--porcelain=v1"),
    team: await readFile(path.join(setup.primary, ".team", "participant.json")),
    access: await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")),
  };
  const orphanBefore = {
    head: await git(releaseRoot, "rev-parse", "HEAD"),
    status: await git(releaseRoot, "status", "--porcelain=v1"),
  };

  const reconciliation = await setup.service.reconcile({
    projectRoots: [{
      workspaceId: "workspace-orphan-clone",
      registrationSource: "workspace_setting",
      projectRoot: setup.primary,
    }],
  });

  assert.equal(reconciliation.checked, 1);
  assert.equal(reconciliation.registeredWorkspaceRoots, 1);
  assert.equal(reconciliation.checkpointCount, 0);
  assert.equal(reconciliation.repositories[0].status, "manual_required");
  assert.equal(reconciliation.repositories[0].releaseRoot, releaseRoot);
  assert.equal(reconciliation.repositories[0].checkpointPresent, false);
  assert.match(reconciliation.repositories[0].reason, /orphan managed release repository/u);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), primaryBefore.branch);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), primaryBefore.head);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), primaryBefore.status);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), primaryBefore.team);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), primaryBefore.access);
  assert.equal(await git(releaseRoot, "rev-parse", "HEAD"), orphanBefore.head);
  assert.equal(await git(releaseRoot, "status", "--porcelain=v1"), orphanBefore.status);
  await assert.rejects(stat(path.join(path.dirname(releaseRoot), "checkpoint.json")), { code: "ENOENT" });
});

test("dirty primary bytes, retry checkpoint and legacy linked holder remain untouched", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const legacyRoot = path.join(setup.root, "legacy-prerelease-holder");
  await git(setup.primary, "worktree", "add", "-b", "PreRelease", legacyRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", legacyRoot).catch(() => {}));
  const teamBytes = Buffer.from("team-intentional-local\r\n", "utf8");
  const accessBytes = Buffer.from("access-intentional-local\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), teamBytes);
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), accessBytes);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");
  const request = {
    planRevision: "plan-dirty-retry",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-dirty", taskRevision: 2, resultCommit }],
  };

  const first = await setup.service.prepareCandidate(request);
  const retry = await setup.service.prepareCandidate(request);

  assert.equal(retry.reused, true);
  assert.equal(retry.preReleaseHead, first.preReleaseHead);
  assert.equal(retry.manifestHash, first.manifestHash);
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), teamBytes);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), accessBytes);
  assert.ok(first.legacyLinkedHolders.some((item) => path.resolve(item.path) === path.resolve(legacyRoot)));
  assert.match(await git(setup.primary, "worktree", "list", "--porcelain"), /legacy-prerelease-holder/u);
  const manifest = JSON.parse(await readFile(first.manifestFile, "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.tasks[0].taskId, "task-dirty");
  assert.equal(manifest.tasks[0].resultCommit, resultCommit);
  assert.equal(manifest.tasks[0].integrations.length, 1);
});

test("post-release fast-forward preserves non-overlapping intentional local bytes", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-sync",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-sync", taskRevision: 2, resultCommit }],
  });
  const teamBytes = Buffer.from("team-still-local\r\n", "utf8");
  const accessBytes = Buffer.from("access-still-local\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), teamBytes);
  await writeFile(path.join(setup.primary, "1C_ACCESS", "access.json"), accessBytes);
  const publishedRevision = await publishCandidate(candidate);

  const synchronized = await setup.service.synchronizePublishedPrimary({
    projectRoot: setup.primary,
    publishedRevision,
    planRevision: "plan-sync",
  });

  assert.equal(synchronized.status, "fast_forwarded");
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), publishedRevision);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), teamBytes);
  assert.deepEqual(await readFile(path.join(setup.primary, "1C_ACCESS", "access.json")), accessBytes);
  assert.deepEqual(synchronized.dirtyPathsPreserved, [".team/participant.json", "1C_ACCESS/access.json"]);
});

test("post-release overlap is diagnostic and leaves primary HEAD and bytes unchanged", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context, {
    branch: "HUB-126-conflict",
    file: ".team/participant.json",
    content: "published-team\n",
  });
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-conflict",
    projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-conflict", taskRevision: 2, resultCommit }],
  });
  const localBytes = Buffer.from("local-team-must-win\r\n", "utf8");
  await writeFile(path.join(setup.primary, ".team", "participant.json"), localBytes);
  const beforeHead = await git(setup.primary, "rev-parse", "HEAD");
  const beforeStatus = await git(setup.primary, "status", "--porcelain=v1");
  const publishedRevision = await publishCandidate(candidate);

  const synchronized = await setup.service.synchronizePublishedPrimary({
    projectRoot: setup.primary,
    publishedRevision,
    planRevision: "plan-conflict",
  });

  assert.equal(synchronized.status, "manual_required");
  assert.deepEqual(synchronized.conflicts, [".team/participant.json"]);
  assert.equal(await git(setup.primary, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(setup.primary, "rev-parse", "HEAD"), beforeHead);
  assert.equal(await git(setup.primary, "status", "--porcelain=v1"), beforeStatus);
  assert.deepEqual(await readFile(path.join(setup.primary, ".team", "participant.json")), localBytes);
});

// HUB-204: выбранная зависимость входит ровно один раз, невыбранная не входит.
async function dependencyFixture(setup, context, { selectDependency }) {
  const depRoot = path.join(setup.root, "task-dependency");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependency", depRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", depRoot).catch(() => {}));
  await writeFile(path.join(depRoot, "dependency.txt"), "dependency\n", "utf8");
  const dependencyResult = await commit(depRoot, "dependency");

  // Задача Б ветвится от результата А, поэтому содержит её коммит в своей истории.
  const dependentRoot = path.join(setup.root, "task-dependent");
  await git(setup.primary, "worktree", "add", "-b", "HUB-dependent", dependentRoot, dependencyResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", dependentRoot).catch(() => {}));
  await writeFile(path.join(dependentRoot, "dependent.txt"), "dependent\n", "utf8");
  const dependentResult = await commit(dependentRoot, "dependent");

  const devRoot = path.join(setup.root, "dev-dependency");
  await git(setup.primary, "worktree", "add", "-b", "dev-dependency", devRoot, "main");
  context.after(() => git(setup.primary, "worktree", "remove", "--force", devRoot).catch(() => {}));
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  const dependencyIntegration = await git(devRoot, "rev-parse", "HEAD");
  await git(devRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependentResult);
  const dependentIntegration = await git(devRoot, "rev-parse", "HEAD");

  const dependencyTask = {
    taskId: "task-dependency",
    taskRevision: 2,
    baseCommit: setup.baseCommit,
    resultCommit: dependencyResult,
    integrations: [{ commit: dependencyIntegration, parent: setup.baseCommit, order: 1 }],
  };
  const dependentTask = {
    taskId: "task-dependent",
    taskRevision: 3,
    baseCommit: dependencyResult,
    resultCommit: dependentResult,
    integrations: [{ commit: dependentIntegration, parent: dependencyIntegration, order: 2 }],
  };
  return { frozenTasks: selectDependency ? [dependencyTask, dependentTask] : [dependentTask] };
}

test("selected dependency and its dependent Task are each included exactly once", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: true });

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-dependency-selected",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependency.txt`), "dependency");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["dependency.txt", "dependent.txt"]);
});

test("real nested Task evidence projects the selected dependency once before its dependent changes", async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "projection.txt"), "slot=base\n", "utf8");
  setup.baseCommit = await commit(setup.primary, "projection base");
  await git(setup.primary, "push", "origin", "main");

  const dependencyId = "20000000-0000-0000-0000-000000000003";
  const dependentId = "20000000-0000-0000-0000-000000000004";
  const releaseOwnerId = "20000000-0000-0000-0000-000000000016";
  const dependency = await registeredTaskBranch(setup, context, {
    taskId: dependencyId,
    startCommit: setup.baseCommit,
  });
  await writeFile(path.join(dependency.taskRoot, "projection.txt"), "slot=dependency\n", "utf8");
  const dependencyResult = await commit(dependency.taskRoot, "selected dependency");

  const dependent = await registeredTaskBranch(setup, context, {
    taskId: dependentId,
    startCommit: dependencyResult,
    baseCommit: dependencyResult,
  });
  await writeFile(path.join(dependent.taskRoot, "dependent.txt"), "dependent\n", "utf8");
  const dependentResult = await commit(dependent.taskRoot, "selected dependent");

  const taskGit = new TaskGitWorkspaceService({ dataDir: setup.dataDir });
  const dev = await taskGit.prepareDev(setup.primary);
  await writeFile(path.join(dev.projectRoot, "projection.txt"), "slot=dependency\n", "utf8");
  await writeFile(path.join(dev.projectRoot, "foreign.txt"), "must-not-release\n", "utf8");
  await commit(dev.projectRoot, "equivalent dependency with foreign context");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependencyResult);
  const dependencyIntegration = await git(dev.projectRoot, "rev-parse", "HEAD");
  assert.equal(await git(dev.projectRoot, "diff", `${dependencyIntegration}^1`, dependencyIntegration), "");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", dependentResult);

  const releaseOwnerBase = await git(dev.projectRoot, "rev-parse", "HEAD");
  const releaseOwner = await registeredTaskBranch(setup, context, {
    taskId: releaseOwnerId,
    startCommit: releaseOwnerBase,
    baseCommit: releaseOwnerBase,
  });
  await writeFile(path.join(releaseOwner.taskRoot, "projection.txt"), "slot=release-owner\n", "utf8");
  await writeFile(path.join(releaseOwner.taskRoot, "release-owner.txt"), "release-owner\n", "utf8");
  const releaseOwnerResult = await commit(releaseOwner.taskRoot, "dependent release owner");
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", releaseOwnerResult);

  const tasks = [
    { taskId: dependencyId, taskRevision: 3, projectRoot: setup.primary,
      branch: dependency.branch, resultCommit: dependencyResult },
    { taskId: dependentId, taskRevision: 4, projectRoot: setup.primary,
      branch: dependent.branch, resultCommit: dependentResult },
    { taskId: releaseOwnerId, taskRevision: 16, projectRoot: setup.primary,
      branch: releaseOwner.branch, resultCommit: releaseOwnerResult },
  ];
  const evidence = await taskGit.releaseIntegrationEvidence({ projectRoot: setup.primary, tasks });
  const selectedDependency = evidence.tasks.find((task) => task.taskId === dependencyId);
  const selectedDependent = evidence.tasks.find((task) => task.taskId === dependentId);
  assert.deepEqual(selectedDependency.integrations.map((item) => item.commit), [dependencyIntegration]);
  assert.equal(selectedDependent.integrations.some((item) => item.commit === dependencyIntegration), false);

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-real-nested-evidence",
    projectRoot: setup.primary,
    frozenTasks: evidence.tasks,
  });
  assert.deepEqual(candidate.netProjectedTaskIds, [dependencyId]);
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:projection.txt`),
    "slot=release-owner");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:release-owner.txt`),
    "release-owner");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:foreign.txt`));
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, ["dependent.txt", "projection.txt", "release-owner.txt"]);

  const withoutDependency = await taskGit.releaseIntegrationEvidence({
    projectRoot: setup.primary,
    tasks: tasks.filter((task) => task.taskId !== dependencyId),
  });
  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-real-nested-evidence-without-dependency",
    projectRoot: setup.primary,
    frozenTasks: withoutDependency.tasks,
  }), new RegExp(`failed for Task ${releaseOwnerId}`, "u"));
});

test("incomparable selected Tasks cannot claim one shared dev integration", async (context) => {
  const setup = await fixture(context);
  const sharedRoot = path.join(setup.root, "task-shared-lineage");
  await git(setup.primary, "worktree", "add", "-b", "shared-lineage", sharedRoot, setup.baseCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", sharedRoot).catch(() => {}));
  await writeFile(path.join(sharedRoot, "shared.txt"), "shared\n", "utf8");
  const sharedCommit = await commit(sharedRoot, "shared ancestor");

  const leftId = "30000000-0000-0000-0000-000000000001";
  const rightId = "30000000-0000-0000-0000-000000000002";
  const left = await registeredTaskBranch(setup, context, { taskId: leftId, startCommit: sharedCommit });
  const right = await registeredTaskBranch(setup, context, { taskId: rightId, startCommit: sharedCommit });
  await writeFile(path.join(left.taskRoot, "left.txt"), "left\n", "utf8");
  await writeFile(path.join(right.taskRoot, "right.txt"), "right\n", "utf8");
  const leftResult = await commit(left.taskRoot, "left result");
  const rightResult = await commit(right.taskRoot, "right result");

  const taskGit = new TaskGitWorkspaceService({ dataDir: setup.dataDir });
  const dev = await taskGit.prepareDev(setup.primary);
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", sharedCommit);
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", leftResult);
  await git(dev.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", rightResult);

  await assert.rejects(taskGit.releaseIntegrationEvidence({
    projectRoot: setup.primary,
    tasks: [
      { taskId: leftId, taskRevision: 1, projectRoot: setup.primary,
        branch: left.branch, resultCommit: leftResult },
      { taskId: rightId, taskRevision: 1, projectRoot: setup.primary,
        branch: right.branch, resultCommit: rightResult },
    ],
  }), /ambiguously owned/u);
});

test("an unselected dependency never reaches the release through its dependent Task", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: false });

  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-dependency-excluded",
    projectRoot: setup.primary,
    frozenTasks: scenario.frozenTasks,
  });

  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependent.txt`), "dependent");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.preReleaseHead}:dependency.txt`));
  const names = (await git(candidate.releaseRoot, "diff", "--name-only",
    setup.baseCommit, candidate.preReleaseHead)).split("\n").filter(Boolean);
  assert.deepEqual(names, ["dependent.txt"]);
});

test("repeated publication freeze reuses the accepted PreRelease without rebuilding or losing composition", async (context) => {
  const setup = await fixture(context);
  const scenario = await dependencyFixture(setup, context, { selectDependency: true });

  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-reuse",
    projectRoot: setup.primary,
    workspaceId: "workspace",
    frozenTasks: scenario.frozenTasks,
  });
  const changelogContent = Buffer.from("consolidated\n");
  await writeFile(path.join(accepted.releaseRoot, "CHANGELOG.md"), changelogContent);
  const freeze = (options = {}) => setup.service.freezePublicationCandidate({
    projectRoot: setup.primary,
    workspaceId: "workspace",
    expectedPlanRevision: "plan-reuse",
    expectedPreparedHead: accepted.preReleaseHead,
    changelogContent,
    ...options,
  });

  const frozen = await freeze();
  const refrozen = await freeze({
    validateBeforeCommit: () => assert.fail("a repeated freeze must not revalidate or rebuild the accepted release"),
  });

  assert.equal(frozen.phase, "frozen");
  assert.equal(frozen.reused, false);
  assert.equal(refrozen.reused, true);
  assert.equal(refrozen.preReleaseHead, frozen.preReleaseHead);
  assert.equal(refrozen.manifestHash, frozen.manifestHash);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "main"), frozen.preReleaseHead);
  const frozenReadback = await setup.service.frozenCandidate(setup.primary);
  assert.equal(frozenReadback.checkpointPhase, "frozen");
  assert.equal(frozenReadback.preReleaseHead, frozen.preReleaseHead);
  assert.equal(await git(accepted.releaseRoot, "symbolic-ref", "HEAD"), "refs/heads/main");
  assert.equal(await git(accepted.releaseRoot, "show", `${refrozen.preReleaseHead}:dependency.txt`), "dependency");
  assert.equal(await git(accepted.releaseRoot, "show", `${refrozen.preReleaseHead}:dependent.txt`), "dependent");
  const names = (await git(accepted.releaseRoot, "diff", "--name-only",
    setup.baseCommit, refrozen.preReleaseHead)).split("\n").filter(Boolean).sort();
  assert.deepEqual(names, [
    "AgentHub/package-lock.json", "AgentHub/package.json", "CHANGELOG.md", "dependency.txt", "dependent.txt",
  ]);
});

test("frozen candidate readback is phase-aware and feeds release completion without reattaching HEAD", async (context) => {
  const setup = await fixture(context);
  const resultCommit = await taskResult(setup, context);
  const candidate = await setup.service.prepareCandidate({
    planRevision: "plan-frozen-readback", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [{ taskId: "task-frozen", taskRevision: 1, resultCommit }],
  });
  const frozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-frozen-readback",
    expectedPreparedHead: candidate.preReleaseHead, changelogContent: null,
    releaseDate: new Date(2026, 8, 13),
  });
  const checkpointFile = path.join(setup.dataDir, "release-repositories", taskRepositoryKey(setup.primary), "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));

  await writeFile(path.join(candidate.releaseRoot, "dirty.txt"), "dirty\n");
  await assert.rejects(setup.service.frozenCandidate(setup.primary), /exact clean main checkout/u);
  await rm(path.join(candidate.releaseRoot, "dirty.txt"));
  await git(candidate.releaseRoot, "symbolic-ref", "HEAD", "refs/heads/PreRelease");
  await assert.rejects(setup.service.frozenCandidate(setup.primary), /exact clean main checkout/u);
  await git(candidate.releaseRoot, "symbolic-ref", "HEAD", "refs/heads/main");
  await git(candidate.releaseRoot, "update-ref", "refs/heads/PreRelease", setup.baseCommit, frozen.preReleaseHead);
  await assert.rejects(setup.service.frozenCandidate(setup.primary), /PreRelease branch no longer matches/u);
  await git(candidate.releaseRoot, "update-ref", "refs/heads/PreRelease", frozen.preReleaseHead, setup.baseCommit);
  await git(candidate.releaseRoot, "update-ref", "refs/heads/main", setup.baseCommit, frozen.preReleaseHead);
  await assert.rejects(setup.service.frozenCandidate(setup.primary), /main branch no longer matches/u);
  await git(candidate.releaseRoot, "update-ref", "refs/heads/main", frozen.preReleaseHead, setup.baseCommit);
  await writeFile(checkpointFile, `${JSON.stringify({ ...checkpoint, phase: "freezing" }, null, 2)}\n`);
  await assert.rejects(setup.service.frozenCandidate(setup.primary), /phase is not readable/u);
  await writeFile(checkpointFile, `${JSON.stringify(checkpoint, null, 2)}\n`);

  const plan = {
    revision: "plan-frozen-readback", ready: [{ id: "task-frozen" }], draft: [], blocked: [], conflicts: [],
    candidates: [{ gitReferences: [{ projectRoot: setup.primary, resultCommit }] }],
  };
  let pending = null;
  const release = new WorkspaceReleaseService({
    store: createTaskBoardMutationOwner({
      runMutation: (operation) => Promise.resolve().then(operation),
      awaitRebuildPending: () => structuredClone(pending),
      releaseFinalizationOutcome: () => null,
      completeRelease: (_workspaceId, options) => {
        pending = structuredClone(options.awaitRebuild);
        return { released: plan.ready };
      },
      recordReleaseFinalizationStage: (_workspaceId, { stage, projectRoot, receipt }) => {
        if (stage === "await") pending.awaitResult = structuredClone(receipt);
        else pending.repositories.find((item) => item.projectRoot === projectRoot)[stage] = structuredClone(receipt);
      },
      clearAwaitRebuildPending: () => { pending = null; return true; },
    }),
    releasePlanner: { plan: async () => plan },
    releaseGitWorkspaces: {
      frozenCandidate: (root) => setup.service.frozenCandidate(root),
      synchronizePublishedPrimary: async ({ publishedRevision }) => ({ status: "fast_forwarded", publishedRevision }),
    },
    taskGitWorkspaces: { synchronizeMainIntoDev: async () => ({ integrated: true, status: "merged" }) },
    releasePreflight: { withAwaitTransition: async (_workspaceId, operation) => operation() },
    verifyPublication: async () => ({
      repositories: [{ root: setup.primary, revision: frozen.preReleaseHead,
        planRevision: plan.revision, manifestHash: frozen.manifestHash,
        baseCommit: setup.baseCommit, preReleaseHead: frozen.preReleaseHead }],
      agentHubPublication: { generation: "generation" },
    }),
  });
  const completed = await release.completeRelease({
    workspaceId: "workspace", expectedPlanRevision: plan.revision,
    expectedRepositories: [{ projectRoot: setup.primary, revision: frozen.preReleaseHead }],
    deploymentVerified: true, verificationSummary: "verified",
  });
  assert.equal(completed.finalization.status, "completed");
  assert.equal(pending, null);
});

test("a frozen 13-Task candidate accepts one descendant result delta without foreign baggage", { timeout: 60000 }, async (context) => {
  const setup = await fixture(context);
  await writeFile(path.join(setup.primary, "CHANGELOG.md"), "previous\n", "utf8");
  setup.baseCommit = await commit(setup.primary, "release base");
  await git(setup.primary, "push", "origin", "main");

  const ownerRoot = path.join(setup.root, "task-release-owner");
  await git(setup.primary, "worktree", "add", "-b", "HUB-release-owner", ownerRoot, setup.baseCommit);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", ownerRoot).catch(() => {}));
  await mkdir(path.join(ownerRoot, "AgentHub", "assets", "web-app", "themes", "bestiary"), { recursive: true });
  await mkdir(path.join(ownerRoot, "AgentHub", "docs"), { recursive: true });
  await writeFile(path.join(ownerRoot, "AgentHub", "assets", "web-app", "themes", "bestiary", "theme.css"), "foreign\n");
  await writeFile(path.join(ownerRoot, "AgentHub", "docs", "recording-contour.md"), "foreign\n");
  const foreignContext = await commit(ownerRoot, "unselected integrated context");
  await writeFile(path.join(ownerRoot, "AgentHub", "selected-owner.txt"), "accepted\n");
  const oldResult = await commit(ownerRoot, "accepted release owner");

  const otherTasks = [];
  for (let index = 1; index < 13; index += 1) {
    const resultCommit = await taskResult(setup, context, {
      branch: `HUB-selected-${index}`,
      file: `AgentHub/selected-${index}.txt`,
      content: `selected-${index}\n`,
    });
    otherTasks.push({ taskId: `selected-${String(index).padStart(2, "0")}`, taskRevision: 1, resultCommit });
  }
  const ownerTask = {
    taskId: "selected-13",
    taskRevision: 33,
    baseCommit: setup.baseCommit,
    resultCommit: oldResult,
    integrations: [{ commit: oldResult, parent: foreignContext, order: 13 }],
  };
  const firstTasks = [...otherTasks, ownerTask];
  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-13-old", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: firstTasks,
  });
  await assert.rejects(git(accepted.releaseRoot, "show", `${accepted.preReleaseHead}:AgentHub/assets/web-app/themes/bestiary/theme.css`));
  await assert.rejects(git(accepted.releaseRoot, "show", `${accepted.preReleaseHead}:AgentHub/docs/recording-contour.md`));
  await writeFile(path.join(accepted.releaseRoot, "CHANGELOG.md"), "release 13\n", "utf8");
  const frozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-13-old",
    expectedPreparedHead: accepted.preReleaseHead, changelogContent: Buffer.from("release 13\n"),
    releaseDate: new Date(2026, 8, 13, 23, 59),
  });

  await writeFile(path.join(ownerRoot, "AgentHub", "release-refresh.txt"), "reviewed fix\n");
  const newResult = await commit(ownerRoot, "reviewed successor");
  const refreshedTasks = firstTasks.map((task) => task.taskId === ownerTask.taskId
    ? { ...task, taskRevision: 41, resultCommit: newResult }
    : { ...task, taskRevision: task.taskRevision + 1 });
  const checkpointFile = path.join(path.dirname(path.dirname(accepted.manifestFile)), "checkpoint.json");
  const frozenCheckpoint = await readFile(checkpointFile, "utf8");
  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-13-stale", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: refreshedTasks,
    validateBeforeCommit: async () => { throw new Error("selected plan changed before candidate CAS"); },
  }), /selected plan changed before candidate CAS/u);
  assert.equal(await git(frozen.releaseRoot, "rev-parse", "PreRelease"), frozen.preReleaseHead);
  assert.equal(
    await readFile(checkpointFile, "utf8"),
    frozenCheckpoint,
  );
  const refreshed = await setup.service.prepareCandidate({
    planRevision: "plan-13-new", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: refreshedTasks,
  });
  const manifest = JSON.parse(await readFile(refreshed.manifestFile, "utf8"));
  assert.equal(manifest.tasks.length, 13);
  assert.equal(manifest.candidateReuse.policy, "selected-result-successor-v1");
  assert.equal(manifest.candidateReuse.sourceHead, frozen.preReleaseHead);
  assert.equal(manifest.candidateReuse.priorResultCommit, oldResult);
  assert.equal(manifest.candidateReuse.resultCommit, newResult);
  assert.equal(manifest.tasks.find((task) => task.taskId === ownerTask.taskId).taskRevision, 41);
  await assert.doesNotReject(git(
    refreshed.releaseRoot, "merge-base", "--is-ancestor", newResult, refreshed.preReleaseHead,
  ));
  assert.deepEqual((await git(refreshed.releaseRoot, "diff", "--name-only", frozen.preReleaseHead, refreshed.preReleaseHead))
    .split("\n").filter(Boolean), ["AgentHub/release-refresh.txt"]);
  assert.equal(await git(refreshed.releaseRoot, "show", `${refreshed.preReleaseHead}:CHANGELOG.md`), "release 13");
  await assert.rejects(git(refreshed.releaseRoot, "show", `${refreshed.preReleaseHead}:AgentHub/assets/web-app/themes/bestiary/theme.css`));
  await assert.rejects(git(refreshed.releaseRoot, "show", `${refreshed.preReleaseHead}:AgentHub/docs/recording-contour.md`));

  const refrozen = await setup.service.freezePublicationCandidate({
    projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-13-new",
    expectedPreparedHead: refreshed.preReleaseHead, changelogContent: Buffer.from("release 13\n"),
    releaseDate: new Date(2026, 8, 13, 23, 59),
  });
  await rm(path.join(ownerRoot, "AgentHub", "selected-owner.txt"));
  const revertedResult = await commit(ownerRoot, "accepted change to revert");
  const revertedTasks = refreshedTasks.map((task) => task.taskId === ownerTask.taskId
    ? { ...task, taskRevision: 42, resultCommit: revertedResult }
    : task);
  const reverted = await setup.service.prepareCandidate({
    planRevision: "plan-13-revert", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: revertedTasks,
  });
  assert.equal(JSON.parse(await readFile(reverted.manifestFile, "utf8")).candidateReuse.sourceHead,
    refrozen.preReleaseHead);
  await assert.doesNotReject(git(
    reverted.releaseRoot, "merge-base", "--is-ancestor", revertedResult, reverted.preReleaseHead,
  ));
  await assert.rejects(git(reverted.releaseRoot, "show", `${reverted.preReleaseHead}:AgentHub/selected-owner.txt`));
  assert.equal(await git(reverted.releaseRoot, "show", `${reverted.preReleaseHead}:AgentHub/release-refresh.txt`),
    "reviewed fix");
});

test("prepared candidate reuses one newly selected correction from its snapshot parent", { timeout: 30000 }, async (context) => {
  const setup = await fixture(context);
  const staleResult = await taskResult(setup, context, {
    branch: "HUB-correction-stale", file: "AgentHub/shared.txt", content: "stale\n",
  });
  const staleTask = {
    taskId: "task-stale", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: staleResult,
    integrations: [{ commit: staleResult, parent: setup.baseCommit, order: 1 }],
  };
  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-correction-old", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask],
  });
  const correctionRoot = path.join(setup.root, "task-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-correction", correctionRoot, staleResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "shared.txt"), "fixed\n");
  const correctionResult = await commit(correctionRoot, "exact correction");
  const correctionTask = {
    taskId: "task-correction", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [{ commit: correctionResult, parent: staleResult, order: 2 }],
  };
  const refreshed = await setup.service.prepareCandidate({
    planRevision: "plan-correction-new", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask, correctionTask],
  });
  const manifest = JSON.parse(await readFile(refreshed.manifestFile, "utf8"));
  assert.equal(manifest.candidateReuse.policy, "selected-correction-addition-v1");
  assert.equal(manifest.candidateReuse.sourceHead, accepted.preReleaseHead);
  assert.equal(manifest.candidateReuse.correctionBaseCommit, staleResult);
  assert.equal(manifest.candidateReuse.resultCommit, correctionResult);
  assert.equal(await git(refreshed.releaseRoot, "show", `${refreshed.preReleaseHead}:AgentHub/shared.txt`), "fixed");
  assert.deepEqual((await git(refreshed.releaseRoot, "diff", "--name-only", accepted.preReleaseHead,
    refreshed.preReleaseHead)).split("\n").filter(Boolean), ["AgentHub/shared.txt"]);
});

test("operation lineage rejects an unrelated result and accepts a descendant net correction", { timeout: 30000 }, async (context) => {
  const setup = await fixture(context);
  const neighborResult = await taskResult(setup, context, {
    branch: "HUB-lineage-neighbor", file: "AgentHub/neighbor.txt", content: "neighbor\n",
  });
  const oldResult = await taskResult(setup, context, {
    branch: "HUB-lineage-old", file: "AgentHub/selected.txt", content: "obsolete-r1\n",
  });
  const unrelatedResult = await taskResult(setup, context, {
    branch: "HUB-lineage-unrelated", file: "AgentHub/selected.txt", content: "unrelated-r2\n",
  });
  const neighborTask = {
    taskId: "task-neighbor", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: neighborResult,
    integrations: [{ commit: neighborResult, parent: setup.baseCommit, order: 1 }],
  };
  const unrelatedTask = {
    taskId: "task-owner", taskRevision: 2, baseCommit: setup.baseCommit, resultCommit: unrelatedResult,
    integrations: [{ commit: unrelatedResult, parent: setup.baseCommit, order: 2 }],
  };
  const unrelatedCandidate = await setup.service.prepareCandidate({
    planRevision: "plan-lineage-unrelated", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [neighborTask, unrelatedTask],
  });
  await assert.rejects(setup.service.assertSelectedResultLineage({
    candidate: unrelatedCandidate,
    previousSelectedResults: [{ taskId: "task-owner", resultCommit: oldResult }],
  }), (error) => {
    assert.equal(error.code, "RELEASE_RESULT_LINEAGE_MISMATCH");
    assert.equal(error.taskId, "task-owner");
    assert.equal(error.priorResultCommit, oldResult);
    assert.equal(error.resultCommit, unrelatedResult);
    return true;
  });

  const correctionRoot = path.join(setup.root, "task-lineage-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-lineage-correction", correctionRoot, oldResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "selected.txt"), "corrected-r2\n", "utf8");
  const correctionResult = await commit(correctionRoot, "descendant correction");
  const correctionTask = {
    taskId: "task-owner", taskRevision: 3, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [
      { commit: oldResult, parent: setup.baseCommit, order: 1 },
      { commit: correctionResult, parent: oldResult, order: 2 },
    ],
  };
  const correctedCandidate = await setup.service.prepareCandidate({
    planRevision: "plan-lineage-corrected", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [neighborTask, correctionTask],
  });
  await assert.doesNotReject(setup.service.assertSelectedResultLineage({
    candidate: correctedCandidate,
    previousSelectedResults: [{ taskId: "task-owner", resultCommit: oldResult }],
  }));
  const corrected = await git(
    correctedCandidate.releaseRoot, "show", `${correctedCandidate.preReleaseHead}:AgentHub/selected.txt`,
  );
  assert.equal(corrected, "corrected-r2");
  assert.equal(corrected.includes("obsolete-r1"), false);
  assert.equal(await git(
    correctedCandidate.releaseRoot, "show", `${correctedCandidate.preReleaseHead}:AgentHub/neighbor.txt`,
  ), "neighbor");
});

test("prepared candidate rejects correction-owned publication metadata", { timeout: 30000 }, async (context) => {
  const setup = await fixture(context);
  const staleResult = await taskResult(setup, context, {
    branch: "HUB-metadata-stale", file: "AgentHub/shared.txt", content: "stale\n",
  });
  const staleTask = {
    taskId: "task-stale", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: staleResult,
    integrations: [{ commit: staleResult, parent: setup.baseCommit, order: 1 }],
  };
  const accepted = await setup.service.prepareCandidate({
    planRevision: "plan-metadata-old", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask],
  });
  const correctionRoot = path.join(setup.root, "task-metadata-correction");
  await git(setup.primary, "worktree", "add", "-b", "HUB-metadata-correction", correctionRoot, staleResult);
  context.after(() => git(setup.primary, "worktree", "remove", "--force", correctionRoot).catch(() => {}));
  await writeFile(path.join(correctionRoot, "AgentHub", "package.json"), "{\"version\":\"forbidden\"}\n");
  const correctionResult = await commit(correctionRoot, "forbidden release metadata correction");
  const correctionTask = {
    taskId: "task-correction", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: correctionResult,
    integrations: [{ commit: correctionResult, parent: staleResult, order: 2 }],
  };
  await assert.rejects(setup.service.prepareCandidate({
    planRevision: "plan-metadata-new", workspaceId: "workspace", projectRoot: setup.primary,
    frozenTasks: [staleTask, correctionTask],
  }), /selected correction cannot change publication metadata: AgentHub\/package\.json/);
  assert.equal(await git(accepted.releaseRoot, "rev-parse", "PreRelease"), accepted.preReleaseHead);
});

for (const scenario of ["changed selection", "changed base", "non-descendant result"]) {
  test(`frozen candidate reuse rejects ${scenario}`, { timeout: 30000 }, async (context) => {
    const setup = await fixture(context);
    const ownerRoot = path.join(setup.root, "task-reuse-owner");
    await git(setup.primary, "worktree", "add", "-b", "HUB-reuse-owner", ownerRoot, setup.baseCommit);
    context.after(() => git(setup.primary, "worktree", "remove", "--force", ownerRoot).catch(() => {}));
    await writeFile(path.join(ownerRoot, "owner.txt"), "old\n");
    const oldResult = await commit(ownerRoot, "old result");
    const oldTask = {
      taskId: "task-owner", taskRevision: 1, baseCommit: setup.baseCommit, resultCommit: oldResult,
      integrations: [{ commit: oldResult, parent: setup.baseCommit, order: 1 }],
    };
    const accepted = await setup.service.prepareCandidate({
      planRevision: "plan-old", workspaceId: "workspace", projectRoot: setup.primary, frozenTasks: [oldTask],
    });
    await setup.service.freezePublicationCandidate({
      projectRoot: setup.primary, workspaceId: "workspace", expectedPlanRevision: "plan-old",
      expectedPreparedHead: accepted.preReleaseHead, changelogContent: null,
      releaseDate: new Date(2026, 8, 13),
    });

    let tasks;
    if (scenario === "non-descendant result") {
      const sibling = await taskResult(setup, context, {
        branch: "HUB-reuse-sibling", file: "owner.txt", content: "sibling\n",
      });
      tasks = [{ ...oldTask, taskRevision: 2, resultCommit: sibling,
        integrations: [{ commit: sibling, parent: setup.baseCommit, order: 1 }] }];
    } else {
      await writeFile(path.join(ownerRoot, "owner.txt"), "new\n");
      const successor = await commit(ownerRoot, "successor result");
      tasks = [{ ...oldTask, taskRevision: 2, resultCommit: successor,
        integrations: [...oldTask.integrations, { commit: successor, parent: oldResult, order: 2 }] }];
      if (scenario === "changed selection") {
        const added = await taskResult(setup, context, {
          branch: "HUB-reuse-added", file: "added.txt", content: "added\n",
        });
        tasks.push({ taskId: "task-added", taskRevision: 1, baseCommit: setup.baseCommit,
          resultCommit: added, integrations: [{ commit: added, parent: setup.baseCommit, order: 3 }] });
      } else {
        await writeFile(path.join(setup.primary, "main-new.txt"), "new base\n");
        setup.baseCommit = await commit(setup.primary, "new release base");
        await git(setup.primary, "push", "origin", "main");
      }
    }

    const candidate = await setup.service.prepareCandidate({
      planRevision: `plan-${scenario.replaceAll(" ", "-")}`,
      workspaceId: "workspace", projectRoot: setup.primary, frozenTasks: tasks,
    });
    const manifest = JSON.parse(await readFile(candidate.manifestFile, "utf8"));
    assert.equal(manifest.candidateReuse, undefined);
    assert.equal(manifest.projectionPolicy, "task-net-ancestry-v2");
  });
}
