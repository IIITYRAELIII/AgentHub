import assert from "node:assert/strict";
import test from "node:test";
import { measureStartupBeforeTrace } from "../../src/composition/command-trace-composition.mjs";

test("pre-worker startup timing excludes delayed recording and survives wall-clock changes", async () => {
  let wall = 1_000;
  let mono = 10;
  const expected = {};
  const measurement = await measureStartupBeforeTrace("configuration", async () => {
    wall = 500;
    mono = 35;
    return expected;
  }, { clock: () => wall, monotonicClock: () => mono });
  assert.equal(measurement.value, expected);
  wall = 8_000;
  mono = 9_000;
  const spans = [];
  const trace = { recordBestEffort: (span) => spans.push(span) };
  measurement.record(trace);
  measurement.record(trace);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].observedAtMs, 1_000);
  assert.equal(spans[1].observedAtMs, 500);
  assert.equal(spans[1].monotonicDurationMs, 25);
  assert.equal(spans[0].metadata.operationSpanId, spans[1].spanId);
  assert.equal(spans[1].metadata.bufferedUntilTraceReady, true);
});

test("pre-worker startup failure retains the original failure", async () => {
  const failure = new Error("configuration unavailable");
  await assert.rejects(measureStartupBeforeTrace("configuration", async () => { throw failure; }),
    (error) => error === failure);
});
