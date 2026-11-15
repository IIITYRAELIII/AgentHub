import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationCheckpointStore, runPublicationSteps } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";

test("public installer handoff leaves its step pending and preserves the exact completed prefix", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-installer-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
    candidate: "a".repeat(64), targetId: "production" };
  const identity = { mode: "changed", revision: "b".repeat(40), runtimeRoot: root,
    publicInstallerBinding: binding, labels: ["Validated prefix", "Установка runtime-релиза", "Remaining stage"] };
  const journal = publicationRunStore({ runtimeRoot: root });
  const checkpoint = publicationCheckpointStore(path.join(root, "checkpoint.json"));
  let ready = false;
  const calls = [];
  const handoff = { kind: "public-runtime-installer-handoff-v1", status: "waiting", binding };
  const steps = [
    { label: identity.labels[0], fingerprint: "prefix", execute: () => calls.push("prefix") },
    { label: identity.labels[1], reusable: false, publicInstallerBinding: binding,
      execute: () => { calls.push("installer"); return ready ? undefined : handoff; } },
    { label: identity.labels[2], execute: () => calls.push("remaining") },
  ];
  const options = { identity, checkpoint, journal, run: step => step.execute() };
  assert.deepEqual(await runPublicationSteps(steps, options), handoff);
  assert.deepEqual(calls, ["prefix", "installer"]);
  const waiting = await checkpoint.read();
  assert.deepEqual(waiting.completedLabels, [identity.labels[0]]);
  assert.equal(waiting.completedFingerprints[identity.labels[1]], undefined);
  assert.equal((await journal.read()).steps.find(step => step.label === identity.labels[1]).status, "waiting");
  ready = true;
  await runPublicationSteps(steps, options);
  assert.deepEqual(calls, ["prefix", "installer", "installer", "remaining"]);
  assert.deepEqual((await checkpoint.read()).completedLabels, identity.labels);
});

test("a foreign installer handoff cannot complete a step or erase its prior checkpoint", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-installer-foreign-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binding = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
    candidate: "a".repeat(64), targetId: "production" };
  const identity = { revision: "b".repeat(40), publicInstallerBinding: binding };
  const checkpoint = publicationCheckpointStore(path.join(root, "checkpoint.json"));
  const prior = { identity, checkpointScope: identity, completedLabels: ["Validated prefix"], completedFingerprints: {} };
  await checkpoint.write(prior);
  let trailing = false;
  await assert.rejects(runPublicationSteps([
    { label: "Установка runtime-релиза", publicInstallerBinding: binding }, { label: "Trailing" },
  ], { identity, checkpoint, run: step => {
    if (step.label === "Trailing") { trailing = true; return; }
    return { kind: "public-runtime-installer-handoff-v1", status: "waiting",
      binding: { ...binding, generation: 3 } };
  } }), /installer.*binding/u);
  assert.equal(trailing, false);
  assert.deepEqual(await checkpoint.read(), prior);
});
