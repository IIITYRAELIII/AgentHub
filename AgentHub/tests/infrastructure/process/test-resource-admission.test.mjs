import assert from "node:assert/strict";
import test from "node:test";
import { testResourceAdmission } from "../../../src/infrastructure/process/test-resource-admission.mjs";
import { runCheckpointedTestFiles } from "../../../src/infrastructure/persistence/test-file-checkpoint.mjs";

const gib = 1024 ** 3;
function resource(values = {}) {
  return { cpuFraction: 0.01, hostCpuFraction: 0.1, rssBytes: 100 * 1024 ** 2,
    totalMemory: 16 * gib, freeMemory: 10 * gib, cores: 16, elapsedMs: 500, cpuMs: 10, ...values };
}
async function fixture(values = {}) {
  let current = resource(values);
  let time = 0;
  let closed = false;
  const admission = await testResourceAdmission({
    monitor: { sample: async () => current, close: async () => { closed = true; } },
    clock: () => time,
    wait: async (ms) => { time += ms; },
  });
  return { admission, set: (next) => { current = resource(next); }, closed: () => closed };
}

test("resource admission retains active demand across samples and resumes when work finishes", async () => {
  const f = await fixture();
  for (let i = 0; i < 6; i += 1) { assert.equal(await f.admission.canStart(), true); f.admission.started(); }
  assert.equal(await f.admission.canStart(), false, "startup reserves one core per unsampled launch");
  f.set({ cpuFraction: 0.65, hostCpuFraction: 0.8 });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false);
  f.set({ cpuFraction: 0.02, hostCpuFraction: 0.2 });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false, "a low sample cannot retire the six active reservations");
  f.admission.finished();
  assert.equal(await f.admission.canStart(), true, "settled work releases its reservation");
  f.admission.started();
  for (let i = 0; i < 6; i += 1) f.admission.finished();
  const result = await f.admission.close();
  assert.equal(result.peakActive, 6);
  assert.equal(result.overshootSamples, 1);
  assert.equal(f.closed(), true);
});

test("repeated quiet samples cannot accumulate a later CPU-bound cohort", async () => {
  const f = await fixture({ cores: 12 });
  for (let epoch = 0; epoch < 10; epoch += 1) {
    for (let i = 0; i < 4; i += 1) {
      if (await f.admission.canStart()) f.admission.started();
    }
    assert.equal(await f.admission.canStart(), false);
    f.set({ cores: 12, cpuFraction: 0, hostCpuFraction: 0.1 });
    await f.admission.changed();
  }
  assert.equal((await f.admission.close()).peakActive, 4);
});

test("40 percent is a test-tree budget and uses physical RAM, with other-app headroom", async () => {
  const f = await fixture({ cpuFraction: 0.1, hostCpuFraction: 0.75 });
  assert.equal(await f.admission.canStart(), true, "other applications over 40 percent do not stop admission by themselves");
  f.set({ cpuFraction: 0.1, hostCpuFraction: 1 });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false, "no spare host CPU");
  f.set({ rssBytes: 6.5 * gib });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false, "tree RSS exceeds 40 percent of 16 GiB");
  f.set({ freeMemory: 1 });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false, "other apps consumed the remaining physical memory");
  f.set();
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), true);
  await f.admission.close();
});

test("cooperative admission can start one indivisible file on a small host", async () => {
  const f = await fixture({ cores: 1 });
  assert.equal(await f.admission.canStart(), true);
  f.admission.started();
  assert.equal(await f.admission.canStart(), false);
  f.set({ cores: 1, cpuFraction: 0.95, hostCpuFraction: 1 });
  await f.admission.changed();
  assert.equal(await f.admission.canStart(), false);
  f.admission.finished();
  assert.equal((await f.admission.close()).overshootSamples, 2);
});

test("one checkpoint owner retains cross-suite successes, shared-resource conflicts and original failure order", async () => {
  let saved;
  const active = new Set();
  let peak = 0;
  const started = [];
  const checkpoint = { read: async () => saved, write: async (state) => { saved = structuredClone(state); } };
  const options = {
    suite: "all", identity: "generation", checkpoint, concurrency: Infinity, log: () => {},
    suiteForFile: (file) => file.startsWith("a") ? "architecture" : "unit",
    execution: (file) => ({ parallel: true, shared: file.endsWith("shared") ? ["fixture"] : [] }),
    run: async (file) => {
      if (file.endsWith("shared")) assert.equal([...active].some((other) => other.endsWith("shared")), false);
      active.add(file); started.push(file); peak = Math.max(peak, active.size);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.delete(file);
      if (file === "b-fail") throw new Error(file);
    },
  };
  await assert.rejects(runCheckpointedTestFiles(["a-shared", "b-shared", "b-free", "b-fail"], options), /b-fail/u);
  assert.ok(peak >= 3);
  assert.deepEqual(saved.suites.architecture.completedFingerprints, { "a-shared": "unchanged" });
  assert.deepEqual(saved.suites.unit.completedFingerprints, { "b-free": "unchanged", "b-shared": "unchanged" });
  started.length = 0;
  await runCheckpointedTestFiles(["a-shared", "b-shared", "b-free", "b-fail"], { ...options, run: async (file) => started.push(file) });
  assert.deepEqual(started, ["b-fail"]);
});

test("resource changes wake an idle scheduler; sampling failure drains running tests and preserves successes", async () => {
  let checks = 0;
  let ticks = 0;
  const ran = [];
  await runCheckpointedTestFiles(["a", "b", "c"], {
    suite: "unit", concurrency: Infinity, log: () => {},
    execution: async () => ({ parallel: true }),
    admission: {
      canStart: async () => ++checks > 1,
      started() {}, finished() {},
      changed: async () => { ticks += 1; await new Promise((resolve) => setTimeout(resolve, 2)); },
    },
    run: async (file) => ran.push(file),
  });
  assert.deepEqual(ran, ["a", "b", "c"]);
  assert.ok(ticks > 0);
  let saved;
  let complete = false;
  let starts = 0;
  await assert.rejects(runCheckpointedTestFiles(["first", "unstarted"], {
    suite: "unit", identity: "g", checkpoint: { read: async () => null, write: async (state) => { saved = structuredClone(state); } },
    concurrency: Infinity, execution: async () => ({ parallel: true }), log: () => {},
    admission: {
      canStart: async () => { if (starts) throw new Error("accounting failed"); return true; },
      started: () => { starts += 1; }, finished() {}, changed: async () => {},
    },
    run: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); complete = true; },
  }), /accounting failed/u);
  assert.equal(complete, true);
  assert.equal(starts, 1);
  assert.deepEqual(saved.suites.unit.completedFingerprints, { first: "unchanged" });
});
