import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  failedFrozenPublicationEvidence,
  PUBLICATION_STAGE_CONTRACT,
  publicationRunPaths,
  publicationRunStore,
  readPublicationRunStatus,
} from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { withPublicationLock } from "../../../src/infrastructure/process/publication-lock.mjs";

function failedRunEvidenceFixture(statuses) {
  const labels = PUBLICATION_STAGE_CONTRACT.map((stage) => stage.label);
  const identity = {
    mode: "changed", from: "main", revision: "a".repeat(40), runtimeRoot: "runtime",
    worktreeRoot: "release", validationMode: "full", artifactProtocol: 1, labels,
    release: {
      workspaceId: "workspace", planRevision: "b".repeat(64), manifestHash: "c".repeat(64),
      preReleaseHead: "a".repeat(40), primaryRoot: "primary",
    },
  };
  return {
    run: {
      version: 2, stageContractVersion: 1, runId: "failed-run", status: "failed",
      finishedAt: "2026-09-22T00:00:00.000Z", currentStep: null, progress: {}, identity,
      steps: PUBLICATION_STAGE_CONTRACT.map((stage, index) => ({
        label: stage.label, stageId: stage.id, status: statuses[index] ?? "pending",
      })),
    },
    checkpoint: {
      identity,
      checkpointScope: { mode: "changed", from: "main", runtimeRoot: "runtime", validationMode: "full" },
      completedLabels: [labels[0]], completedFingerprints: { [labels[0]]: "contour" },
    },
  };
}

test("failed-frozen evidence accepts only exact terminal validation vectors", () => {
  const contour = failedRunEvidenceFixture(["failed", "pending"]);
  assert.equal(failedFrozenPublicationEvidence(contour.run, null, { expectedRunId: "failed-run" }).failedStageId,
    "release-candidate-contour");
  const tests = failedRunEvidenceFixture(["completed", "failed"]);
  assert.equal(failedFrozenPublicationEvidence(tests.run, tests.checkpoint, { expectedRunId: "failed-run" }).failedStageId,
    "agent-hub-full-tests");
  for (const statuses of [
    ["pending", "pending"], ["completed", "pending"], ["completed", "completed"],
    ["failed", "failed"], ["reused", "pending"],
  ]) {
    const fixture = failedRunEvidenceFixture(statuses);
    assert.throws(() => failedFrozenPublicationEvidence(fixture.run, fixture.checkpoint, {
      expectedRunId: "failed-run",
    }), /terminal pre-effect validation failure/u);
  }
  const active = failedRunEvidenceFixture(["failed", "pending"]);
  active.run.status = "running";
  assert.throws(() => failedFrozenPublicationEvidence(active.run, null, { expectedRunId: "failed-run" }),
    /terminal failed publication run/u);
  const progressed = failedRunEvidenceFixture(["failed", "pending"]);
  progressed.run.progress = { publicationState: true };
  assert.throws(() => failedFrozenPublicationEvidence(progressed.run, null, { expectedRunId: "failed-run" }),
    /terminal failed publication run/u);
  const missingStage = failedRunEvidenceFixture(["failed", "pending"]);
  missingStage.run.steps.pop();
  missingStage.run.identity.labels.pop();
  assert.throws(() => failedFrozenPublicationEvidence(missingStage.run, null, { expectedRunId: "failed-run" }),
    /unknown or incomplete publication stage contract/u);
  const emptyPrior = failedRunEvidenceFixture(["failed", "pending"]);
  emptyPrior.checkpoint.identity = structuredClone(emptyPrior.run.identity);
  Object.assign(emptyPrior.checkpoint.identity, { revision: "d".repeat(40) });
  Object.assign(emptyPrior.checkpoint.identity.release, {
    planRevision: "e".repeat(64), manifestHash: "f".repeat(64), preReleaseHead: "d".repeat(40),
  });
  emptyPrior.checkpoint.completedLabels = [];
  emptyPrior.checkpoint.completedFingerprints = {};
  assert.throws(() => failedFrozenPublicationEvidence(emptyPrior.run, emptyPrior.checkpoint, {
    expectedRunId: "failed-run",
  }), /no durable pre-effect prefix/u);
  const invalidFingerprint = failedRunEvidenceFixture(["failed", "pending"]);
  invalidFingerprint.checkpoint.identity = structuredClone(emptyPrior.checkpoint.identity);
  invalidFingerprint.checkpoint.completedFingerprints[invalidFingerprint.checkpoint.completedLabels[0]] = null;
  assert.throws(() => failedFrozenPublicationEvidence(invalidFingerprint.run, invalidFingerprint.checkpoint, {
    expectedRunId: "failed-run",
  }), /checkpoint fingerprints are invalid/u);
});

