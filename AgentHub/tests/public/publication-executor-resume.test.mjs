import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishChanged, parseChangedArguments, RELEASE_CANDIDATE_CONTOUR_LABEL, needsVisualPublicationTests } from "../../publish-changed.mjs";
import { publicationCheckpointStore } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../../src/infrastructure/persistence/publication-run-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-executor-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { LOCALAPPDATA: root };
  const journal = () => publicationRunStore({ environment });
  const checkpoint = publicationCheckpointStore(path.join(root, "checkpoint.json"));
  return {
    journal,
    options: {
      checkpoint, journal: journal(), runtimeRoot: root,
      exclusive: async (operation) => operation(),
      readState: async () => ({ revision: "base" }), writeState: async () => {},
      revision: async () => "head", diff: async () => ["AgentHub/assets/web-app/app.js"],
      ensureWorkerDependency: async () => {},
      readRuntimeStatus: async () => ({ current: "new", runningRelease: "new", running: true, ready: true }),
      restart: async () => assert.fail("already ready runtime does not restart"),
      verifyRestart: async () => {},
    },
  };
}

test("explicit quick selection and Workspace survive a failed stage and a new executor process", async (t) => {
  const { options, journal } = await fixture(t);
  const first = [];
  await assert.rejects(publishChanged(["--quick", "--workspace", "workspace"], {
    ...options, run: async (step) => {
      first.push(step.label);
      if (step.label === "Проверка Mini App Worker") throw new Error("verification offline");
    },
  }), /verification offline/u);
  const before = await options.journal.read();
  const resumed = [];
  const result = await publishChanged(["--resume"], {
    ...options, journal: journal(), run: async (step) => resumed.push(step.label),
  });
  const after = await options.journal.read();
  assert.equal(after.identity.validationMode, "quick");
  assert.equal(after.identity.workspaceId, "workspace");
  assert.equal(after.runId, before.runId);
  assert.equal(first.includes("Unit-тесты Agent Hub"), false);
  assert.equal(first.includes("Полные тесты Agent Hub"), false);
  assert.equal(resumed.includes("Проверка синтаксиса Agent Hub"), false);
  assert.equal(resumed.includes("Развёртывание Mini App Worker"), false);
  assert.equal(result.status, "published");
  assert.equal(result.publicationOnly, true);
});

test("full validation checks the candidate before the long suite and publishes Git before deployment", async (t) => {
  const { options } = await fixture(t);
  const events = [];
  const result = await publishChanged(["--full-tests"], {
    ...options,
    preparePublication: async () => ({ planRevision: "frozen" }),
    run: async (step) => events.push(step.label),
    publishGit: async (identity) => { assert.equal(identity.release.planRevision, "frozen"); events.push("Git"); },
    writeState: async () => events.push("record"),
    finalizePublication: async ({ finalizationCommandId }) => {
      assert.ok(finalizationCommandId);
      events.push("finalize");
      return { status: "completed" };
    },
  });
  assert.ok(events.indexOf(RELEASE_CANDIDATE_CONTOUR_LABEL) < events.indexOf("Полные тесты Agent Hub"));
  assert.ok(events.indexOf("Полные тесты Agent Hub") < events.indexOf("Git"));
  assert.ok(events.indexOf("Git") < events.indexOf("Сборка runtime-релиза"));
  assert.ok(events.indexOf("record") < events.indexOf("finalize"));
  assert.equal(result.status, "succeeded");
  assert.equal(result.publicationOnly, false);
});

test("resume refuses an unrelated candidate before running stages", async (t) => {
  const { options } = await fixture(t);
  await assert.rejects(publishChanged(["--resume"], { ...options, run: () => assert.fail("cannot run") }), /No matching publication candidate/u);
  assert.throws(() => parseChangedArguments(["--quick", "--full-tests"]), /either quick or full/u);
});

test("the same command after a lost completion response does not repeat publication", async (t) => {
  const { options, journal } = await fixture(t);
  let state = { revision: "base" };
  const common = { ...options, readState: async () => state, writeState: async (value) => { state = value; } };
  await publishChanged(["--quick"], { ...common, run: async () => {} });
  const result = await publishChanged(["--resume"], {
    ...common, journal: journal(), run: () => assert.fail("completed stages cannot repeat"),
    diff: () => assert.fail("same exact publication already has its file set"),
  });
  assert.equal(result.alreadyCompleted, true);
  assert.equal(result.status, "published");
});

