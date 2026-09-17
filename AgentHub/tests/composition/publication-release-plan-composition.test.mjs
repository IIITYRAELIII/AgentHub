import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

import { readCandidatePublicationReleasePlan } from "../../src/composition/publication-release-plan-composition.mjs";
import { taskBranchName, taskRepositoryKey } from "../../src/domain/task-git-reference.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";

const execute = promisify(execFile);

async function git(cwd, ...args) {
  const { stdout } = await execute("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return stdout.trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-plan-reader-"));
  const dataDir = path.join(root, "data");
  const repository = path.join(root, "repository");
  await mkdir(repository, { recursive: true });
  await git(repository, "init");
  await git(repository, "config", "user.name", "Test");
  await git(repository, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(repository, "app.mjs"), "export const value = 1;\n");
  await git(repository, "add", "app.mjs");
  await git(repository, "commit", "-m", "base");
  const base = await git(repository, "rev-parse", "HEAD^{commit}");
  const baseBlob = await git(repository, "rev-parse", `${base}:app.mjs`);
  await writeFile(path.join(repository, "app.mjs"), "export const value = 2;\n");
  await git(repository, "add", "app.mjs");
  await git(repository, "commit", "-m", "result");
  const result = await git(repository, "rev-parse", "HEAD^{commit}");
  const resultBlob = await git(repository, "rev-parse", `${result}:app.mjs`);
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, dataDir, databaseFile, repository, store, base, baseBlob, result, resultBlob };
}

function enterTest(store, task, { projectRoot, branch, resultCommit }, operationId) {
  store.beginLifecycleTransition(task.id, {
    operationId, kind: "workflow", targetWorkflowStatus: "testing", expectedRevision: task.revision,
  });
  return store.commitWorkflowTransition({
    operationId,
    gitReferences: [{ projectRoot, branch, resultCommit }],
    evidence: { resultCommit },
  });
}

test("candidate planner reads one durable accepted-result snapshot before real Git evidence", async (t) => {
  const f = await fixture(t);
  const source = f.store.create({ text: "Source", bucket: "workspace", workspaceId: "workspace" });
  const survivor = f.store.create({ text: "Survivor", bucket: "workspace", workspaceId: "workspace" });
  const sourceBranch = taskBranchName(source.id, f.repository);
  const survivorBranch = taskBranchName(survivor.id, f.repository);
  await git(f.repository, "branch", sourceBranch, f.base);
  await git(f.repository, "branch", survivorBranch, f.result);
  await git(f.repository, "update-ref", `refs/agent-hub/task-bases/${survivor.id}/${taskRepositoryKey(f.repository)}`, f.base);
  const testedSource = enterTest(f.store, source, {
    projectRoot: f.repository, branch: sourceBranch, resultCommit: f.base,
  }, "test-source");
  const testedSurvivor = enterTest(f.store, survivor, {
    projectRoot: f.repository, branch: survivorBranch, resultCommit: f.base,
  }, "test-survivor");
  const proof = {
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor: {
      taskId: testedSurvivor.id, revision: testedSurvivor.revision,
      releaseRevision: testedSurvivor.releaseRevision, resultCommit: f.result,
      baseCommit: f.base, branch: survivorBranch,
    },
    source: {
      taskId: testedSource.id, revision: testedSource.revision,
      releaseRevision: testedSource.releaseRevision, resultCommit: f.base,
      baseCommit: f.base, branch: sourceBranch,
    },
    projectRoot: f.repository,
    previousResultCommit: f.base,
    baselineResultCommit: f.base,
    devBeforeCommit: f.base,
    devAfterTree: await git(f.repository, "rev-parse", `${f.result}^{tree}`),
    sourceWitnesses: [{
      path: "app.mjs",
      source: { mode: "100644", object: f.baseBlob },
      survivor: { mode: "100644", object: f.baseBlob },
    }],
    ownerWitnesses: [{
      path: "app.mjs",
      baseline: { mode: "100644", object: f.baseBlob },
      beforeDev: { mode: "100644", object: f.baseBlob },
      newResult: { mode: "100644", object: f.resultBlob },
      afterDev: { mode: "100644", object: f.resultBlob },
    }],
    authority: {
      workspaceId: "workspace", streamId: "release", provider: "codex",
      threadId: "thread", proofRequestId: "preview",
    },
  };
  f.store.beginLifecycleTransition(testedSurvivor.id, {
    operationId: "squash", kind: "workflow", targetWorkflowStatus: "testing",
    expectedRevision: testedSurvivor.revision, evidence: { squashTransfer: proof },
  });
  const squashed = f.store.commitSquashTransferTransition({
    operationId: "squash", squashTransfer: { ...proof, integrationCommit: f.result },
  }).task;
  const acceptedResultReleaseRevision = squashed.releaseRevision;
  f.store.beginLifecycleTransition(squashed.id, {
    operationId: "await", kind: "workflow", targetWorkflowStatus: "awaiting_implementation",
    expectedRevision: squashed.revision,
  });
  const awaiting = f.store.commitWorkflowTransition({ operationId: "await", replaceGitReferences: false });
  assert.ok(awaiting.releaseRevision > acceptedResultReleaseRevision);
  f.store.close();

  let closed = false;
  const plan = await readCandidatePublicationReleasePlan("workspace", {
    load: async () => ({ dataDir: f.dataDir }),
    createStore: (options) => {
      const store = new TaskBoardStore(options);
      const close = store.close.bind(store);
      store.close = () => { closed = true; close(); };
      return store;
    },
    createTaskGitWorkspaces: (options) => {
      const real = new TaskGitWorkspaceService(options);
      return { releaseEvidence: (request) => {
        assert.equal(closed, true, "SQLite snapshot must close before Git evidence");
        return real.releaseEvidence(request);
      } };
    },
  });
  assert.equal(plan.ready.length, 1);
  assert.equal(plan.ready[0].resultCommit, f.result);
  assert.equal(plan.ready[0].taskRevision, awaiting.releaseRevision);
  assert.equal(plan.ready[0].resultReleaseRevision, acceptedResultReleaseRevision);
  assert.equal(plan.ready[0].squashTransfer.integrationCommit, f.result);
});

