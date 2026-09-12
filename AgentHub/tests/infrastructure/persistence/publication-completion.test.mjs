import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { completePublication, resumePendingPublicationCompletion } from "../../../src/infrastructure/persistence/publication-completion.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-publication-completion-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const environment = { LOCALAPPDATA: root };
  const journal = publicationRunStore({ environment });
  const checkpoint = publicationCheckpointStore(path.join(root, "checkpoint.json"));
  const identity = { mode: "changed", revision: "head", runtimeRoot: root, validationMode: "quick", release: { planRevision: "plan" } };
  await journal.start(identity, [{ label: "Deploy" }]);
  await checkpoint.write({ identity, completedLabels: ["Deploy"] });
  const records = [];
  const common = {
    identity, publicationState: { revision: "head" }, runtimeRoot: root,
    journal, checkpoint, needsRestart: true, skipRestart: false,
    exclusive: async (operation) => operation(),
    readRuntimeStatus: async () => ({ current: "new", runningRelease: "old", running: true, ready: true }),
    requestRestart: async () => ({ deferred: true }),
    verifyRestart: async () => assert.fail("deferred restart has no readiness"),
    writeState: async (state) => records.push(state),
    finalizePublication: async () => assert.fail("deferred restart cannot finalize"),
  };
  return { environment, common, records, freshJournal: () => publicationRunStore({ environment }) };
}

test("deferred publication persists expected runtime and resumes completion after process recreation", async (t) => {
  const { common, records, freshJournal } = await fixture(t);
  const pending = await completePublication(common);
  assert.equal(pending.status, "awaiting_restart");
  const before = await common.journal.read();
  assert.equal(before.status, "awaiting_restart");
  assert.equal(before.finishedAt, null);
  assert.equal(before.progress.expectedReleaseId, "new");
  assert.equal(before.progress.publicationState.revision, "head");
  assert.equal(records.length, 0);
  assert.ok(await common.checkpoint.read());
  let verified = 0;
  let finalized = 0;
  const result = await resumePendingPublicationCompletion({
    ...common, journal: freshJournal(),
    readRuntimeStatus: async () => ({ current: "new", runningRelease: "new", running: true, ready: true }),
    verifyRestart: async ({ expectedReleaseId }) => { assert.equal(expectedReleaseId, "new"); verified++; },
    finalizePublication: async (identity) => {
      assert.deepEqual(identity.release, { planRevision: "plan" });
      assert.equal(identity.publication.generation, before.progress.publicationState.generation);
      finalized++;
      return { status: "completed" };
    },
  });
  assert.equal(result.status, "succeeded");
  assert.equal(verified, 1);
  assert.equal(finalized, 1);
  assert.equal(records.length, 1);
  assert.equal(await common.checkpoint.read(), null);
  const after = await common.journal.read();
  assert.equal(after.runId, before.runId);
  assert.equal(after.status, "succeeded");
  assert.equal(after.attempts.length, 2);
  assert.equal((await resumePendingPublicationCompletion({ ...common, journal: freshJournal() })).status, "not_pending");
});

test("completion recovery rejects a different installed runtime without publishing or clearing evidence", async (t) => {
  const { common, records, freshJournal } = await fixture(t);
  await completePublication(common);
  await assert.rejects(resumePendingPublicationCompletion({
    ...common, journal: freshJournal(),
    readRuntimeStatus: async () => ({ current: "unrelated", runningRelease: "unrelated", running: true, ready: true }),
  }), /Installed runtime changed/u);
  assert.equal(records.length, 0);
  assert.ok(await common.checkpoint.read());
  assert.equal((await common.journal.read()).status, "failed");
});

test("pending finalization retains the exact generation across retry and cannot clear checkpoints", async (t) => {
  const { common, records, freshJournal } = await fixture(t);
  const ready = {
    ...common,
    readRuntimeStatus: async () => ({ current: "new", runningRelease: "new", running: true, ready: true }),
    verifyRestart: async () => {},
  };
  const result = await completePublication({ ...ready, finalizePublication: async () => ({ status: "retry_required" }) });
  assert.equal(result.status, "awaiting_finalization");
  assert.ok(await common.checkpoint.read());
  await resumePendingPublicationCompletion({ ...ready, journal: freshJournal(), finalizePublication: async () => ({ status: "completed" }) });
  assert.equal(records[0].generation, records[1].generation);
  assert.equal(await common.checkpoint.read(), null);
});

test("interrupted readiness stage can recover without build, deploy or another restart", async (t) => {
  const { common, freshJournal } = await fixture(t);
  await common.journal.updateProgress({ expectedReleaseId: "new", publicationState: { revision: "head", generation: "fixed" } });
  await common.journal.stepStarted("Подтверждение готовности runtime");
  const result = await resumePendingPublicationCompletion({
    ...common, journal: freshJournal(),
    readRuntimeStatus: async () => ({ current: "new", runningRelease: "new", running: true, ready: true }),
    verifyRestart: async () => {}, finalizePublication: async () => ({ status: "completed" }),
    requestRestart: async () => assert.fail("automatic completion must not restart"),
  });
  assert.equal(result.status, "succeeded");
  assert.equal((await common.journal.read()).attempts[1].previousStatus, "running");
});

test("automatic completion never adopts an unrelated root or incomplete legacy status", async (t) => {
  const { common, freshJournal } = await fixture(t);
  assert.equal((await resumePendingPublicationCompletion({ ...common, journal: freshJournal() })).status, "not_pending");
  await completePublication(common);
  assert.equal((await resumePendingPublicationCompletion({ ...common, journal: freshJournal(), runtimeRoot: "other" })).status, "not_pending");
});

test("ambiguous finalization retries the same command while an authoritative partial result advances it", async (t) => {
  const { common, freshJournal } = await fixture(t);
  const ids = [];
  const ready = {
    ...common,
    readRuntimeStatus: async () => ({ current: "new", runningRelease: "new", running: true, ready: true }),
    verifyRestart: async () => {},
  };
  await assert.rejects(completePublication({ ...ready, finalizePublication: async ({ finalizationCommandId }) => {
    ids.push(finalizationCommandId);
    assert.equal((await common.journal.read()).progress.finalizationCommandId, finalizationCommandId);
    throw new Error("response lost");
  } }), /response lost/u);
  await resumePendingPublicationCompletion({ ...ready, journal: freshJournal(), finalizePublication: async ({ finalizationCommandId }) => {
    ids.push(finalizationCommandId);
    return { status: "retry_required" };
  } });
  await resumePendingPublicationCompletion({ ...ready, journal: freshJournal(), finalizePublication: async ({ finalizationCommandId }) => {
    ids.push(finalizationCommandId);
    return { status: "completed" };
  } });
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});