test("publication run status and log survive the terminal process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-run-"));
  try {
    const environment = { LOCALAPPDATA: root };
    const journal = publicationRunStore({
      environment,
      now: (() => {
        let second = 0;
        return () => new Date(Date.UTC(2026, 7, 21, 12, 0, second++));
      })(),
      createId: () => "run-id",
    });
    await journal.start({ mode: "changed" }, [{ label: "Tests" }]);
    await journal.stepStarted("Tests");
    await journal.stepFinished("Tests", { status: "completed" });
    await journal.finish("succeeded");

    const status = await readPublicationRunStatus(publicationRunPaths(environment).statusFile);
    assert.equal(status.status, "succeeded");
    assert.equal(status.steps[0].status, "completed");
    assert.match(await readFile(status.logFile, "utf8"), /Agent Hub publication run-id/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a completed publication is archived exactly before the next identity replaces status", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-terminal-"));
  try {
    const environment = { LOCALAPPDATA: root };
    const paths = publicationRunPaths(environment);
    const first = publicationRunStore({ environment, createId: () => "completed-run" });
    await first.start({ mode: "changed", revision: "published" }, [{ label: "Publish" }]);
    await first.stepStarted("Publish");
    await first.stepFinished("Publish", { status: "completed" });
    await first.updateProgress({ publicationState: { revision: "published", generation: "generation" } });
    await first.finish("succeeded");
    const completed = await readPublicationRunStatus(paths.statusFile);

    const replacement = publicationRunStore({ environment, createId: () => "next-run" });
    await replacement.start({ mode: "changed", revision: "next" }, [{ label: "Tests" }]);

    assert.deepEqual(await readPublicationRunStatus(`${completed.logFile}.status.json`), completed);
    assert.equal((await readPublicationRunStatus(paths.statusFile)).runId, "next-run");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead pre-effect run is archived exactly before a different candidate starts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-publication-interrupt-"));
  try {
    const environment = { LOCALAPPDATA: root };
    const paths = publicationRunPaths(environment);
    const labels = [
      "Проверка release candidate в изолированном контуре",
      "Полные тесты Agent Hub",
      "Публикация Git",
    ];
    const oldIdentity = { mode: "changed", revision: "old", labels };
    const old = publicationRunStore({
      environment, createId: () => "old-run", ownerPid: () => 424242,
    });
    await old.start(oldIdentity, labels.map((label) => ({ label })));
    await old.stepStarted(labels[0]);
    await old.stepFinished(labels[0], { status: "completed" });
    await old.stepStarted(labels[1]);
    await publicationCheckpointStore(path.join(root, "AgentHub", "publication-checkpoint.json")).write({
      identity: oldIdentity,
      completedLabels: [labels[0]],
      completedFingerprints: { [labels[0]]: "fingerprint" },
    });
    const oldStatus = await readPublicationRunStatus(paths.statusFile);
    let interruptAfterArchive = true;
    const replacement = publicationRunStore({
      environment,
      createId: () => "new-run",
      isProcessAlive: () => false,
      afterInterruptedArchive: async () => {
        if (interruptAfterArchive) {
          interruptAfterArchive = false;
          throw new Error("crash after archive");
        }
      },
    });
    const newIdentity = { mode: "changed", revision: "new", labels };
    await withPublicationLock(async () => {
      await assert.rejects(
        replacement.start(newIdentity, labels.map((label) => ({ label }))),
        /crash after archive/u,
      );
    }, { environment });
    assert.deepEqual(await readPublicationRunStatus(paths.statusFile), oldStatus);
    const archiveFile = `${oldStatus.logFile}.status.json`;
    const interrupted = await readPublicationRunStatus(archiveFile);
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.runId, "old-run");
    assert.equal(interrupted.steps[1].status, "interrupted");
    assert.equal(interrupted.interruption.kind, "pre_effect_candidate_replacement");

    await withPublicationLock(
      () => replacement.start(newIdentity, labels.map((label) => ({ label }))),
      { environment },
    );
    const current = await readPublicationRunStatus(paths.statusFile);
    assert.equal(current.runId, "new-run");
    assert.equal(current.status, "running");
    assert.deepEqual(await readPublicationRunStatus(archiveFile), interrupted);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const scenario of ["live", "effect", "progress", "checkpoint", "missing-checkpoint"]) {
  test(`a different candidate cannot replace an ambiguous ${scenario} run`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `agent-hub-publication-${scenario}-`));
    try {
      const environment = { LOCALAPPDATA: root };
      const paths = publicationRunPaths(environment);
      const labels = [
        "Проверка release candidate в изолированном контуре",
        "Полные тесты Agent Hub",
        "Публикация Git",
      ];
      const identity = { mode: "changed", revision: "old", labels };
      const old = publicationRunStore({ environment, createId: () => "old", ownerPid: () => 424242 });
      await old.start(identity, labels.map((label) => ({ label })));
      await old.stepStarted(scenario === "effect" ? labels[2] : labels[1]);
      if (scenario === "progress") await old.updateProgress({ publicationState: { revision: "old" } });
      const checkpointIdentity = scenario === "checkpoint" ? { ...identity, revision: "other" } : identity;
      if (scenario !== "missing-checkpoint") {
        await publicationCheckpointStore(path.join(root, "AgentHub", "publication-checkpoint.json")).write({
          identity: checkpointIdentity,
          completedLabels: [],
          completedFingerprints: {},
        });
      }
      const before = await readFile(paths.statusFile, "utf8");
      const replacement = publicationRunStore({
        environment,
        createId: () => "new",
        isProcessAlive: () => scenario === "live",
      });
      await withPublicationLock(async () => {
        await assert.rejects(
          replacement.start({ ...identity, revision: "new" }, labels.map((label) => ({ label }))),
          /live writer|effect stage|durable publication progress|checkpoint belongs|checkpoint is required/u,
        );
      }, { environment });
      assert.equal(await readFile(paths.statusFile, "utf8"), before);
      await assert.rejects(readFile(`${(await readPublicationRunStatus(paths.statusFile)).logFile}.status.json`, "utf8"),
        /ENOENT/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