test("read-only candidate planning neither creates storage nor runs Task migrations", async (t) => {
  const missingRoot = await mkdtemp(path.join(os.tmpdir(), "hub-publication-plan-missing-"));
  await rm(missingRoot, { recursive: true, force: true });
  await assert.rejects(readCandidatePublicationReleasePlan("workspace", {
    load: async () => ({ dataDir: missingRoot }),
  }));
  await assert.rejects(async () => (await import("node:fs/promises")).access(missingRoot));

  const f = await fixture(t);
  f.store.close();
  const database = new DatabaseSync(f.databaseFile);
  database.exec(`
    DELETE FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1';
    CREATE TABLE hub_release_changes (id TEXT PRIMARY KEY, status TEXT);
    INSERT INTO hub_release_changes (id, status) VALUES ('legacy', 'pending');
  `);
  database.close();
  await readCandidatePublicationReleasePlan("workspace", {
    load: async () => ({ dataDir: f.dataDir }),
    createTaskGitWorkspaces: () => ({ releaseEvidence: async () => assert.fail("no Await Git evidence expected") }),
  });
  const readback = new DatabaseSync(f.databaseFile, { readOnly: true });
  try {
    assert.equal(readback.prepare("SELECT status FROM hub_release_changes WHERE id = 'legacy'").get().status, "pending");
    assert.equal(readback.prepare(
      "SELECT value FROM hub_board_settings WHERE key = 'task_release_registry_migrated_v1'",
    ).get(), undefined);
  } finally {
    readback.close();
  }
});

test("read-only candidate planning rejects an incompatible Task schema", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-plan-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await mkdir(dataDir);
  const database = new DatabaseSync(path.join(dataDir, "journal.sqlite"));
  database.exec("CREATE TABLE hub_board_tasks (id TEXT PRIMARY KEY)");
  database.close();
  await assert.rejects(readCandidatePublicationReleasePlan("workspace", {
    load: async () => ({ dataDir }),
  }), /schema is incompatible/u);
});
