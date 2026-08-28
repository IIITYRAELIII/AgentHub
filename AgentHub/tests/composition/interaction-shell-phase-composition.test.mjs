import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { requireDesktopTaskSyncStore } from "../../src/composition/interaction-shell-phase-composition.mjs";

const ROOT = new URL("../../src/composition/agent-hub-composition.mjs", import.meta.url);
const OWNER = new URL("../../src/composition/interaction-shell-phase-composition.mjs", import.meta.url);

test("interaction phase owns server, Desktop and run shell assembly", async () => {
  const [root, owner] = await Promise.all([readFile(ROOT, "utf8"), readFile(OWNER, "utf8")]);
  for (const factory of [
    "createServerControlComposition",
    "createDesktopShellComposition",
    "createRunShellComposition",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(owner.includes(factory), true, `${factory} is not owned by interaction phase`);
  }
  assert.equal(root.includes("createInteractionShellPhase"), true);
  assert.match(root, /infrastructure:\s*\{[\s\S]*workspaceCatalogStore,[\s\S]*\},\s*provider: providerApplication/u);
  assert.match(root, /rateLimitHistoryStore, providerTurnTelemetryStore, commandTraceService/u);
  assert.match(root, /rateLimitHistoryStore, commandTraceService, runJournal/u);
  assert.match(owner, /workspaceCatalogStore: infrastructure\.workspaceCatalogStore/u);
  assert.match(owner, /commandTraceService: infrastructure\.commandTraceService/u);
  assert.equal(owner.includes("desktopCommandsPort: ports.desktopCommands"), true);
  assert.equal(owner.includes("runShell: ports.runShell"), true);
  assert.equal(owner.includes("lastTaskMessageRevision: api.lastTaskMessageRevision"), true);
});

test("interaction phase routes the canonical task sync store to Desktop search", () => {
  const taskSyncStore = {
    searchMessages() {},
    messageSearchStatus() {
      return { completedThreads: 1, totalThreads: 1 };
    },
    markMessageSearchThread() {},
  };

  const selected = requireDesktopTaskSyncStore({ taskSyncStore });

  assert.equal(selected, taskSyncStore);
  assert.deepEqual(selected.messageSearchStatus(), {
    completedThreads: 1,
    totalThreads: 1,
  });
});

test("interaction phase rejects an incomplete Desktop search store during composition", () => {
  assert.throws(
    () => requireDesktopTaskSyncStore({ taskSyncStore: { searchMessages() {} } }),
    /provider\.taskSyncStore\.messageSearchStatus is required/u,
  );
});
