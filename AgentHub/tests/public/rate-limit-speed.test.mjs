import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../../assets/web-app/app.js", import.meta.url), "utf8");
const rateLimitSeriesSource = await readFile(
  new URL("../../assets/web-app/rate-limit-series.js", import.meta.url),
  "utf8",
);
const rateLimitSeriesContext = {};
vm.runInNewContext(rateLimitSeriesSource, rateLimitSeriesContext);
const rateLimitSeries = rateLimitSeriesContext.AgentHubRateLimitSeries;
const { interpolateRateLimitGaps } = rateLimitSeries;
const start = app.indexOf("function parseClaudeResetAt");
const end = app.indexOf("\nfunction formatResetCountdown", start);
assert.ok(start >= 0 && end > start, "weekly burn-rate policy must be present");
const policy = app.slice(start, end);

function calculate(series, options = {}) {
  const context = { series, options, interpolateRateLimitGaps, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = weeklyBurnRatePoints(series, options);`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

function pathFor(points) {
  const context = { points, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = limitsSpeedPath(points);`,
    context,
  );
  return context.result;
}

function finitePoints(points) {
  const context = { points, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = limitsFiniteSpeedPoints(points);`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

function waitsForData(speedFullWindow, latest, range) {
  const context = { speedFullWindow, latest, range, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = shouldWaitForBurnRateData(speedFullWindow, latest, range);`,
    context,
  );
  return context.result;
}

