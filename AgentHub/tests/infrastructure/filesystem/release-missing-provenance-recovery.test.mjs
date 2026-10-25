import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createMissingProvenanceResolver } from "../../../src/application/release-missing-provenance-resolver.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { canonicalPath } from "../../../src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import {
  PUBLICATION_STAGE_CONTRACT,
  publicationRunPaths,
  publicationRunStore,
} from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { retainLegacyPreparedCandidate } from "../../fixtures/legacy-release-candidate-fixture.mjs";

// Real isolated Git + SQLite + public recovery composition for the release11
// shape: a legacy frozen candidate on an adopted upstream base whose manifest
// and checkpoint both lack base provenance, the later approved preflight
// receipt, and the historical immutable selected Task adoption record. The
// real-shape variant then advances the primary and remote to a reviewed child
// while the release clone tracking stays at the historical approved base.

const execFileAsync = promisify(execFile);
const RECOVERY_SOURCE = { commit: "c".repeat(40), ownerSha256: "d".repeat(64) };
const TASK_ID = "57575757-5757-4757-8757-575757575757";
const RECOVERY_KIND = "missing-provenance-recovery-v1";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

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

async function releaseFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = {};
  for (const entry of entries.filter((item) => item.isFile())) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    files[path.relative(root, file)] = sha256(await readFile(file));
  }
  return files;
}

// Exact reviewed-origin-advance identity of `tip` over `approved`, as a
// reviewer computes it from objects; tracking is the release clone's.
async function reviewedAdvance(f, repository, approved, tip) {
  const diff = (await execFileAsync("git", ["diff", "--binary", approved, tip], {
    cwd: repository, windowsHide: true, encoding: null, maxBuffer: 16 * 1024 * 1024,
  })).stdout;
  const parents = (await git(repository, "show", "-s", "--format=%P", tip)).split(/\s+/u).filter(Boolean);
  return {
    reviewedOriginMain: tip,
    reviewedOriginParent: parents.length === 1 ? parents[0] : "0".repeat(40),
    reviewedOriginTree: await git(repository, "rev-parse", `${tip}^{tree}`),
    reviewedOriginDiffSha256: sha256(diff),
    reviewedOriginDiffHashObject: String(await gitWithInput(repository, ["hash-object", "--stdin"], diff)).trim(),
    reviewedOriginPatchId: String(await gitWithInput(repository, ["patch-id", "--stable"], diff)).trim().split(/\s+/u)[0],
    releaseTrackingOriginMain: await git(f.releaseRoot, "rev-parse", "refs/remotes/origin/main^{commit}"),
    originUrlSha256: sha256(await git(f.releaseRoot, "remote", "get-url", "origin")),
  };
}

