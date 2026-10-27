import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";

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

test("failed file reports bounded owner facts before a running sibling and preserves its exact error", async () => {
  let releaseSibling, reportFailure;
  const sibling = new Promise(resolve => { releaseSibling = resolve; });
  const reported = new Promise(resolve => { reportFailure = resolve; });
  const original = Object.assign(new Error("private message must not enter the timing log"), {
    code: "EBUSY", syscall: "unlink", testPhase: "cleanup", testExecutionSucceeded: true,
    testRoot: path.join(os.tmpdir(), "ah-owned-report"),
    testChild: { pid: 123, closedAt: "2026-10-25T00:00:01.000Z", code: 0, arguments: "private arguments" },
  });
  original.path = path.join(original.testRoot, "owned.lock");
  original.cause = original;
  original.errors = Array(12).fill(original);
  original.errors[0] = Object.assign(new Error("private foreign failure"), {
    testRoot: original.testRoot, path: path.join(original.testRoot, "..", "private-foreign-path"),
  });
  const checkpoint = memoryCheckpoint();
  const operation = runCheckpointedTestFiles(["failed", "sibling"], {
    suite: "unit", identity: "release", checkpoint, concurrency: 2,
    execution: async () => ({ parallel: true, shared: [] }), log: () => {},
    run: async file => { if (file === "failed") throw original; await sibling; },
    onFile: event => { if (event.outcome === "failed") reportFailure(event); },
  });
  const terminal = operation.then(() => null, error => error);
  try {
    const event = await reported;
    assert.equal(event.failure.code, "EBUSY");
    assert.equal(event.failure.testExecutionSucceeded, true);
    assert.equal(event.failure.path, original.path);
    assert.equal(event.failure.child.pid, 123);
    assert.equal(event.failure.child.code, 0);
    assert.equal(event.failure.errors.length, 4);
    assert.equal(event.failure.omittedErrors, 8);
    const serialized = JSON.stringify(event);
    assert.equal(serialized.includes("private message"), false);
    assert.equal(serialized.includes("private arguments"), false);
    assert.equal(serialized.includes("private-foreign-path"), false);
    assert.ok(serialized.length < 32_768);
    assert.equal(checkpoint.value().suites.unit.completedFingerprints.failed, undefined);
  } finally { releaseSibling(); }
  const result = await terminal;
  assert.ok(result instanceof AggregateError);
  assert.equal(result.errors[0], original);
  assert.equal(checkpoint.value().suites.unit.completedFingerprints.failed, undefined);
});

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

test("a different release identity preserves content-proven successful files", async () => {
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

  assert.deepEqual(files, []);
});

test("unknown inputs rerun and legacy checkpoints cannot supply success", async () => {
  const checkpoint = memoryCheckpoint();
  await checkpoint.write({ identity: "release", suites: { unit: { completedFingerprints: { "a": "unchanged" } } } });
  let calls = 0;
  const options = { suite: "unit", identity: "release", checkpoint, run: async () => { calls += 1; }, log: () => {} };
  await runCheckpointedTestFiles(["a"], options);
  assert.equal(calls, 1);
  await runCheckpointedTestFiles(["a"], { ...options, fingerprint: async () => null });
  await runCheckpointedTestFiles(["a"], { ...options, fingerprint: async () => null });
  assert.equal(calls, 3);
  assert.deepEqual(checkpoint.value().suites.unit.completedFingerprints, {});
});

