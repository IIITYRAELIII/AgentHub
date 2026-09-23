import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createMissingProvenanceResolver,
  preflightResultSha256,
} from "../../../src/application/release-missing-provenance-resolver.mjs";
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

// Real isolated Git + SQLite + public recovery composition for the release11
// shape: a legacy frozen candidate on an adopted upstream base whose manifest
// and checkpoint both lack base provenance, a later approved preflight receipt,
// and an immutable selected Task adoption record.

const execFileAsync = promisify(execFile);
const RECOVERY_SOURCE = { commit: "c".repeat(40), ownerSha256: "d".repeat(64) };
const TASK_ID = "57575757-5757-4757-8757-575757575757";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
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

async function legacyFrozenFixture(context) {
  const root = canonicalPath(await mkdtemp(path.join(os.tmpdir(), "ah-missing-provenance-")));
  let catalog = null;
  context.after(async () => {
    catalog?.close();
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
  const emptyState = { ...process.env, LOCALAPPDATA: path.join(root, "no-state") };
  const stateEnvironment = { ...process.env, LOCALAPPDATA: path.join(root, "state") };
  // Legacy owner: the pre-correction shape had no durable baseline guard.
  const legacy = new ReleaseGitWorkspaceService({ dataDir: releaseData, environment: emptyState });
  const planRevision = "9".repeat(64);
  catalog = await new WorkspaceCatalogStore({ databaseFile: path.join(root, "journal.sqlite") }).load();
  const { workspace, stream } = catalog.createWorkspaceWithStream({ name: "Release", streamName: "RM" });
  const workspaceId = workspace.id;
  // The managed release clone exists before upstream advances, as in release11.
  await legacy.prepareCandidate({
    planRevision: "0".repeat(64), projectRoot: primaryRoot, workspaceId, approvedBaseCommit: published, frozenTasks: [],
  });

  const tasks = new TaskGitWorkspaceService({ dataDir: taskData });
  const taskWorkspace = await tasks.prepare({ taskId: TASK_ID, projectRoot: primaryRoot });
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
  const adoption = await tasks.recordExplicitUpstreamAdoption({
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

  // The caller-error path: plain preparation on the adopted base, no envelope.
  const prepared = await legacy.prepareCandidate({
    planRevision, projectRoot: primaryRoot, workspaceId, approvedBaseCommit: upstream, frozenTasks,
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
    catalog.beginMcpOperation({
      requestId, workspaceId: workspace, streamId: caller.streamId, provider: caller.provider,
      threadId: caller.threadId, toolName: tool, argumentsHash: mcpArgumentsHash(args),
    });
    if (result !== undefined) catalog.completeMcpOperation(requestId, result);
    return catalog.mcpOperation(requestId);
  };
  const original = receipt(preflightRequestId, preflightArguments, readyResult());
  const missingProvenanceRecovery = {
    kind: "missing-provenance-recovery-v1",
    preflightRequestId,
    preflightArguments: { ...preflightArguments },
    expectedArgumentsHash: original.argumentsHash,
    expectedResultSha256: preflightResultSha256(original.result),
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
  const resolver = createMissingProvenanceResolver({ workspaceCatalog: catalog, taskGitWorkspaces: tasks });
  const service = (options = {}) => new ReleaseGitWorkspaceService({
    dataDir: releaseData, environment: stateEnvironment, ...options,
  });
  const request = (overrides = {}) => ({
    projectRoot: primaryRoot, workspaceId, requestId: "recover-missing-provenance",
    sourceIdentity: RECOVERY_SOURCE, recoveryMode: "abandon-failed-frozen-candidate-v1",
    expected, missingProvenanceRecovery, missingProvenanceResolver: resolver, ...overrides,
  });
  return {
    root, origin, primaryRoot, published, upstream, resultCommit, adoption, planRevision, workspaceId,
    catalog, caller, receipt, readyResult, preflightArguments, missingProvenanceRecovery, expected,
    checkpointFile, layoutRoot, releaseRoot: prepared.releaseRoot, preparedReadback, legacy, tasks,
    stateEnvironment, emptyState, releaseData, resolver, service, request, frozenTasks,
  };
}

async function candidateState(f) {
  return {
    evidence: await releaseFiles(path.join(f.layoutRoot, "evidence")),
    checkpoint: sha256(await readFile(f.checkpointFile)),
    main: await git(f.releaseRoot, "rev-parse", "refs/heads/main"),
    preRelease: await git(f.releaseRoot, "rev-parse", "refs/heads/PreRelease"),
    head: await git(f.releaseRoot, "rev-parse", "HEAD"),
  };
}

test("accepted recovery alone cannot recover the legacy missing-provenance candidate", { timeout: 120000 }, async (context) => {
  const f = await legacyFrozenFixture(context);
  const before = await candidateState(f);
  const { missingProvenanceRecovery: _request, missingProvenanceResolver: _resolver, ...plain } = f.request();
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(plain), /approved origin main changed/u);
  assert.deepEqual(await candidateState(f), before);
});

test("missing-provenance recovery binds receipt, adoption and old bytes through preview, confirm and replay", { timeout: 120000 }, async (context) => {
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
  assert.deepEqual(supplemental.authority.receipt, {
    requestId: "rm-release-preflight-approved",
    workspaceId: f.workspaceId,
    ...f.caller,
    toolName: "hub_release_preflight",
    argumentsHash: f.missingProvenanceRecovery.expectedArgumentsHash,
    status: "succeeded",
    createdAtMs: supplemental.authority.receipt.createdAtMs,
    completedAtMs: supplemental.authority.receipt.completedAtMs,
    resultSha256: f.missingProvenanceRecovery.expectedResultSha256,
  });
  assert.deepEqual(supplemental.authority.adoption, {
    taskId: TASK_ID, taskRevision: 4, resultCommit: f.resultCommit,
    recordRef: f.adoption.recordRef, recordHash: f.adoption.recordHash,
    adoptedCommit: f.upstream, acceptedLocalMainCommit: f.published,
  });
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
  for (const [file, digest] of Object.entries(before.evidence)) {
    assert.equal((await releaseFiles(path.join(f.layoutRoot, "evidence")))[file], digest, `old evidence ${file} preserved`);
  }
  assert.equal(await git(f.releaseRoot, "rev-parse", "refs/heads/main"), f.published);
  const evidence = JSON.parse(await readFile(completed.evidenceFile, "utf8"));
  assert.equal(sha256(Buffer.from(evidence.supplementalEvidence.preparedManifestBytesBase64, "base64")),
    f.preparedReadback.manifestHash);
  assert.equal(preflightResultSha256(evidence.supplementalEvidence.preflightResult),
    f.missingProvenanceRecovery.expectedResultSha256);

  const replay = await f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  }));
  assert.equal(replay.reused, true);
  assert.equal(replay.proofHash, preview.proofHash);
  const readback = await f.service().recoverFreezingPublicationCandidate(f.request());
  assert.equal(readback.proofHash, preview.proofHash);

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
  await git(f.primaryRoot, "update-ref", "-d", f.adoption.recordRef);
  await assert.rejects(f.service().recoverFreezingPublicationCandidate(f.request({
    confirm: true, expectedProofHash: preview.proofHash,
  })), /adoption|missing-provenance/u);
});

for (const phase of ["evidence", "intent", "detached", "main", "refs", "checkout"]) {
  test(`missing-provenance recovery resumes exactly after a crash at ${phase}`, { timeout: 120000 }, async (context) => {
    const f = await legacyFrozenFixture(context);
    const preview = await f.service().recoverFreezingPublicationCandidate(f.request());
    const crashing = f.service({
      recoveryPhase: async (name) => { if (name === phase) throw new Error(`crash at ${phase}`); },
    });
    await assert.rejects(crashing.recoverFreezingPublicationCandidate(f.request({
      confirm: true, expectedProofHash: preview.proofHash,
    })), new RegExp(`crash at ${phase}`, "u"));
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

test("missing-provenance recovery rejects every receipt, result and adoption drift before effects", { timeout: 180000 }, async (context) => {
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
    const current = f.catalog.mcpOperation(requestId);
    return {
      preflightRequestId: requestId,
      preflightArguments: exactArgs,
      expectedArgumentsHash: stored.argumentsHash,
      expectedResultSha256: current.result ? preflightResultSha256(current.result) : "3".repeat(64),
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
    /adoption ref or blob changed|does not bind/u);
  await attempt({ expectedAdoption: { ...f.missingProvenanceRecovery.expectedAdoption, taskId: "another-task" } },
    /adoption ref or blob changed|does not bind/u);
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
  assert.deepEqual(await candidateState(f), before);

  // A changed adoption blob behind the same ref is rejected by the owner.
  const blob = String((await execFileAsync("git", ["cat-file", "-p", f.adoption.recordHash], {
    cwd: f.primaryRoot, windowsHide: true,
  })).stdout).replace("adopt-upstream-request", "forged-request");
  const forgedFile = path.join(f.root, "forged-adoption.json");
  await writeFile(forgedFile, blob, "utf8");
  const forgedHash = await git(f.primaryRoot, "hash-object", "-w", forgedFile);
  await git(f.primaryRoot, "update-ref", f.adoption.recordRef, forgedHash, f.adoption.recordHash);
  await attempt({}, /adoption|receipt/u);
  await git(f.primaryRoot, "update-ref", "-d", f.adoption.recordRef);
  await attempt({}, /exactly one selected Task adoption|derive the candidate base/u);
});

test("missing-provenance recovery refuses changed, one-sided or already provenanced candidates", { timeout: 120000 }, async (context) => {
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

test("advanced bases require an immutable provenance envelope before candidate effects", { timeout: 120000 }, async (context) => {
  const f = await legacyFrozenFixture(context);
  // RED shape: the same plain preparation now fails before refs or checkpoint.
  const guarded = f.service();
  const before = await candidateState(f);
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
  }), /without immutable provenance/u);
  await assert.rejects(guarded.validateCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
  }), /without immutable provenance/u);
  assert.deepEqual(await candidateState(f), before);
  // Independent freeze defense for the legacy shape, before any effect.
  await assert.rejects(guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: f.planRevision,
    expectedPreparedHead: f.preparedReadback.preReleaseHead,
    changelogContent: await readFile(path.join(f.releaseRoot, "CHANGELOG.md")),
  }), /without immutable provenance/u);
  assert.deepEqual(await candidateState(f), before);

  // GREEN: the owner's selected adoption evidence is persisted immutably.
  const base = await f.tasks.releaseBaseEvidence({
    projectRoot: f.primaryRoot, publishedBaseCommit: f.published,
    tasks: f.frozenTasks.map(({ taskId, resultCommit }) => ({ taskId, resultCommit })),
  });
  assert.equal(base.baseCommit, f.upstream);
  const envelope = {
    schemaVersion: 1, kind: "selected-task-adoption-v1", publishedBaseCommit: f.published,
    adoptedBaseCommit: base.baseCommit, adoptions: base.adoptions,
  };
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
    baseProvenance: { ...envelope, publishedBaseCommit: f.upstream },
  }), /invalid selected Task adoption provenance|belongs to published/u);
  await assert.rejects(guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks,
    baseProvenance: { ...envelope, adoptions: [{ ...envelope.adoptions[0], recordRef: "refs/heads/main" }] },
  }), /invalid selected Task adoption provenance/u);
  const recovered = await guarded.recoverFreezingPublicationCandidate(f.request({
    confirm: true,
    expectedProofHash: (await guarded.recoverFreezingPublicationCandidate(f.request())).proofHash,
  }));
  assert.equal(recovered.status, "abandoned");
  const prepared = await guarded.prepareCandidate({
    planRevision: "a".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.upstream, frozenTasks: f.frozenTasks, baseProvenance: envelope,
  });
  const manifest = JSON.parse(await readFile(prepared.manifestFile, "utf8"));
  const checkpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  assert.deepEqual(manifest.baseProvenance, checkpoint.baseProvenance);
  assert.equal(manifest.baseProvenance.kind, "selected-task-adoption-v1");
  assert.equal(manifest.baseProvenance.adoptions[0].recordHash, f.adoption.recordHash);
  const readback = await guarded.frozenCandidate(f.primaryRoot);
  assert.deepEqual(readback.manifest.baseProvenance, manifest.baseProvenance);
  await guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: "a".repeat(64),
    expectedPreparedHead: prepared.preReleaseHead,
    changelogContent: await readFile(path.join(prepared.releaseRoot, "CHANGELOG.md")),
    releaseDate: new Date("2026-09-23T00:00:00Z"),
  });
  const frozen = await guarded.frozenCandidate(f.primaryRoot);
  assert.equal(frozen.checkpointPhase, "frozen");
  assert.deepEqual(frozen.manifest.baseProvenance, manifest.baseProvenance);
  // A later checkpoint-only change disagrees with the immutable manifest.
  const frozenCheckpoint = JSON.parse(await readFile(f.checkpointFile, "utf8"));
  await writeFile(f.checkpointFile, `${JSON.stringify({ ...frozenCheckpoint, baseProvenance: undefined }, null, 2)}\n`);
  await assert.rejects(guarded.frozenCandidate(f.primaryRoot), /disagrees with its immutable manifest/u);
  await assert.rejects(guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: "a".repeat(64),
    expectedPreparedHead: prepared.preReleaseHead,
    changelogContent: await readFile(path.join(prepared.releaseRoot, "CHANGELOG.md")),
  }), /disagrees with its immutable manifest/u);
});

