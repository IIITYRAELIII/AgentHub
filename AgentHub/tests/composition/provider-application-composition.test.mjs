import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { resumePostTurnWork } from "../../src/composition/provider-application-composition.mjs";

const ROOT = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("../../src/composition/provider-application-composition.mjs", import.meta.url);

test("provider application phase owns provider, accounting and catalog assembly", async () => {
  const [root, owner] = await Promise.all([
    readFile(ROOT, "utf8"),
    readFile(OWNER, "utf8"),
  ]);
  for (const factory of [
    "createProviderProcessComposition",
    "createRunAccountingComposition",
    "createRuntimeDataComposition",
    "createCodexObservabilityComposition",
    "createRunCompletionComposition",
    "createCodexContextMaintenanceComposition",
    "createBackgroundWorkComposition",
    "createProviderSnapshotComposition",
    "createProviderOperationComposition",
    "createProviderCatalogComposition",
    "createProviderStartupComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by provider application phase`);
  }
  assert.equal(root.includes("createProviderApplicationComposition"), true);
  assert.equal(owner.includes("providerStartup.bind("), true);
});

test("pending runtime restart keeps deferred inputs asleep until restart scheduling", async () => {
  const events = [];
  let finishMaintenance;
  const maintenance = new Promise((resolve) => { finishMaintenance = resolve; });

  assert.equal(resumePostTurnWork({
    maintenance,
    restartPending: true,
    wakeDeferredInputs: () => events.push("wake"),
    scheduleDeferredRestartIfReady: () => events.push("restart"),
  }), "restart");
  assert.deepEqual(events, []);

  finishMaintenance();
  await maintenance;
  await Promise.resolve();
  assert.deepEqual(events, ["restart"]);
});

test("completed turn wakes deferred inputs when restart is not pending", () => {
  const events = [];
  assert.equal(resumePostTurnWork({
    maintenance: Promise.resolve(),
    restartPending: false,
    wakeDeferredInputs: () => events.push("wake"),
    scheduleDeferredRestartIfReady: () => events.push("restart"),
  }), "deferred-inputs");
  assert.deepEqual(events, ["wake"]);
});
