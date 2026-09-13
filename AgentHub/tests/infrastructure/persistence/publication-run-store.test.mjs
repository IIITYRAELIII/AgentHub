import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publicationRunPaths,
  publicationRunStore,
  readPublicationRunStatus,
} from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { withPublicationLock } from "../../../src/infrastructure/process/publication-lock.mjs";

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