async function legacyFrozenFixture(context, { advancePrimary = false } = {}) {
  const root = canonicalPath(await mkdtemp(path.join(os.tmpdir(), "ah-missing-provenance-")));
  const state = { catalog: null, tasks: null, resolver: null };
  context.after(async () => {
    state.catalog?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const origin = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(root, "clone", origin, primary);
  await git(primary, "config", "core.autocrlf", "false");
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n", "utf8");
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, "app.txt"), "main\n", "utf8");
  await writeFile(path.join(primary, "CHANGELOG.md"), "# Changelog\n", "utf8");
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub", version: "2026.8.23", packages: { "": { name: "agent-hub", version: "2026.8.23" } },
  }, null, 2)}\n`, "utf8");
  const published = await commit(primary, "published main");
  await git(primary, "push", "-u", "origin", "main");
  const primaryRoot = canonicalPath(primary);
  const releaseData = path.join(root, "release-data");
  const taskData = path.join(root, "task-data");
  const databaseFile = path.join(root, "journal.sqlite");
  const emptyState = { ...process.env, LOCALAPPDATA: path.join(root, "no-state") };
  const stateEnvironment = { ...process.env, LOCALAPPDATA: path.join(root, "state") };
  // Current owner creates only the empty managed clone. Historical evidence
  // below is retained fixture data, not a fresh legacy admission.
  const legacy = new ReleaseGitWorkspaceService({ dataDir: releaseData, environment: emptyState });
  const planRevision = "9".repeat(64);
  state.catalog = await new WorkspaceCatalogStore({ databaseFile }).load();
  const { workspace, stream } = state.catalog.createWorkspaceWithStream({ name: "Release", streamName: "RM" });
  const workspaceId = workspace.id;
  // The managed release clone exists before upstream advances, as in release11.
  const initialCandidate = await legacy.prepareCandidate({
    planRevision: "0".repeat(64), projectRoot: primaryRoot, workspaceId, approvedBaseCommit: published, frozenTasks: [],
  });

  state.tasks = new TaskGitWorkspaceService({ dataDir: taskData });
  const taskWorkspace = await state.tasks.prepare({ taskId: TASK_ID, projectRoot: primaryRoot });
  await writeFile(path.join(taskWorkspace.projectRoot, "task.txt"), "task\n", "utf8");
  const taskCommit = await commit(taskWorkspace.projectRoot, "task result");
  const writer = path.join(root, "upstream-writer");
  await git(root, "clone", origin, writer);
  await git(writer, "config", "core.autocrlf", "false");
  await writeFile(path.join(writer, "CHANGELOG.md"), "# Changelog\n\nreviewed upstream entry\n", "utf8");
  const upstream = await commit(writer, "reviewed upstream");
  await git(writer, "push", "origin", "main");
  await git(taskWorkspace.projectRoot, "fetch", "--no-tags", "origin", "main");
  await git(taskWorkspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "--no-edit", upstream);
  const resultCommit = await git(taskWorkspace.projectRoot, "rev-parse", "HEAD");
  const adoption = await state.tasks.recordExplicitUpstreamAdoption({
    taskId: TASK_ID,
    projectRoot: primaryRoot,
    branch: taskWorkspace.branch,
    taskBaseCommit: published,
    acceptedLocalMainCommit: published,
    adoptedCommit: upstream,
    snapshotCommit: resultCommit,
    requestId: "adopt-upstream-request",
  });
  // The accepted Task delta reaches the candidate through its dev integration.
  const frozenTasks = [{
    taskId: TASK_ID, taskRevision: 4, resultCommit,
    integrations: [{ commit: taskCommit, parent: published, order: 1 }],
  }];

  await git(initialCandidate.releaseRoot, "fetch", "workspace", resultCommit);
  await git(initialCandidate.releaseRoot, "fetch", "origin", "main");
  const prepared = await retainLegacyPreparedCandidate({
    candidate: initialCandidate, planRevision, baseCommit: upstream, tasks: frozenTasks,
    tree: await git(initialCandidate.releaseRoot, "rev-parse", `${resultCommit}^{tree}`),
    parents: [upstream, resultCommit],
  });
  assert.notEqual(prepared.preReleaseHead, upstream);
  assert.equal(await git(prepared.releaseRoot, "show", `${prepared.preReleaseHead}:task.txt`), "task");
  assert.match(await git(prepared.releaseRoot, "show", `${prepared.preReleaseHead}:CHANGELOG.md`), /reviewed upstream entry/u);
  const preparedReadback = await legacy.frozenCandidate(primaryRoot);
  const primarySnapshot = await legacy.assertPrimaryInvariant(primaryRoot, { phase: "fixture" });
  const mainAudit = await legacy.inspectMainChanges({
    projectRoot: primaryRoot, publishedRevision: published,
    approvedLocalMainCommit: published, approvedOriginMainCommit: upstream,
  });
  assert.equal(mainAudit.approved, true);
  assert.equal(mainAudit.approvalRequired, false);
  const changelog = await readFile(path.join(prepared.releaseRoot, "CHANGELOG.md"));
  await legacy.freezePublicationCandidate({
    projectRoot: primaryRoot, workspaceId, expectedPlanRevision: planRevision,
    expectedPreparedHead: prepared.preReleaseHead, changelogContent: changelog,
    releaseDate: new Date("2026-09-23T00:00:00Z"),
  });
  const layoutRoot = path.join(releaseData, "release-repositories", taskRepositoryKey(primaryRoot));
  const checkpointFile = path.join(layoutRoot, "checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointFile, "utf8"));
  assert.equal(checkpoint.phase, "frozen");
  assert.equal(Object.hasOwn(checkpoint, "baseProvenance"), false);

  // Terminal pre-effect publication failure for the frozen candidate.
  const stateRoot = path.join(stateEnvironment.LOCALAPPDATA, "AgentHub");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(path.join(stateRoot, "publication-state.json"), `${JSON.stringify({
    repositories: [{ root: primaryRoot, revision: published }],
  }, null, 2)}\n`, "utf8");
  const labels = PUBLICATION_STAGE_CONTRACT.map((stage) => stage.label);
  const frozenTree = await git(prepared.releaseRoot, "rev-parse", `${checkpoint.preReleaseHead}^{tree}`);
  const identity = {
    mode: "changed", from: "test", revision: checkpoint.preReleaseHead,
    runtimeRoot: path.join(root, "runtime"), worktreeRoot: prepared.releaseRoot,
    validationMode: "full", artifactProtocol: 1, labels,
    release: {
      workspaceId, planRevision, manifestHash: checkpoint.manifestHash, baseCommit: checkpoint.baseCommit,
      preReleaseHead: checkpoint.preReleaseHead, primaryRoot,
    },
  };
  const journal = publicationRunStore({
    environment: stateEnvironment, createId: () => "run-missing-provenance", ownerPid: () => 999999,
    now: (() => {
      let second = 0;
      return () => new Date(Date.UTC(2026, 8, 23, 0, 0, second++));
    })(),
  });
  const publicationCheckpointFile = path.join(stateRoot, "publication-checkpoint.json");
  await assert.rejects(runPublicationSteps(PUBLICATION_STAGE_CONTRACT.map((stage, index) => ({
    label: stage.label, fingerprint: `fixture-${index}`,
  })), {
    run: async ({ label }) => {
      if (label === labels[0]) throw new Error("contour failed before publication effects");
    },
    journal,
    checkpoint: publicationCheckpointStore(publicationCheckpointFile),
    identity,
    checkpointScope: { mode: "changed", from: "test", runtimeRoot: identity.runtimeRoot, validationMode: "full" },
  }), /before publication effects/u);
  await journal.finish("failed", new Error("contour failed before publication effects"));
  const runFile = publicationRunPaths(stateEnvironment).statusFile;
  const run = JSON.parse(await readFile(runFile, "utf8"));
  const publicationCheckpointBytes = await readFile(publicationCheckpointFile).catch((error) => (
    error?.code === "ENOENT" ? null : Promise.reject(error)
  ));

  // Original terminal approved preflight receipt in real SQLite.
  const preflightRequestId = "rm-release-preflight-approved";
  const preflightArguments = {
    workspace_id: workspaceId,
    expected_plan_revision: planRevision,
    conflicts_resolved: true,
    approved_repositories: [{
      projectRoot: primaryRoot, approvedLocalMainCommit: published, approvedOriginMainCommit: upstream,
    }],
    request_id: preflightRequestId,
  };
  const readyResult = (overrides = {}) => ({
    workspaceId,
    planRevision,
    taskIds: [TASK_ID],
    conflictsResolved: true,
    status: "ready",
    mainAudits: [mainAudit],
    primaryRepositories: [primarySnapshot],
    repositories: [{
      projectRoot: primaryRoot, taskIds: [TASK_ID], resultCommits: [resultCommit], frozenTasks,
      worktreeRoot: prepared.releaseRoot, branch: "PreRelease", headCommit: preparedReadback.preReleaseHead,
      frozenCandidate: preparedReadback,
    }],
    releaseCandidates: [{ ...preparedReadback, branch: "PreRelease", frozenTasks, reused: true }],
    ...overrides,
  });
  const caller = { streamId: stream.id, provider: "codex", threadId: "thread-release-manager" };
  const receipt = (requestId, args, result, { tool = "hub_release_preflight", workspace = workspaceId } = {}) => {
    state.catalog.beginMcpOperation({
      requestId, workspaceId: workspace, streamId: caller.streamId, provider: caller.provider,
      threadId: caller.threadId, toolName: tool, argumentsHash: mcpArgumentsHash(args),
    });
    if (result !== undefined) state.catalog.completeMcpOperation(requestId, result);
    return state.catalog.mcpOperationResultEvidence(requestId);
  };
  const original = receipt(preflightRequestId, preflightArguments, readyResult());
  const missingProvenanceRecovery = {
    kind: RECOVERY_KIND,
    preflightRequestId,
    preflightArguments: { ...preflightArguments },
    expectedArgumentsHash: original.argumentsHash,
    expectedResultSha256: original.resultJsonSha256,
    expectedCaller: caller,
    expectedAdoption: { taskId: TASK_ID, recordRef: adoption.recordRef, recordHash: adoption.recordHash },
  };
  const expected = {
    planRevision,
    manifestHash: checkpoint.manifestHash,
    preparedHead: checkpoint.publicationFreeze.preparedHead,
    frozenHead: checkpoint.preReleaseHead,
    frozenTree,
    publishedRevision: published,
    approvedOriginMain: upstream,
    publicationRunId: run.runId,
    publicationRunSha256: sha256(await readFile(runFile)),
    ...(publicationCheckpointBytes
      ? { publicationCheckpointSha256: sha256(publicationCheckpointBytes) }
      : { publicationCheckpointAbsent: true }),
    publicationLogSha256: sha256(await readFile(run.logFile)),
  };
  const reopen = async () => {
    // Durability boundary: a new process sees only persisted SQLite and Git.
    state.catalog.close();
    state.catalog = await new WorkspaceCatalogStore({ databaseFile }).load();
    state.tasks = new TaskGitWorkspaceService({ dataDir: taskData });
    state.resolver = createMissingProvenanceResolver({ workspaceCatalog: state.catalog, taskGitWorkspaces: state.tasks });
  };
  state.resolver = createMissingProvenanceResolver({ workspaceCatalog: state.catalog, taskGitWorkspaces: state.tasks });
  const f = {
    root, origin, writer, primaryRoot, published, upstream, resultCommit, taskCommit, adoption, planRevision,
    workspaceId, caller, receipt, readyResult, preflightArguments, missingProvenanceRecovery, expected,
    checkpointFile, layoutRoot, releaseRoot: prepared.releaseRoot, preparedReadback, legacy,
    stateEnvironment, emptyState, releaseData, frozenTasks, state, reopen,
    originalCheckpointSha256: sha256(await readFile(checkpointFile)),
    get catalog() { return state.catalog; },
    get tasks() { return state.tasks; },
    get resolver() { return state.resolver; },
    service: (options = {}) => new ReleaseGitWorkspaceService({
      dataDir: releaseData, environment: stateEnvironment, ...options,
    }),
    request: (overrides = {}) => ({
      projectRoot: primaryRoot, workspaceId, requestId: "recover-missing-provenance",
      sourceIdentity: RECOVERY_SOURCE, recoveryMode: "abandon-failed-frozen-candidate-v1",
      expected: f.expected, missingProvenanceRecovery, missingProvenanceResolver: state.resolver, ...overrides,
    }),
  };
  if (advancePrimary) {
    // Live release11 shape after 8c67: a reviewed child of the historical
    // approved origin, touching CHANGELOG and TyraelFormat1C_EXPORT, reaches
    // origin and the registered primary (main and its tracking). The release
    // clone is not fetched, so its tracking stays at the approved base.
    await mkdir(path.join(writer, "TyraelFormat1C_EXPORT", "tests"), { recursive: true });
    await writeFile(path.join(writer, "CHANGELOG.md"), "# Changelog\n\nreviewed upstream entry\n\nnext entry\n", "utf8");
    await writeFile(path.join(writer, "TyraelFormat1C_EXPORT", "README.md"), "reserved identifiers\n", "utf8");
    await writeFile(path.join(writer, "TyraelFormat1C_EXPORT", "format.py"), "RESERVED = {'if'}\n", "utf8");
    await writeFile(path.join(writer, "TyraelFormat1C_EXPORT", "tests", "test_reserved.py"), "def test(): pass\n", "utf8");
    f.advanced = await commit(writer, "reviewed diagnostics advance");
    await git(writer, "push", "origin", "main");
    await git(primary, "fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main");
    await git(primary, "merge", "--ff-only", "refs/remotes/origin/main");
    assert.equal(await git(primary, "rev-parse", "refs/heads/main"), f.advanced);
    assert.equal(await git(prepared.releaseRoot, "rev-parse", "refs/remotes/origin/main"), upstream);
    f.reviewed = await reviewedAdvance(f, writer, upstream, f.advanced);
    f.expected = { ...expected, ...f.reviewed };
  }
  return f;
}

async function candidateState(f) {
  return {
    evidence: await releaseFiles(path.join(f.layoutRoot, "evidence")),
    checkpoint: sha256(await readFile(f.checkpointFile)),
    main: await git(f.releaseRoot, "rev-parse", "refs/heads/main"),
    preRelease: await git(f.releaseRoot, "rev-parse", "refs/heads/PreRelease"),
    head: await git(f.releaseRoot, "rev-parse", "HEAD"),
    tracking: await git(f.releaseRoot, "rev-parse", "refs/remotes/origin/main"),
  };
}

// Objects only (no ref) are imported so the tracking ref can point at them.
async function moveReleaseTracking(f, commitId) {
  await git(f.releaseRoot, "fetch", "--no-tags", "--no-write-fetch-head", f.origin, commitId);
  await git(f.releaseRoot, "update-ref", "refs/remotes/origin/main", commitId);
}

// Named current-state drifts with exact restoration.
function currentDrifts(f) {
  const primary = f.primaryRoot;
  const origin = f.origin;
  const alternateUrl = origin.includes("\\") ? origin.replaceAll("\\", "/") : `${origin}/`;
  return [
    ["primary untracked", async () => writeFile(path.join(primary, "untracked-drift.txt"), "drift\n"),
      async () => rm(path.join(primary, "untracked-drift.txt"))],
    ["primary index", async () => {
      await writeFile(path.join(primary, "app.txt"), "staged drift\n");
      await git(primary, "add", "app.txt");
    }, async () => {
      await git(primary, "reset", "-q", "HEAD", "--", "app.txt");
      await git(primary, "checkout", "--", "app.txt");
    }],
    ["primary main", async () => git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "drift"), async () => git(primary, "reset", "-q", "--hard", "HEAD~1")],
    ["primary branch", async () => git(primary, "checkout", "-q", "--detach"),
      async () => git(primary, "checkout", "-q", "main")],
    ["remote", async () => {
      await git(f.writer, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
        "commit", "--allow-empty", "-m", "remote drift");
      await git(f.writer, "push", "origin", "main");
    }, async () => {
      await git(f.writer, "reset", "-q", "--hard", "HEAD~1");
      await git(f.writer, "push", "--force", "origin", "main");
    }],
    ["release tracking", async () => moveReleaseTracking(f, f.advanced ?? f.published),
      async () => git(f.releaseRoot, "update-ref", "refs/remotes/origin/main", f.upstream)],
    ["origin URL", async () => git(f.releaseRoot, "remote", "set-url", "origin", alternateUrl),
      async () => git(f.releaseRoot, "remote", "set-url", "origin", origin)],
  ];
}

test("accepted recovery alone cannot recover the legacy missing-provenance candidate", async (context) => {
  const f = await legacyFrozenFixture(context);
  const before = await candidateState(f);
  const { missingProvenanceRecovery: _request, missingProvenanceResolver: _resolver, ...plain } = f.request();
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(plain), /approved origin main changed/u);
  assert.deepEqual(await candidateState(f), before);
});

test("missing-provenance recovery binds receipt bytes, historical adoption and old bytes through preview, confirm and replay", async (context) => {
  const f = await legacyFrozenFixture(context);
  const before = await candidateState(f);
  const preview = await f.service().recoverFreezingPublicationCandidate(f.request());
  assert.equal(preview.status, "preview");
  assert.deepEqual(await candidateState(f), before, "preview has no effect");
  const supplemental = preview.identity.supplementalProvenance;
  assert.equal(supplemental.kind, "supplemental-reviewed-adoption-v1");
  assert.equal(preview.identity.baseProvenance, null, "old candidate is not relabelled as reviewed");
  assert.deepEqual(supplemental.authority.derived, {
    publishedBaseCommit: f.published,
    approvedLocalMainCommit: f.published,
    approvedOriginMainCommit: f.upstream,
    baseCommit: f.upstream,
  });
  const stored = f.catalog.mcpOperationResultEvidence("rm-release-preflight-approved");
  assert.equal(stored.resultJsonSha256, sha256(Buffer.from(stored.resultJson, "utf8")));
  assert.deepEqual(supplemental.authority.receipt, {
    requestId: "rm-release-preflight-approved",
    workspaceId: f.workspaceId,
    ...f.caller,
    toolName: "hub_release_preflight",
    argumentsHash: f.missingProvenanceRecovery.expectedArgumentsHash,
    status: "succeeded",
    createdAtMs: stored.createdAtMs,
    completedAtMs: stored.completedAtMs,
    resultSha256: stored.resultJsonSha256,
  });
  const record = JSON.parse(await git(f.primaryRoot, "cat-file", "-p", f.adoption.recordHash));
  assert.deepEqual(supplemental.authority.adoption, {
    validation: "historical-immutable-v1",
    taskRevision: 4,
    taskId: TASK_ID,
    resultCommit: f.resultCommit,
    recordRef: f.adoption.recordRef,
    recordHash: f.adoption.recordHash,
    requestId: "adopt-upstream-request",
    branch: record.branch,
    taskBaseCommit: f.published,
    acceptedLocalMainCommit: f.published,
    adoptedCommit: f.upstream,
    snapshotTree: record.snapshotTree,
    proofCommit: f.resultCommit,
    proofParents: [f.taskCommit, f.upstream],
    proofTree: record.proofTree,
  });
  assert.equal(supplemental.currentObservation.primary.mainCommit, f.published);
  assert.equal(supplemental.currentObservation.remoteOriginMain, f.upstream);
  assert.equal(supplemental.currentObservation.releaseTrackingOriginMain, f.upstream);
  assert.equal(supplemental.sourceManifest.preparedManifestHash, f.preparedReadback.manifestHash);
  assert.equal(supplemental.authority.candidate.preparedTree, f.preparedReadback.tree);

  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: "0".repeat(64),
  })), /confirmation proof changed/u);
  assert.deepEqual(await candidateState(f), before);

  const completed = await f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  assert.equal(completed.status, "abandoned");
  const after = await releaseFiles(path.join(f.layoutRoot, "evidence"));
  for (const [file, digest] of Object.entries(before.evidence)) {
    assert.equal(after[file], digest, `prepared/frozen evidence ${file} stays byte-identical`);
  }
  assert.equal(await git(f.releaseRoot, "rev-parse", "refs/heads/main"), f.published);
  const evidence = JSON.parse(await readFile(completed.evidenceFile, "utf8"));
  assert.equal(sha256(Buffer.from(evidence.sourceCheckpointBytesBase64, "base64")), f.originalCheckpointSha256);
  assert.equal(sha256(Buffer.from(evidence.supplementalEvidence.preparedManifestBytesBase64, "base64")),
    f.preparedReadback.manifestHash);
  assert.equal(evidence.supplementalEvidence.preflightResultJson, stored.resultJson);

  await f.reopen();
  const replay = await f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  assert.equal(replay.reused, true);
  assert.equal(replay.proofHash, preview.proofHash);
  const readback = await f.service().recoverFreezingPublicationCandidate(f.request());
  assert.equal(readback.proofHash, preview.proofHash);
  const finalEvidence = await releaseFiles(path.join(f.layoutRoot, "evidence"));
  for (const [file, digest] of Object.entries(before.evidence)) assert.equal(finalEvidence[file], digest);

  // Completed replay still re-reads the exact authorities before returning.
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
    missingProvenanceRecovery: { ...f.missingProvenanceRecovery, expectedResultSha256: "1".repeat(64) },
  })), /missing-provenance recovery rejected|does not bind/u);
  const { missingProvenanceRecovery: _omitted, missingProvenanceResolver: _unused, ...omitted } = f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  });
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(omitted),
    /missing-provenance request changed after admission|approved origin main changed/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    requestId: "foreign-operation", confirm: true, expectedProofHash: preview.proofHash,
  })), /another exact operation/u);
  await git(f.primaryRoot, "update-ref", "-d", f.adoption.recordRef);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  })), /historical selected Task adoption is not exact/u);
});

test("historical adoption survives advanced primary while ordinary stale adoption refuses", async (context) => {
  const f = await legacyFrozenFixture(context, { advancePrimary: true });
  const before = await candidateState(f);
  await assert.rejects(f.tasks.releaseBaseEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: f.frozenTasks.map(({ taskId, resultCommit }) => ({ taskId, resultCommit })),
  }), /accepted local main changed/u);
  assert.equal(await git(f.primaryRoot, "rev-parse", "refs/heads/main"), f.advanced);
  assert.deepEqual(await candidateState(f), before);
  const historical = await f.tasks.historicalUpstreamAdoptionEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: f.frozenTasks, expected: f.missingProvenanceRecovery.expectedAdoption, recoveryKind: RECOVERY_KIND,
  });
  assert.equal(historical.validation, "historical-immutable-v1");
  assert.equal(historical.adoption.acceptedLocalMainCommit, f.published, "historical field, not current main");
  await assert.rejects(f.tasks.historicalUpstreamAdoptionEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: f.frozenTasks, expected: f.missingProvenanceRecovery.expectedAdoption,
  }), /limited to missing-provenance recovery/u);

  // The newer remote tip is not authorized by old evidence or by ancestry.
  const { reviewedOriginMain: _a, reviewedOriginParent: _b, reviewedOriginTree: _c, reviewedOriginDiffSha256: _d,
    reviewedOriginDiffHashObject: _e, reviewedOriginPatchId: _g, releaseTrackingOriginMain: _h, originUrlSha256: _i,
    ...withoutAdvance } = f.expected;
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({ expected: withoutAdvance })),
    /approved origin main changed/u);
  await git(f.writer, "checkout", "-q", "-b", "changelog-only", f.upstream);
  await writeFile(path.join(f.writer, "CHANGELOG.md"), "# Changelog\n\nreviewed upstream entry\n\nnext entry\n", "utf8");
  const changelogOnly = await commit(f.writer, "earlier changelog-only review");
  const earlier = await reviewedAdvance(f, f.writer, f.upstream, changelogOnly);
  await git(f.writer, "checkout", "-q", "main");
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    expected: { ...withoutAdvance, ...earlier },
  })), /approved origin main changed/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    expected: { ...f.expected, reviewedOriginDiffSha256: earlier.reviewedOriginDiffSha256 },
  })), /reviewed origin advance proof changed/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    expected: { ...f.expected, reviewedOriginTree: earlier.reviewedOriginTree },
  })), /reviewed origin advance proof changed/u);
  await git(f.writer, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty", "-m", "ancestry only");
  await git(f.writer, "push", "origin", "main");
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request()),
    /approved origin main changed/u, "a descendant of the reviewed tip is not accepted by ancestry");
  await git(f.writer, "reset", "-q", "--hard", "HEAD~1");
  await git(f.writer, "push", "--force", "origin", "main");
  // Release clone tracking may not advance to the reviewed tip.
  await moveReleaseTracking(f, f.advanced);
  for (const releaseTrackingOriginMain of [f.upstream, f.advanced]) {
    await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
      expected: { ...f.expected, releaseTrackingOriginMain },
    })), /approved origin main changed/u);
  }
  await git(f.releaseRoot, "update-ref", "refs/remotes/origin/main", f.upstream);
  assert.deepEqual(await candidateState(f), before);

  // Exact combination: historical 95/8355 authority, reviewed remote tip,
  // current primary observation, lagging release tracking.
  const preview = await f.service().recoverFreezingPublicationCandidate(f.request());
  const observation = preview.identity.supplementalProvenance.currentObservation;
  assert.equal(observation.primary.mainCommit, f.advanced);
  assert.equal(observation.primary.headCommit, f.advanced);
  assert.equal(observation.remoteOriginMain, f.advanced);
  assert.equal(observation.releaseTrackingOriginMain, f.upstream);
  assert.equal(preview.identity.reviewedOriginAdvance.reviewedOriginMain, f.advanced);
  assert.deepEqual(preview.identity.supplementalProvenance.authority.derived, {
    publishedBaseCommit: f.published, approvedLocalMainCommit: f.published,
    approvedOriginMainCommit: f.upstream, baseCommit: f.upstream,
  });
  const crashing = f.service({ recoveryPhase: async (name) => { if (name === "intent") throw new Error("crash at intent"); } });
  await assert.rejects(crashing.recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  })), /crash at intent/u);
  await f.reopen();
  const resumed = await f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  assert.equal(resumed.status, "abandoned");
  assert.equal(await git(f.releaseRoot, "rev-parse", "refs/heads/main"), f.published);
  assert.equal(await git(f.releaseRoot, "rev-parse", "refs/remotes/origin/main"), f.upstream);
  assert.equal(await git(f.primaryRoot, "rev-parse", "refs/heads/main"), f.advanced);
  await f.reopen();
  const replay = await f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  assert.equal(replay.reused, true);
  assert.equal(replay.proofHash, preview.proofHash);
});

test("current primary, remote, tracking and URL drift rejects at confirm, resume and completed replay", async (context) => {
  const f = await legacyFrozenFixture(context, { advancePrimary: true });
  const before = await candidateState(f);
  const preview = await f.service().recoverFreezingPublicationCandidate(f.request());
  const confirm = () => f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  // Fresh confirmation re-observes: a drifted observation changes the proof;
  // remote/tracking/URL also fail the reviewed-advance fence; a detached
  // primary fails the primary invariant.
  const confirmDrift = /confirmation proof changed|approved origin main changed|HEAD must remain attached/u;
  // After admission the persisted observation is re-read exactly.
  const admittedDrift = /current primary, remote, tracking or URL changed after preview|HEAD must remain attached/u;
  for (const [name, drift, restore] of currentDrifts(f)) {
    await drift();
    await assert.rejects(confirm(), confirmDrift, `confirm rejects ${name} drift`);
    await restore();
    assert.deepEqual(await candidateState(f), before, `no effect after ${name} drift at confirm`);
  }

  const crashing = f.service({ recoveryPhase: async (name) => { if (name === "intent") throw new Error("crash at intent"); } });
  await assert.rejects(crashing.recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  })), /crash at intent/u);
  const admitted = await candidateState(f);
  assert.equal(JSON.parse(await readFile(f.checkpointFile, "utf8")).phase, "abandoning");
  for (const [name, drift, restore] of currentDrifts(f)) {
    await drift();
    await f.reopen();
    await assert.rejects(confirm(), admittedDrift, `resume rejects ${name} drift`);
    await restore();
    assert.deepEqual(await candidateState(f), admitted, `no ref or checkpoint outcome after ${name} drift at resume`);
  }
  const completed = await confirm();
  assert.equal(completed.status, "abandoned");

  for (const [name, drift, restore] of currentDrifts(f)) {
    await drift();
    await f.reopen();
    await assert.rejects(confirm(), admittedDrift, `completed replay rejects ${name} drift`);
    await restore();
  }
  const replay = await confirm();
  assert.equal(replay.reused, true);
  assert.equal(replay.proofHash, preview.proofHash);
});

for (const phase of ["evidence", "intent", "detached", "main", "refs", "checkout"]) {
  test(`missing-provenance recovery resumes exactly after a crash at ${phase}`, async (context) => {
    const f = await legacyFrozenFixture(context);
    const preview = await f.service().recoverFreezingPublicationCandidate(f.request());
    const crashing = f.service({
      recoveryPhase: async (name) => { if (name === phase) throw new Error(`crash at ${phase}`); },
    });
    await assert.rejects(crashing.recoverFreezingPublicationCandidate(f.request({
      confirm: true, expectedProofHash: preview.proofHash,
    })), new RegExp(`crash at ${phase}`, "u"));
    await f.reopen();
    await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
      confirm: true, expectedProofHash: preview.proofHash,
      missingProvenanceRecovery: { ...f.missingProvenanceRecovery, expectedAdoption: {
        ...f.missingProvenanceRecovery.expectedAdoption, recordHash: "2".repeat(40),
      } },
    })), /missing-provenance|conflicts|does not bind/u);
    const resumed = await f.service().recoverFreezingPublicationCandidate(f.request({
      confirm: true, expectedProofHash: preview.proofHash,
    }));
    assert.equal(resumed.status, "abandoned");
    assert.equal(resumed.proofHash, preview.proofHash);
    assert.equal(await git(f.releaseRoot, "rev-parse", "refs/heads/main"), f.published);
  });
}

test("missing-provenance recovery rejects every receipt, result and adoption drift before effects", async (context) => {
  const f = await legacyFrozenFixture(context);
  const before = await candidateState(f);
  const attempt = async (override, pattern) => {
    await assert.rejects(
      f.service().recoverFreezingPublicationCandidate(f.request({
        missingProvenanceRecovery: { ...f.missingProvenanceRecovery, ...override },
      })),
      pattern,
    );
    assert.deepEqual(await candidateState(f), before);
  };
  const withReceipt = async (requestId, { args = null, result, tool, workspace, pending = false, mutate = null } = {}) => {
    const exactArgs = { ...(args ?? f.preflightArguments), request_id: requestId };
    const stored = f.receipt(requestId, exactArgs, pending ? undefined : result, { tool, workspace });
    mutate?.(requestId);
    const current = f.catalog.mcpOperationResultEvidence(requestId);
    return {
      preflightRequestId: requestId,
      preflightArguments: exactArgs,
      expectedArgumentsHash: stored.argumentsHash,
      expectedResultSha256: current.resultJsonSha256 ?? "3".repeat(64),
    };
  };
  const ready = f.readyResult();
  const candidate = ready.releaseCandidates[0];

  await attempt({ preflightRequestId: "absent-receipt", preflightArguments: {
    ...f.preflightArguments, request_id: "absent-receipt",
  }, expectedArgumentsHash: mcpArgumentsHash({ ...f.preflightArguments, request_id: "absent-receipt" }) },
  /receipt was not found/u);
  await attempt(await withReceipt("pending-receipt", { pending: true }), /exact terminal success/u);
  await attempt(await withReceipt("failed-receipt", { pending: true,
    mutate: (id) => f.catalog.failMcpOperation(id, new Error("failed")) }), /exact terminal success/u);
  await attempt(await withReceipt("unknown-receipt", { pending: true,
    mutate: (id) => f.catalog.markMcpOperationUnknown(id, new Error("lost")) }), /exact terminal success/u);
  await attempt(await withReceipt("reconciled-receipt", { pending: true, mutate: (id) => {
    f.catalog.markMcpOperationUnknown(id, new Error("lost"));
    f.catalog.completeUnknownMcpOperation(id, {
      workspaceId: f.workspaceId, toolName: "hub_release_preflight", result: ready, reconciliation: { by: "operator" },
    });
  } }), /no full original result/u);
  await attempt(await withReceipt("compacted-receipt", {
    result: { ...ready, padding: "x".repeat(70 * 1024) },
  }), /no full original result/u);
  await attempt(await withReceipt("wrong-tool", { result: ready, tool: "hub_release_plan_get" }),
    /not this Workspace release preflight/u);
  const other = f.catalog.createWorkspaceWithStream({ name: "Other", streamName: "Other" });
  await attempt(await withReceipt("wrong-workspace", { result: ready, workspace: other.workspace.id }),
    /not this Workspace release preflight/u);
  await attempt({ expectedCaller: { ...f.caller, threadId: "another-thread" } }, /another caller/u);
  await attempt({ expectedArgumentsHash: "4".repeat(64) }, /reproduce the expected receipt hash/u);
  await attempt({ preflightArguments: { ...f.preflightArguments, conflicts_resolved: false } }, /did not resolve conflicts/u);
  await attempt({ preflightArguments: { ...f.preflightArguments, request_id: "another-request" } }, /request_id does not match/u);
  await attempt({ preflightArguments: { ...f.preflightArguments, extra: true } }, /unsupported extra/u);
  await attempt({ preflightArguments: { ...f.preflightArguments, approved_repositories: [{
    ...f.preflightArguments.approved_repositories[0], approvedOriginMainCommit: f.published,
  }] } }, /approval does not bind/u);
  await attempt({ expectedResultSha256: "5".repeat(64) }, /result digest changed/u);
  // The digest is over persisted bytes, not a canonical re-serialization.
  const stored = f.catalog.mcpOperationResultEvidence("rm-release-preflight-approved");
  await attempt({ expectedResultSha256: sha256(JSON.stringify(JSON.parse(stored.resultJson), null, 2)) },
    /result digest changed/u);

  const resultCases = [
    ["not-ready", { status: "main_review_required" }, /not ready/u],
    ["wrong-plan", { planRevision: "8".repeat(64) }, /not ready/u],
    ["wrong-tasks", { taskIds: [TASK_ID, "extra-task"] }, /not ready/u],
    ["unresolved-conflicts", { conflictsResolved: false }, /not ready/u],
    ["unapproved", { mainAudits: [{ ...ready.mainAudits[0], approved: false }] }, /main audit/u],
    ["approval-required", { mainAudits: [{ ...ready.mainAudits[0], approvalRequired: true }] }, /main audit/u],
    ["wrong-origin", { mainAudits: [{ ...ready.mainAudits[0], originMain: f.published }] }, /main audit/u],
    ["wrong-published", { mainAudits: [{ ...ready.mainAudits[0], publishedRevision: f.upstream }] }, /main audit/u],
    ["wrong-head", { releaseCandidates: [{ ...candidate, preReleaseHead: "e".repeat(40) }] }, /another prepared candidate/u],
    ["wrong-tree", { releaseCandidates: [{ ...candidate, tree: "6".repeat(40) }] }, /another prepared candidate/u],
    ["wrong-manifest", { releaseCandidates: [{ ...candidate, manifestHash: "7".repeat(64) }] }, /another prepared candidate/u],
    ["wrong-base", { releaseCandidates: [{ ...candidate, baseCommit: f.published }] }, /another prepared candidate/u],
    ["provenance-present", { releaseCandidates: [{ ...candidate, manifest: {
      ...candidate.manifest, baseProvenance: { kind: "explicit-reviewed-main-v1" },
    } }] }, /another prepared candidate/u],
    ["request-bound", { releaseCandidates: [{ ...candidate, preflightRequestId: "bound" }] }, /another prepared candidate/u],
    ["wrong-task-revision", { releaseCandidates: [{ ...candidate, manifest: {
      ...candidate.manifest, tasks: candidate.manifest.tasks.map((task) => ({ ...task, taskRevision: 99 })),
    } }] }, /another prepared candidate/u],
    ["two-repositories", { mainAudits: [...ready.mainAudits, ready.mainAudits[0]] }, /exactly this one repository/u],
  ];
  for (const [name, overrides, pattern] of resultCases) {
    await attempt(await withReceipt(`result-${name}`, { result: f.readyResult(overrides) }), pattern);
  }

  await attempt({ expectedAdoption: { ...f.missingProvenanceRecovery.expectedAdoption, recordHash: "8".repeat(40) } },
    /historical selected Task adoption is not exact/u);
  await attempt({ expectedAdoption: { ...f.missingProvenanceRecovery.expectedAdoption, taskId: "another-task" } },
    /historical selected Task adoption is not exact/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    missingProvenanceResolver: null,
  })), /owner resolver/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    recoveryMode: "abandon-freezing-candidate-v1",
  })), /applies only to failed-frozen recovery/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    missingProvenanceResolver: async (input) => {
      const resolved = await f.resolver(input);
      return { ...resolved, authority: { ...resolved.authority, derived: {
        ...resolved.authority.derived, approvedOriginMainCommit: f.published,
      } } };
    },
  })), /does not bind this candidate/u);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    missingProvenanceResolver: async (input) => {
      const resolved = await f.resolver(input);
      return { ...resolved, authority: { ...resolved.authority, adoption: {
        ...resolved.authority.adoption, validation: "current-admission",
      } } };
    },
  })), /does not bind this candidate/u);
  assert.deepEqual(await candidateState(f), before);

  // Canonical but forged records behind the exact ref are rejected.
  const record = JSON.parse(await git(f.primaryRoot, "cat-file", "-p", f.adoption.recordHash));
  const forge = async (changes) => {
    const file = path.join(f.root, `forged-${Object.keys(changes).join("-")}.json`);
    await writeFile(file, `${JSON.stringify({ ...record, ...changes })}\n`, "utf8");
    return git(f.primaryRoot, "hash-object", "-w", file);
  };
  for (const [changes, pattern] of [
    [{ requestId: "forged-request" }, /does not match the expected exact ref and blob/u],
    [{ acceptedLocalMainCommit: f.upstream }, /no explicit upstream adoption proof|does not match its immutable object proof/u],
    [{ snapshotTree: f.upstream }, /does not match its immutable object proof/u],
    [{ proofParents: [f.published, f.upstream] }, /does not match its immutable object proof/u],
    // Internally consistent with objects, but not the exact pinned blob.
    [{ taskBaseCommit: f.upstream }, /does not match the expected exact ref and blob|no explicit upstream adoption proof/u],
  ]) {
    const forgedHash = await forge(changes);
    await git(f.primaryRoot, "update-ref", f.adoption.recordRef, forgedHash, f.adoption.recordHash);
    await attempt({}, pattern);
    await git(f.primaryRoot, "update-ref", f.adoption.recordRef, f.adoption.recordHash, forgedHash);
  }
  const sibling = `${f.adoption.recordRef.slice(0, f.adoption.recordRef.lastIndexOf("/"))}/${f.published}`;
  await git(f.primaryRoot, "update-ref", sibling, f.adoption.recordHash);
  await attempt({}, /ambiguous historical adoption receipts/u);
  await git(f.primaryRoot, "update-ref", "-d", sibling);
  await git(f.primaryRoot, "update-ref", "-d", f.adoption.recordRef);
  await attempt({}, /no outstanding historical adoption/u);
});

test("historical adoption accepts only a two-parent proof commit", async (context) => {
  const f = await legacyFrozenFixture(context);
  // An octopus snapshot: the adopted upstream is the second of three parents.
  await writeFile(path.join(f.writer, "extra.txt"), "extra\n", "utf8");
  const extra = await commit(f.writer, "third parent");
  const tree = await git(f.primaryRoot, "rev-parse", `${f.resultCommit}^{tree}`);
  await git(f.primaryRoot, "fetch", "--no-tags", f.writer, extra);
  const octopus = await git(f.primaryRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit-tree", tree, "-p", f.taskCommit, "-p", f.upstream, "-p", extra, "-m", "octopus adoption");
  const record = JSON.parse(await git(f.primaryRoot, "cat-file", "-p", f.adoption.recordHash));
  const octopusRecord = { ...record, snapshotCommit: octopus, proofCommit: octopus,
    snapshotTree: tree, proofTree: tree, proofParents: [f.taskCommit, f.upstream] };
  const file = path.join(f.root, "octopus-adoption.json");
  await writeFile(file, `${JSON.stringify(octopusRecord)}\n`, "utf8");
  const recordHash = await git(f.primaryRoot, "hash-object", "-w", file);
  const recordRef = `${f.adoption.recordRef.split("/").slice(0, -2).join("/")}/${octopus}/${f.upstream}`;
  await git(f.primaryRoot, "update-ref", recordRef, recordHash);
  await assert.rejects(f.tasks.historicalUpstreamAdoptionEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: [{ taskId: TASK_ID, resultCommit: octopus }],
    expected: { taskId: TASK_ID, recordRef, recordHash }, recoveryKind: RECOVERY_KIND,
  }), /invalid explicit upstream adoption/u);
});

test("the historical adoption method has exactly one supplemental recovery call site", async () => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../src");
  const callers = [];
  for (const entry of await readdir(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const text = await readFile(file, "utf8");
    if (text.includes(".historicalUpstreamAdoptionEvidence(")) callers.push(path.relative(sourceRoot, file).replaceAll("\\", "/"));
  }
  assert.deepEqual(callers, ["application/release-missing-provenance-resolver.mjs"]);
});

test("missing-provenance recovery refuses changed, one-sided or already provenanced candidates", async (context) => {
  const f = await legacyFrozenFixture(context);
  const checkpointBytes = await readFile(f.checkpointFile);
  const checkpoint = JSON.parse(checkpointBytes.toString("utf8"));
  const restore = () => writeFile(f.checkpointFile, checkpointBytes);
  const reject = async (pattern) => {
    await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request()), pattern);
  };
  const provenance = {
    schemaVersion: 1, kind: "explicit-reviewed-main-v1", publishedBaseCommit: f.published,
    approvedLocalMainCommit: f.published, approvedOriginMainCommit: f.upstream,
  };
  await writeFile(f.checkpointFile, `${JSON.stringify({ ...checkpoint, baseProvenance: provenance }, null, 2)}\n`);
  await reject(/disagrees with its immutable manifest/u);
  await writeFile(f.checkpointFile, `${JSON.stringify({ ...checkpoint, preflightRequestId: "bound" }, null, 2)}\n`);
  await reject(/bound to a preflight request/u);
  await restore();

  const manifestFile = path.join(f.layoutRoot, "evidence", `${checkpoint.manifestHash}.json`);
  const manifestBytes = await readFile(manifestFile);
  await writeFile(manifestFile, Buffer.concat([manifestBytes, Buffer.from(" ")]));
  await reject(/manifest digest changed/u);
  await writeFile(manifestFile, manifestBytes);

  const frozenManifest = JSON.parse(manifestBytes.toString("utf8"));
  const preparedFile = path.join(f.layoutRoot, "evidence", `${frozenManifest.publication.sourceManifestHash}.json`);
  const preparedBytes = await readFile(preparedFile);
  await writeFile(preparedFile, Buffer.concat([preparedBytes, Buffer.from(" ")]));
  await reject(/prepared manifest digest changed/u);
  await rm(preparedFile);
  await reject(/ENOENT/u);
  await writeFile(preparedFile, preparedBytes);

  await git(f.releaseRoot, "update-ref", "refs/heads/PreRelease", f.published);
  await reject(/refs or checkout changed/u);
  await git(f.releaseRoot, "update-ref", "refs/heads/PreRelease", checkpoint.preReleaseHead);

  await writeFile(path.join(f.stateEnvironment.LOCALAPPDATA, "AgentHub", "publication-state.json"),
    `${JSON.stringify({ repositories: [{ root: f.primaryRoot, revision: f.upstream }] }, null, 2)}\n`, "utf8");
  await reject(/durable published revision changed/u);
});

test("advanced bases require an immutable provenance envelope before candidate effects", async (context) => {
  const f = await legacyFrozenFixture(context);
  // RED shape: the same plain preparation now fails before refs or checkpoint.
  const guarded = f.service();
  const before = await candidateState(f);
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
  }), /exact agreed local main/u);
  await assert.rejects(guarded.validateCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
  }), /exact agreed local main/u);
  assert.deepEqual(await candidateState(f), before);
  // Independent freeze defense for the legacy shape, before any effect.
  await assert.rejects(guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: f.planRevision,
    expectedPreparedHead: f.preparedReadback.preReleaseHead,
    changelogContent: await readFile(path.join(f.releaseRoot, "CHANGELOG.md")),
  }), /without immutable provenance/u);
  assert.deepEqual(await candidateState(f), before);

  // Current ordinary admission verifies and retains this exact adoption while
  // keeping agreed local main as its base; historical recovery is separate.
  const base = await f.tasks.releaseBaseEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: f.frozenTasks.map(({ taskId, resultCommit }) => ({ taskId, resultCommit })),
  });
  assert.equal(base.baseCommit, f.published);
  assert.equal(base.compositionPolicy, "main-selected-git-merge-v1");
  assert.deepEqual(base.adoptions, [{
    taskId: TASK_ID, resultCommit: f.resultCommit,
    recordRef: f.adoption.recordRef, recordHash: f.adoption.recordHash,
    adoptedCommit: f.upstream, acceptedLocalMainCommit: f.published,
  }]);
  const recovered = await guarded.recoverFreezingPublicationCandidate(f.request({
    confirm: true,
    expectedProofHash: (await guarded.recoverFreezingPublicationCandidate(f.request())).proofHash,
  }));
  assert.equal(recovered.status, "abandoned");
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
  }), /exact agreed local main/u);
  const abandoned = await candidateState(f);
  // A legacy Task row without its registered base is not current adoption
  // authority merely because historical abandonment succeeded.
  await assert.rejects(guarded.prepareCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: "a".repeat(64),
    planRevision: "a".repeat(64), approvedBaseCommit: f.published, frozenTasks: f.frozenTasks,
  }), /Native upstream adoption receipt or current Git identity changed/u);
  assert.deepEqual(await candidateState(f), abandoned);
  assert.equal((JSON.parse(await readFile(f.checkpointFile, "utf8"))).phase, "abandoned");
});

test("completed historical abandonment permits native preparation with exact recovery evidence and agreed main", async (context) => {
  const f = await legacyFrozenFixture(context);
  const guarded = f.service();
  const recovered = await guarded.recoverFreezingPublicationCandidate(f.request({
    confirm: true,
    expectedProofHash: (await guarded.recoverFreezingPublicationCandidate(f.request())).proofHash,
  }));
  assert.equal(recovered.status, "abandoned");
  const originalCheckpoint = await readFile(f.checkpointFile);
  const abandoned = JSON.parse(originalCheckpoint);
  await writeFile(f.checkpointFile, JSON.stringify({ ...abandoned, recovery: { ...abandoned.recovery,
    outcome: { ...abandoned.recovery.outcome, proofHash: "0".repeat(64) } } }));
  const beforeTampered = await candidateState(f);
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "b".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.published, frozenTasks: [],
  }), /completed recovery identity changed/u);
  assert.deepEqual(await candidateState(f), beforeTampered);
  await writeFile(f.checkpointFile, originalCheckpoint);
  const prepared = await guarded.prepareCandidate({
    planRevision: "b".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.published, frozenTasks: [],
  });
  assert.equal(prepared.baseCommit, f.published);
  const manifest = JSON.parse(await readFile(prepared.manifestFile, "utf8"));
  assert.deepEqual(manifest.baseProvenance, { schemaVersion: 1, kind: "agreed-main-native-git-v1",
    publishedBaseCommit: f.published, agreedMainCommit: f.published });
  assert.equal(manifest.cutover.abandonedRecovery.evidenceSha256, abandoned.recovery.evidenceSha256);
  await guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: "b".repeat(64),
    expectedPreparedHead: prepared.preReleaseHead,
    changelogContent: await readFile(path.join(prepared.releaseRoot, "CHANGELOG.md")),
    releaseDate: new Date("2026-09-23T00:00:00Z"),
  });
  assert.equal((await guarded.frozenCandidate(f.primaryRoot)).checkpointPhase, "frozen");
});

test("missing-provenance resolver requires its authoritative owners", () => {
  assert.throws(() => createMissingProvenanceResolver({}), /mcpOperationResultEvidence/u);
  assert.throws(() => createMissingProvenanceResolver({
    workspaceCatalog: { mcpOperationResultEvidence() {} }, taskGitWorkspaces: { releaseBaseEvidence() {} },
  }), /historicalUpstreamAdoptionEvidence/u);
});
