import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  publishChanged,
  RELEASE_CANDIDATE_CONTOUR_LABEL,
} from "../../publish-changed.mjs";

const previousLocalAppData = process.env.LOCALAPPDATA;
const fixtureLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-candidate-contour-lock-"));
process.env.LOCALAPPDATA = fixtureLocalAppData;
test.after(() => {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  fs.rmSync(fixtureLocalAppData, { recursive: true, force: true });
});

test("full publication verifies the exact release candidate before expensive tests and deployment", async () => {
  const steps = [];
  await publishChanged(["--from", "base", "--skip-restart", "--full-tests"], {
    run: async (step) => steps.push(step),
    restart: async () => assert.fail("restart must be skipped"),
    readState: async () => null,
    writeState: async () => {},
    revision: async () => "release-head",
    diff: async () => ["AgentHub/assets/web-app/hub-client.js"],
    ensureWorkerDependency: async () => {},
    readRuntimeStatus: async () => ({
      current: "release-test", runningRelease: "release-test", running: true, ready: true,
    }),
    verifyRestart: async () => {},
    finalizePublication: async () => ({ status: "completed" }),
  });

  const labels = steps.map((step) => step.label);
  const candidate = steps.find((step) => step.label === RELEASE_CANDIDATE_CONTOUR_LABEL);
  assert.deepEqual(candidate.args.slice(-5), [
    "run",
    "contour:verify",
    "--",
    "--require-installed",
    "--release-candidate",
  ]);
  assert.ok(labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < labels.indexOf("Полные тесты Agent Hub"));
  assert.ok(labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < labels.indexOf("Развёртывание Mini App Worker"));
  assert.ok(labels.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < labels.indexOf("Сборка runtime-релиза"));
});