test("published-base candidates keep working without provenance under the durable baseline", { timeout: 120000 }, async (context) => {
  const f = await legacyFrozenFixture(context);
  const guarded = f.service();
  const recovered = await guarded.recoverFreezingPublicationCandidate(f.request({
    confirm: true,
    expectedProofHash: (await guarded.recoverFreezingPublicationCandidate(f.request())).proofHash,
  }));
  assert.equal(recovered.status, "abandoned");
  const prepared = await guarded.prepareCandidate({
    planRevision: "b".repeat(64), projectRoot: f.primaryRoot, workspaceId: f.workspaceId,
    approvedBaseCommit: f.published, frozenTasks: [],
  });
  assert.equal(prepared.baseCommit, f.published);
  const manifest = JSON.parse(await readFile(prepared.manifestFile, "utf8"));
  assert.equal(Object.hasOwn(manifest, "baseProvenance"), false);
  await guarded.freezePublicationCandidate({
    projectRoot: f.primaryRoot, workspaceId: f.workspaceId, expectedPlanRevision: "b".repeat(64),
    expectedPreparedHead: prepared.preReleaseHead,
    changelogContent: await readFile(path.join(prepared.releaseRoot, "CHANGELOG.md")),
    releaseDate: new Date("2026-09-23T00:00:00Z"),
  });
  assert.equal((await guarded.frozenCandidate(f.primaryRoot)).checkpointPhase, "frozen");
});

test("missing-provenance resolver requires its authoritative owners", () => {
  assert.throws(() => createMissingProvenanceResolver({}), /mcpOperation/u);
  assert.throws(() => createMissingProvenanceResolver({ workspaceCatalog: { mcpOperation() {} } }),
    /releaseBaseEvidence/u);
});