test("a saved Git stage still fences remote movement before resumed deployment", async (t) => {
  const { options, journal } = await fixture(t);
  const preparePhases = [];
  const common = {
    ...options,
    preparePublication: async (_identity, phase) => {
      preparePhases.push(phase.completionOnly);
      return { planRevision: "frozen" };
    },
  };
  await assert.rejects(publishChanged(["--quick"], {
    ...common, publishGit: async () => ({ status: "published" }),
    run: async (step) => {
      if (step.label === "Сборка runtime-релиза") throw new Error("deploy interrupted");
    },
  }), /deploy interrupted/u);
  assert.ok((await options.checkpoint.read()).completedLabels.includes("Публикация Git"));
  const resumed = [];
  await assert.rejects(publishChanged(["--resume"], {
    ...common, journal: journal(),
    publishGit: async () => { throw new Error("origin/main changed"); },
    run: async (step) => resumed.push(step.label),
  }), /origin\/main changed/u);
  assert.equal(resumed.includes("Сборка runtime-релиза"), false);
  assert.equal(resumed.includes("Развёртывание Mini App Worker"), false);
  assert.equal(resumed.includes("Активация runtime-релиза"), false);
  assert.deepEqual(preparePhases, [false, false]);
});

test("executor resumes a pending finalization without another deployment or Git stage", async (t) => {
  const { options, journal } = await fixture(t);
  const phases = [];
  const common = {
    ...options,
    preparePublication: async (_identity, phase) => { phases.push(phase.completionOnly); return { planRevision: "frozen" }; },
  };
  const first = await publishChanged(["--quick"], {
    ...common, run: async () => {}, publishGit: async () => {},
    finalizePublication: async () => ({ status: "retry_required" }),
  });
  assert.equal(first.status, "awaiting_finalization");
  await assert.rejects(publishChanged(["--resume", "--from", "different-base"], {
    ...common, journal: journal(),
    run: async () => assert.fail("mismatched resume cannot deploy"),
  }), /Resume source revision differs/u);
  const resumed = await publishChanged(["--resume"], {
    ...common, journal: journal(),
    run: async () => assert.fail("completion cannot deploy again"),
    publishGit: async () => assert.fail("completion cannot push again"),
    finalizePublication: async () => ({ status: "completed" }),
  });
  assert.equal(resumed.status, "succeeded");
  assert.deepEqual(phases, [false, true]);
});

test("an explicit contour request cannot reuse an earlier completion without that gate", async (t) => {
  const { options, journal } = await fixture(t);
  let state = { revision: "base" };
  const common = { ...options, readState: async () => state, writeState: async (value) => { state = value; } };
  await publishChanged(["--quick"], { ...common, run: async () => {} });
  const steps = [];
  const result = await publishChanged(["--resume", "--test-contour"], {
    ...common, journal: journal(), run: async (step) => steps.push(step.label),
  });
  assert.notEqual(result.alreadyCompleted, true);
  assert.ok(steps.includes("Тестовый контур Agent Hub"));
});

test("focused visual matrices are selected only for affected UI and renderer paths", async (t) => {
  for (const file of ["AgentHub/assets/web-app/app.js", "AgentHub/theme-registry.cjs", "AgentHub/work-log.css",
    "AgentHub/src/application/work-log-usage-projection.mjs", "AgentHub/VSCodeExtension/src/panel.js"]) {
    assert.equal(needsVisualPublicationTests([file]), true, file);
  }
  assert.equal(needsVisualPublicationTests(["AgentHub/src/infrastructure/persistence/runtime-store.mjs"]), false);
  const { options } = await fixture(t);
  for (const [args, files, expected] of [
    [[], ["AgentHub/assets/web-app/app.js"], true],
    [[], ["AgentHub/src/infrastructure/persistence/runtime-store.mjs"], false],
    [["--full-tests"], ["AgentHub/assets/web-app/app.js"], false],
    [["--quick"], ["AgentHub/assets/web-app/app.js"], false],
  ]) {
    const steps = [];
    await publishChanged(args, { ...options, diff: async () => files, run: async (step) => steps.push(step) });
    assert.equal(steps.some((step) => step.args?.includes("test:visual")), expected);
  }
});
