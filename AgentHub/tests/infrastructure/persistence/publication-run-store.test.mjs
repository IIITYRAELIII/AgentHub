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
