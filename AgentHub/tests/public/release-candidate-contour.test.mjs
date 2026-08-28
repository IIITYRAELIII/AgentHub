import assert from "node:assert/strict";
import test from "node:test";

import {
  publishChanged,
  RELEASE_CANDIDATE_CONTOUR_LABEL,
} from "../../publish-changed.mjs";

test("full publication verifies the exact release candidate before deployment", async () => {
  const steps = [];
  await publishChanged(["--from", "base", "--skip-restart", "--full-tests"], {
    run: async (step) => steps.push(step),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "release-head",
    diff: async () => ["AgentHub/assets/web-app/hub-client.js"],
    ensureWorkerDependency: async () => {},
  });

  const labels = steps.map((step) => step.label);
  const candidate = steps.find((step) => step.label === RELEASE_CANDIDATE_CONTOUR_LABEL);
  assert.deepEqual(candidate.args.slice(-4), [
    "run",
    "contour:verify",
    "--",
    "--require-installed",
  ]);
  assert.ok(labels.indexOf("Полные тесты Agent Hub") < labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL));
  assert.ok(labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < labels.indexOf("Развёртывание Mini App Worker"));
  assert.ok(labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < labels.indexOf("Сборка runtime-релиза"));
});