test("successful evidence expires and the retained entry count stays bounded", async () => {
  const checkpoint = memoryCheckpoint();
  let clock = 100;
  const options = { suite: "unit", identity: "release", checkpoint, run: async () => { clock += 1; }, now: () => clock, retentionMs: 10, maxEntries: 2, log: () => {} };
  await runCheckpointedTestFiles(["a", "b", "c"], options);
  assert.deepEqual(Object.keys(checkpoint.value().suites.unit.completedFingerprints), ["b", "c"]);
  clock += 11;
  const runs = [];
  await runCheckpointedTestFiles(["b", "c"], { ...options, run: async (file) => runs.push(file) });
  assert.deepEqual(runs, ["b", "c"]);
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

test("isolated files use bounded parallelism without changing the selected set", async () => {
  const files = ["a", "b", "c", "exclusive"];
  const started = [];
  let active = 0;
  let maximumActive = 0;
  await runCheckpointedTestFiles(files, {
    concurrency: 2,
    log: () => {},
    execution: async (file) => file === "exclusive"
      ? { parallel: false, shared: [] }
      : { parallel: true, shared: [] },
    run: async (file) => {
      started.push([file, active]);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    },
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(started.map(([file]) => file).toSorted(), files.toSorted());
  assert.deepEqual(started.find(([file]) => file === "exclusive"), ["exclusive", 0]);
});

test("shared resource declarations serialize only conflicting files", async () => {
  const active = new Set();
  const overlaps = [];
  await runCheckpointedTestFiles(["git-a", "git-b", "browser"], {
    concurrency: 2,
    log: () => {},
    execution: async (file) => ({
      parallel: true,
      shared: file.startsWith("git") ? ["shared-git"] : ["browser-profile"],
    }),
    run: async (file) => {
      overlaps.push([file, [...active].toSorted()]);
      active.add(file);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active.delete(file);
    },
  });

  const gitB = overlaps.find(([file]) => file === "git-b");
  assert.equal(gitB[1].includes("git-a"), false);
  assert.equal(overlaps.some(([file, running]) => file === "browser" && running.length === 1), true);
});

test("parallel failures retain deterministic file order and successful checkpoints", async () => {
  const checkpoint = memoryCheckpoint();
  await assert.rejects(runCheckpointedTestFiles(["slow", "fast", "ok"], {
    suite: "unit",
    identity: "release",
    checkpoint,
    concurrency: 2,
    log: () => {},
    execution: async () => ({ parallel: true, shared: [] }),
    fingerprint: async (file) => `fingerprint-${file}`,
    run: async (file) => {
      if (file === "slow") {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("slow failed");
      }
      if (file === "fast") throw new Error("fast failed");
    },
  }), (error) => {
    assert.equal(error instanceof AggregateError, true);
    assert.match(error.message, /slow: slow failed\nfast: fast failed/u);
    return true;
  });
  assert.deepEqual(checkpoint.value().suites.unit.completedFingerprints, {
    ok: "fingerprint-ok",
  });
});

test("uncached files report stable content-free miss reasons", async () => {
  const messages = [];
  await runCheckpointedTestFiles(["opaque.test.mjs"], {
    suite: "unit",
    identity: "release",
    checkpoint: memoryCheckpoint(),
    fingerprint: async () => ({
      fingerprint: null,
      missReasons: ["undeclared-network-fetch", "undeclared-global:process"],
    }),
    run: async () => {},
    log: (message) => messages.push(message),
  });
  assert.deepEqual(messages, [
    "Тест без кэша (undeclared-network-fetch, undeclared-global:process): opaque.test.mjs",
  ]);
});

test("checkpoint write failure waits for started siblings and stops new admission", async () => {
  let releaseSibling;
  const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
  const started = [];
  let siblingFinished = false;
  let settled = false;
  const persistenceFailure = new Error("checkpoint storage unavailable");
  const operation = runCheckpointedTestFiles(["first", "sibling", "later"], {
    suite: "unit",
    identity: "release",
    checkpoint: {
      read: async () => null,
      write: async () => { throw persistenceFailure; },
    },
    concurrency: 2,
    log: () => {},
    execution: async () => ({ parallel: true, shared: [] }),
    run: async (file) => {
      started.push(file);
      if (file === "sibling") {
        await siblingGate;
        siblingFinished = true;
      }
    },
  }).finally(() => { settled = true; });

  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["first", "sibling"]);
  assert.equal(settled, false);
  releaseSibling();
  await assert.rejects(operation, (error) => error === persistenceFailure);
  assert.equal(siblingFinished, true);
  assert.equal(started.includes("later"), false);
});
