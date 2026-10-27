import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";
import { createRuntimeCpuSample, summarizeRuntimeCpuProfile } from "../../src/application/runtime-cpu-sample.mjs";
import { createRuntimePerformanceSampler } from "../../src/application/runtime-performance-sampler.mjs";

const profile = { nodes: [
  { id: 1, children: [2], callFrame: { functionName: "(root)", url: "" } },
  { id: 2, children: [3], callFrame: { functionName: "project", url: new URL("../../src/application/runtime-cpu-sample.mjs", import.meta.url).href, lineNumber: 10 } },
  { id: 3, callFrame: { functionName: "private prompt", url: "file:///C:/private/secret.js", lineNumber: 20 } },
], samples: [2, 2, 3], timeDeltas: [10000, 10000, 10000] };

test("CPU profile retains bounded code locations and rejects external source/name content", () => {
  const result = summarizeRuntimeCpuProfile(profile);
  assert.equal(result.sampledMs, 30);
  assert.equal(result.hotspots[0].stack[0].file, "src/application/runtime-cpu-sample.mjs");
  assert.equal(result.hotspots[1].stack[0].file, "external");
  assert.equal(result.hotspots[1].stack[0].function, "(anonymous)");
  assert.doesNotMatch(JSON.stringify(result), /private|secret|file:|C:/u);
  assert.equal(result.hotspots[1].stack[1].function, "project");
  const large = summarizeRuntimeCpuProfile({ ...profile, samples: Array(50001).fill(2), timeDeltas: Array(50001).fill(10000) });
  assert.equal(large.samples, 50000);
  assert.equal(large.truncated, true);
});

function fakeSession({ fail = "", held = "" } = {}) {
  const calls = [], callbacks = [];
  return { calls, callbacks, disconnected: 0,
    connect() { calls.push("connect"); },
    disconnect() { this.disconnected += 1; },
    post(method, params, callback) {
      calls.push(method);
      if (method === held) callbacks.push(() => callback(null, {}));
      else callback(method === fail ? new Error("private failure") : null, method === "Profiler.stop" ? { profile } : {});
    },
  };
}

test("existing health sampler triggers only one bounded internal sample and shutdown finishes it", async () => {
  const session = fakeSession(), spans = [];
  let callback, cleared = false, healthLoop = 100;
  const sample = createRuntimeCpuSample({ instanceId: "one", trace: { recordBestEffort: x => spans.push(x) },
    createSession: () => session, setTimeoutImpl: fn => ({ unref() {}, fn }), clearTimeoutImpl: () => { cleared = true; } });
  const sampler = createRuntimePerformanceSampler({ instanceId: "one", trace: { recordBestEffort() {} },
    readHealth: () => ({ diagnostics: { process: { eventLoopDelayP95Ms: healthLoop } } }), cpuSample: sample,
    setIntervalImpl: fn => { callback = fn; return { unref() {} }; }, clearIntervalImpl() {} });
  sampler.start(); callback();
  assert.deepEqual(session.calls, []);
  healthLoop = 2200; callback(); callback();
  assert.deepEqual(session.calls, ["connect", "Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start"]);
  await sampler.stop();
  assert.equal(cleared, true);
  assert.equal(session.disconnected, 1);
  assert.equal(spans.filter(x => x.stage === "runtime-cpu-sample" && x.outcome === "started").length, 1);
  assert.equal(spans.find(x => x.stage === "runtime-cpu-sample" && x.outcome === "succeeded").metadata.interrupted, true);
  assert.equal(spans.filter(x => x.stage === "runtime-cpu-hotspot").length, 2);
  assert.doesNotMatch(JSON.stringify(spans), /private|secret/u);
});

test("profiler setup failure and shutdown-before-start are terminal, closed and never retried", async () => {
  for (const options of [{ fail: "Profiler.start" }, { held: "Profiler.enable" }]) {
    const session = fakeSession(options), spans = [];
    const sample = createRuntimeCpuSample({ instanceId: "failure", trace: { recordBestEffort: x => spans.push(x) }, createSession: () => session });
    const result = sample.start({ eventLoopDelayP95Ms: 3000 });
    await sample.stop();
    session.callbacks.forEach(fn => fn());
    await result;
    sample.start({ eventLoopDelayP95Ms: 4000 });
    assert.equal(session.disconnected, 1);
    assert.equal(spans.filter(x => x.stage === "runtime-cpu-sample" && x.outcome !== "started").length, 1);
  }
});

test("native internal profiler runs without a network inspector endpoint and emits bounded summaries", async () => {
  const spans = [], keepAlive = setInterval(() => {}, 1000);
  const before = (await import("node:inspector")).url();
  try {
    const sample = createRuntimeCpuSample({ instanceId: "native", durationMs: 50,
      trace: { recordBestEffort: x => spans.push(x) } });
    await sample.start({ eventLoopDelayP95Ms: 2500 });
    assert.equal((await import("node:inspector")).url(), before);
    assert.equal(spans.find(x => x.stage === "runtime-cpu-sample" && x.outcome === "succeeded").metadata.targetDurationMs, 50);
    for (const span of spans) assert.ok(Buffer.byteLength(JSON.stringify(span.metadata)) < 16384);
  } finally { clearInterval(keepAlive); }
});

test("CPU sample success and setup failure survive the existing SQLite worker and reopen", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "cpu-trace-worker-"));
  const composition = createCommandTraceComposition({ dataDir });
  try {
    await composition.initialize();
    for (const [instanceId, options] of [["success", {}], ["failure", { fail: "Profiler.start" }]]) {
      const sample = createRuntimeCpuSample({ instanceId, trace: composition.service,
        createSession: () => fakeSession(options), setTimeoutImpl: () => ({ unref() {} }), clearTimeoutImpl() {} });
      sample.start({ eventLoopDelayP95Ms: 2500 });
      await sample.stop();
    }
    await composition.close();
    const db = new DatabaseSync(path.join(dataDir, "command-traces.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT command_id, stage, outcome, metadata_json FROM command_trace_spans ORDER BY sequence").all();
      for (const [id, outcome] of [["success", "succeeded"], ["failure", "failed"]]) {
        assert.deepEqual(rows.filter(x => x.command_id === `runtime:${id}` && x.stage === "runtime-cpu-sample")
          .map(x => x.outcome), ["started", outcome]);
      }
      assert.ok(rows.some(x => x.stage === "runtime-cpu-hotspot"));
      assert.doesNotMatch(JSON.stringify(rows), /private|secret|file:\/\/\/C:/u);
    } finally { db.close(); }
  } finally { await composition.close(); await rm(dataDir, { recursive: true, force: true }); }
});
