import assert from "node:assert/strict";
import test from "node:test";

import { runCheckpointedTestFiles } from "../../../src/infrastructure/persistence/test-file-checkpoint.mjs";

function memoryCheckpoint() {
  let value = null;
  return {
    read: async () => value,
    write: async (next) => { value = structuredClone(next); },
    clear: async () => { value = null; },
    value: () => value,
  };
}

test("test files report every failure and resume only failed files", async () => {
  const checkpoint = memoryCheckpoint();
  const firstRun = [];
  await assert.rejects(
    runCheckpointedTestFiles(["a.test.mjs", "b.test.mjs", "c.test.mjs"], {
      suite: "unit",
      identity: "release-1",
      checkpoint,
      run: async (file) => {
        firstRun.push(file);
        if (file === "b.test.mjs") throw new Error("failed");
      },
    }),
    /failed/u,
  );

  const resumedRun = [];
  await runCheckpointedTestFiles(["a.test.mjs", "b.test.mjs", "c.test.mjs"], {
    suite: "unit",
    identity: "release-1",
    checkpoint,
    run: async (file) => resumedRun.push(file),
    log: () => {},
  });

  assert.deepEqual(firstRun, ["a.test.mjs", "b.test.mjs", "c.test.mjs"]);
  assert.deepEqual(resumedRun, ["b.test.mjs"]);
});

test("a different release identity starts the suite from the beginning", async () => {
  const checkpoint = memoryCheckpoint();
  await runCheckpointedTestFiles(["a.test.mjs", "b.test.mjs"], {
    suite: "unit",
    identity: "release-1",
    checkpoint,
    run: async () => {},
  });

  const files = [];
  await runCheckpointedTestFiles(["a.test.mjs", "b.test.mjs"], {
    suite: "unit",
    identity: "release-2",
    checkpoint,
    run: async (file) => files.push(file),
  });

  assert.deepEqual(files, ["a.test.mjs", "b.test.mjs"]);
});

test("suite manifests are checkpointed independently", async () => {
  const checkpoint = memoryCheckpoint();
  await runCheckpointedTestFiles(["architecture.test.mjs"], {
    suite: "architecture",
    identity: "release-1",
    checkpoint,
    run: async () => {},
  });
  await runCheckpointedTestFiles(["unit.test.mjs"], {
    suite: "unit",
    identity: "release-1",
    checkpoint,
    run: async () => {},
  });

  assert.deepEqual(Object.keys(checkpoint.value().suites).toSorted(), ["architecture", "unit"]);
});

test("changed fingerprints rerun only affected test files", async () => {
  const checkpoint = memoryCheckpoint();
  const fingerprints = new Map([["a.test.mjs", "a1"], ["b.test.mjs", "b1"]]);
  await runCheckpointedTestFiles([...fingerprints.keys()], {
    suite: "unit",
    identity: "release-base",
    checkpoint,
    fingerprint: async (file) => fingerprints.get(file),
    run: async () => {},
  });
  fingerprints.set("b.test.mjs", "b2");
  const rerun = [];
  await runCheckpointedTestFiles([...fingerprints.keys()], {
    suite: "unit",
    identity: "release-base",
    checkpoint,
    fingerprint: async (file) => fingerprints.get(file),
    run: async (file) => rerun.push(file),
    log: () => {},
  });
  assert.deepEqual(rerun, ["b.test.mjs"]);
});
