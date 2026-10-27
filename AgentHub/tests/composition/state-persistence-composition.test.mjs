import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createStatePersistenceComposition } from "../../src/composition/state-persistence-composition.mjs";

test("state persistence snapshots provider settings and pinned titles", async (t) => {
  const calls = [];
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-state-persistence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const titlesFile = path.join(directory, "titles.json");
  const persistence = createStatePersistenceComposition({
    rememberProviderSettings: () => calls.push("settings"),
    selectionStore: { rememberCurrentThread: () => calls.push("selection") },
    runtimeStateCoordinator: { save: async () => calls.push("state") },
    pinnedTaskTitlesFile: titlesFile,
    taskMetadata: { pinnedTitlesSnapshot: () => ({ task: "Title" }) },
  });

  await persistence.saveState();
  await persistence.savePinnedTaskTitles();

  assert.deepEqual(calls, [
    "settings",
    "selection",
    "state",
  ]);
  assert.equal(await readFile(titlesFile, "utf8"), '{\n  "task": "Title"\n}\n');
});