function calculateForRange(series, range) {
  const context = { series, range, interpolateRateLimitGaps, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = weeklyBurnRatePoints(series, burnRatePolicyForRange(range));`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

function at(points, iso) {
  return points.find((point) => point.raw?.at === iso);
}

test("weekly burn rate compares rolling usage with the remaining safe pace", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, remainingPercent: 100, resetsAt: reset, windowDurationMins: 10080 },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 25, remainingPercent: 75, resetsAt: reset, windowDurationMins: 10080 },
      { at: "2026-08-03T00:00:00.000Z", usedPercent: 50, remainingPercent: 50, resetsAt: reset, windowDurationMins: 10080 },
    ],
  });

  const first = at(points, "2026-08-01T00:00:00.000Z");
  const second = at(points, "2026-08-02T00:00:00.000Z");
  const third = at(points, "2026-08-03T00:00:00.000Z");
  assert.equal(first.actualRate, null);
  assert.equal(second.actualRate, 175);
  assert.equal(second.sampleSpanMs, 24 * 60 * 60_000);
  assert.equal(second.targetRate, 87.5);
  assert.equal(second.overTarget, true);
  assert.equal(third.actualRate, 175);
  assert.equal(third.targetRate, 70);
  assert.equal(third.deviationRate, 105);
});

test("weekly burn rate marks a pace below the dynamic allowance as safe", () => {
  const points = calculate({
    id: "claude:week",
    window: "week",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, resetsText: "Aug 8, 12am" },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 5, resetsText: "Aug 8, 12am" },
    ],
  });

  const latest = at(points, "2026-08-02T00:00:00.000Z");
  assert.equal(latest.actualRate, 35);
  const expectedTarget = 95 / (latest.resetMs - latest.atMs) * (7 * 24 * 60 * 60_000);
  assert.ok(Math.abs(latest.targetRate - expectedTarget) < 1e-9);
  assert.equal(latest.overTarget, false);
});

test("weekly burn rate waits for an almost complete 24-hour window", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, resetsAt: reset },
      { at: "2026-08-01T06:00:00.000Z", usedPercent: 8, resetsAt: reset },
      { at: "2026-08-01T23:30:00.000Z", usedPercent: 20, resetsAt: reset },
    ],
  });

  assert.equal(at(points, "2026-08-01T06:00:00.000Z").actualRate, null);
  assert.ok(Number.isFinite(at(points, "2026-08-01T23:30:00.000Z").actualRate));
});

for (const range of ["6h", "24h"]) {
  test(`${range} speed uses the latest hour instead of waiting for a day`, () => {
    const reset = "2026-08-08T00:00:00.000Z";
    const points = calculateForRange({
      id: "codex:secondary",
      window: "secondary",
      points: [
        { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, resetsAt: reset },
        { at: "2026-08-01T00:50:00.000Z", usedPercent: 11, resetsAt: reset },
      ],
    }, range);

    const latest = at(points, "2026-08-01T00:50:00.000Z");
    assert.ok(Number.isFinite(latest.actualRate));
    assert.equal(latest.cycleIndex, 0);
  });
}

test("speed chart starts a new path at every weekly reset", () => {
  assert.equal(pathFor([
    { x: 1, y: 2, cycleIndex: 0 },
    { x: 3, y: 4, cycleIndex: 0 },
    { x: 5, y: 6, cycleIndex: 1 },
  ]), "M1.0 2.0 L3.0 4.0 M5.0 6.0");
});

test("missing speed samples break the actual-rate path", () => {
  const points = finitePoints([
    { actualRate: 160, cycleIndex: 0 },
    { actualRate: null, cycleIndex: 0 },
    { actualRate: 0, cycleIndex: 0 },
  ]).map((point, index) => ({ ...point, x: index + 1, y: index + 2 }));

  assert.equal(pathFor(points), "M1.0 2.0 M2.0 3.0");
});

test("full-window setting alone enables waiting for speed data", () => {
  const latest = { cycleAgeMs: 30 * 60_000 };
  assert.equal(waitsForData(true, latest, "24h"), true);
  assert.equal(waitsForData(false, latest, "24h"), false);
  assert.equal(waitsForData(true, { cycleAgeMs: 50 * 60_000 }, "24h"), false);
});

test("a moving reset forecast does not fragment one monotonic cycle", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-01T23:30:00.000Z", usedPercent: 25, resetsAt: "2026-08-08T03:00:00.000Z" },
    ],
  });

  const first = at(points, "2026-08-01T00:00:00.000Z");
  const latest = at(points, "2026-08-01T23:30:00.000Z");
  assert.equal(first.cycleIndex, 0);
  assert.equal(latest.cycleIndex, 0);
  assert.ok(Number.isFinite(latest.actualRate));
});

test("daily speed tolerates sparse snapshots around the 24-hour baseline", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, resetsAt: reset },
      { at: "2026-08-02T06:00:00.000Z", usedPercent: 30, resetsAt: reset },
    ],
  });

  assert.ok(Number.isFinite(at(points, "2026-08-02T06:00:00.000Z").actualRate));
});

test("weekly burn rate never carries a negative delta across a reset", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-07T22:00:00.000Z", usedPercent: 98, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-08T02:00:00.000Z", usedPercent: 2, resetsAt: "2026-08-15T00:00:00.000Z" },
    ],
  });

  assert.equal(points[1].actualRate, null);
  assert.equal(points[1].overTarget, false);
});

test("preliminary speed pins a detected reset to zero without inventing an account baseline", () => {
  const options = { minimumSpanMs: 0, showResetStartAsZero: true };
  const resetPoints = calculate({
    id: "codex:primary",
    window: "primary",
    points: [
      { at: "2026-08-07T22:00:00.000Z", usedPercent: 14, accountKey: "same", resetsAt: "2026-08-08T00:00:00.000Z", windowDurationMins: 10080 },
      { at: "2026-08-08T02:00:00.000Z", usedPercent: 6, accountKey: "same", resetsAt: "2026-08-15T00:00:00.000Z", windowDurationMins: 10080 },
    ],
  }, options);
  const accountPoints = calculate({
    id: "codex:primary",
    window: "primary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, accountKey: "old", resetsAt: "2026-08-08T00:00:00.000Z", windowDurationMins: 10080 },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 30, accountKey: "new", resetsAt: "2026-08-08T00:00:00.000Z", windowDurationMins: 10080 },
    ],
  }, options);

  assert.equal(resetPoints[0].actualRate, null);
  assert.equal(resetPoints[1].actualRate, 0);
  assert.equal(resetPoints[1].sampleSpanMs, 0);
  assert.equal(accountPoints[1].actualRate, null);
});

test("weekly burn rate never spans two accounts", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, accountKey: "old", resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 30, accountKey: "new", resetsAt: "2026-08-08T00:00:00.000Z" },
    ],
  });

  assert.equal(points[1].actualRate, null);
  assert.equal(points[1].cycleIndex, 1);
});

test("speed mode excludes a known short limit window", () => {
  assert.deepEqual(calculate({
    id: "codex:primary",
    window: "primary",
    points: [{
      at: "2026-08-01T00:00:00.000Z",
      usedPercent: 10,
      resetsAt: "2026-08-01T05:00:00.000Z",
      windowDurationMins: 300,
    }],
  }), []);
});
