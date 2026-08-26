import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseChangeSetService } from "../../src/application/release-change-set-service.mjs";
import { messageWithTaskReferences } from "../../src/domain/task-board-task.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";

async function fixture(context, { verifyFreezeEvidence = async (manifest) => ({
  schemaVersion: 1,
  verifier: { name: "fake-git-verifier", version: "test" },
  repositories: manifest.repositories,
  files: manifest.files,
}) } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-changeset-service-"));
  const store = new WorkspaceCatalogStore({ databaseFile: path.join(directory, "journal.sqlite") });
  await store.load();
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = store.createWorkspace({
    id: "workspace",
    name: "Agent HUB",
    settings: { releaseWorkflowEnabled: true },
  });
  const owner = store.createStream({ id: "owner", workspaceId: workspace.id, name: "Dash" });
  const architect = store.createStream({ id: "architect", workspaceId: workspace.id, name: "Architect" });
  const foreign = store.createStream({ id: "foreign", workspaceId: workspace.id, name: "Other" });
  store.bindThread({ provider: "codex", threadId: "thread", streamId: owner.id });
  let sequence = 0;
  const service = new ReleaseChangeSetService({
    store,
    verifyFreezeEvidence,
    idFactory: () => `change-${++sequence}`,
  });
  return { store, service, workspace, owner, architect, foreign };
}

function freezeEvidence() {
  return {
    repositories: [{
      projectRoot: "D:/repo",
      baseRevision: "a".repeat(40),
      resultRevision: "b".repeat(40),
    }],
    files: [{
      projectRoot: "D:/repo",
      path: "src/app.mjs",
      operation: "modified",
      baseBlob: "c".repeat(40),
      resultBlob: "d".repeat(40),
    }],
  };
}

test("Dashboard task turns append observations to one draft ChangeSet", async (context) => {
  const { service } = await fixture(context);
  const prompt = messageWithTaskReferences("", [{
    taskId: "task-1", title: "Task", workflowStatus: "in_progress", intent: "start",
  }]);
  const first = service.observeTurn({
    provider: "codex", threadId: "thread", turnId: "turn-1", projectRoot: "D:/repo",
    summary: "First", status: "completed", changedFiles: ["src/app.mjs"], prompts: [prompt],
  });
  const second = service.observeTurn({
    provider: "codex", threadId: "thread", turnId: "turn-2", projectRoot: "D:/repo",
    summary: "Correction", status: "completed", changedFiles: ["src/app.mjs"],
  });

  assert.equal(first.id, second.id);
  assert.equal(second.logicalKey, "task:task-1");
  assert.equal(second.status, "draft");
  assert.equal(second.observations.length, 2);
  assert.equal(second.manifestHash, "");
});

test("owner freeze is explicit and Architect override is separately audited", async (context) => {
  const { store, service, workspace, owner, architect, foreign } = await fixture(context);
  const observed = service.observeTurn({
    provider: "codex", threadId: "thread", turnId: "turn-1", projectRoot: "D:/repo",
    summary: "Implemented", status: "completed", changedFiles: ["src/app.mjs"],
  });
  await assert.rejects(
    () => service.freeze({
      workspaceId: workspace.id,
      actorStreamId: foreign.id,
      changeSetId: observed.id,
      ...freezeEvidence(),
    }),
    /only the owner Stream/u,
  );
  assert.throws(
    () => service.setStatus({
      workspaceId: workspace.id,
      actorStreamId: foreign.id,
      changeSetId: observed.id,
      status: "discarded",
    }),
    /only the owner Stream/u,
  );
  const frozen = await service.freeze({
    workspaceId: workspace.id,
    actorStreamId: owner.id,
    changeSetId: observed.id,
    ...freezeEvidence(),
  });
  assert.equal(frozen.status, "ready");
  assert.match(frozen.manifestHash, /^[a-f0-9]{64}$/u);
  const frozenEvent = store.changeSetEvents(frozen.id).at(-1);
  assert.equal(frozenEvent.type, "changeset.frozen");
  assert.equal(frozenEvent.payload.verification.verifier.name, "fake-git-verifier");
  assert.equal(frozenEvent.payload.verification.verifier.version, "test");

  assert.throws(
    () => service.architectOverride({
      workspaceId: workspace.id,
      actorStreamId: foreign.id,
      changeSetId: frozen.id,
      status: "draft",
      reason: "Not authorized",
    }),
    /authorized Architect Stream/u,
  );
  const reopened = service.architectOverride({
    workspaceId: workspace.id,
    actorStreamId: architect.id,
    changeSetId: frozen.id,
    status: "draft",
    reason: "Integration correction",
  });
  assert.equal(reopened.status, "draft");
  assert.equal(reopened.revision, 2);
  const event = store.changeSetEvents(reopened.id).at(-1);
  assert.equal(event.payload.architectOverride, true);
  assert.equal(event.payload.authorizationSource, "stream-name-migration");
  assert.equal(event.payload.reason, "Integration correction");
});

test("failed server-side evidence verification leaves the ChangeSet draft", async (context) => {
  const { store, service, workspace, owner } = await fixture(context, {
    verifyFreezeEvidence: async () => {
      throw new Error("result path does not resolve to the claimed blob");
    },
  });
  const observed = service.observeTurn({
    provider: "codex", threadId: "thread", turnId: "turn-1", projectRoot: "D:/repo",
    summary: "Implemented", status: "completed", changedFiles: ["src/app.mjs"],
  });

  await assert.rejects(
    () => service.freeze({
      workspaceId: workspace.id,
      actorStreamId: owner.id,
      changeSetId: observed.id,
      ...freezeEvidence(),
    }),
    /does not resolve to the claimed blob/u,
  );

  assert.equal(store.changeSet(observed.id).status, "draft");
  assert.equal(store.changeSet(observed.id).manifestHash, "");
  assert.equal(store.changeSetEvents(observed.id).some((event) => event.type === "changeset.frozen"), false);
});

test("ReleaseBatch records frozen manifests without completing the legacy pipeline", async (context) => {
  const { service, workspace, owner } = await fixture(context);
  const observed = service.observeTurn({
    provider: "codex", threadId: "thread", turnId: "turn-1", projectRoot: "D:/repo",
    summary: "Implemented", status: "completed", changedFiles: ["src/app.mjs"],
  });
  const frozen = await service.freeze({
    workspaceId: workspace.id,
    actorStreamId: owner.id,
    changeSetId: observed.id,
    ...freezeEvidence(),
  });
  const batch = service.createReleaseBatch({
    workspaceId: workspace.id,
    planRevision: "plan-1",
    changeSetIds: [frozen.id],
    repositoryRevisions: [{ projectRoot: "D:/repo", revision: "b".repeat(40) }],
    publicationEvidence: { verified: true },
    deploymentEvidence: { contour: "candidate" },
  });

  assert.equal(batch.status, "prepared");
  assert.deepEqual(batch.changeSetIds, [frozen.id]);
  assert.equal(service.releaseBatches({ workspaceId: workspace.id })[0].id, batch.id);
});
