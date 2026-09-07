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
const start = app.indexOf("function parseClaudeResetAt");
const end = app.indexOf("\nfunction formatResetCountdown", start);
assert.ok(start >= 0 && end > start, "weekly burn-rate policy must be present");
const policy = app.slice(start, end);

function calculate(series, options = {}) {
  const context = { series, options, AgentHubRateLimitSeries: rateLimitSeries };
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

function finitePoints(points, field) {
  const context = { points, field, AgentHubRateLimitSeries: rateLimitSeries };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = limitsFiniteSpeedPoints(points, field);`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
}

function at(points, iso) {
  return points.find((point) => point.raw?.at === iso);
}

test("current and 24-hour rates agree during a steady workload", () => {
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

  const second = at(points, "2026-08-02T00:00:00.000Z");
  const third = at(points, "2026-08-03T00:00:00.000Z");
  assert.ok(Math.abs(second.actualRate - 175) < 1);
  assert.ok(Math.abs(second.averageRate - 175) < 1e-9);
  assert.equal(second.averageSpanMs, 24 * 60 * 60_000);
  assert.equal(second.averagePreliminary, false);
  assert.ok(Math.abs(third.actualRate - 175) < 0.01);
  assert.ok(Math.abs(third.averageRate - 175) < 1e-9);
});

test("idle observations lower the three-hour current rate", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, resetsAt: reset },
      { at: "2026-08-01T03:00:00.000Z", usedPercent: 6, resetsAt: reset },
      { at: "2026-08-01T06:00:00.000Z", usedPercent: 6, resetsAt: reset },
      { at: "2026-08-01T09:00:00.000Z", usedPercent: 6, resetsAt: reset },
    ],
  });

  const active = at(points, "2026-08-01T03:00:00.000Z");
  const firstIdle = at(points, "2026-08-01T06:00:00.000Z");
  const secondIdle = at(points, "2026-08-01T09:00:00.000Z");
  assert.ok(active.actualRate > firstIdle.actualRate);
  assert.ok(firstIdle.actualRate > secondIdle.actualRate);
  assert.ok(Math.abs(firstIdle.actualRate - active.actualRate / 2) < 1e-6);
});

test("the first rounded percentage warms up instead of becoming a full spike", () => {
  const fiveMinutes = 5 * 60_000;
  const points = rateLimitSeries.smoothedRateLimitConsumption([
    { atMs: 0, usedPercent: 0, raw: {} },
    { atMs: fiveMinutes, usedPercent: 1, raw: {} },
  ]);

  const latestDailyRate = points.at(-1).currentRate / 7;
  assert.ok(latestDailyRate > 0);
  assert.ok(latestDailyRate < 10);
  assert.equal(points.at(-1).currentPreliminary, true);
});

test("a reset keeps one continuous speed history", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-07T12:00:00.000Z", usedPercent: 20, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-07T21:00:00.000Z", usedPercent: 29, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-08T03:00:00.000Z", usedPercent: 3, resetsAt: "2026-08-15T00:00:00.000Z" },
      { at: "2026-08-08T12:00:00.000Z", usedPercent: 12, resetsAt: "2026-08-15T00:00:00.000Z" },
    ],
  });

  const boundary = points.find((point) => point.resetBoundary);
  const before = at(points, "2026-08-07T21:00:00.000Z");
  const after = at(points, "2026-08-08T03:00:00.000Z");
  assert.ok(boundary);
  assert.equal(boundary.continuityIndex, before.continuityIndex);
  assert.equal(after.continuityIndex, before.continuityIndex);
  assert.ok(Number.isFinite(after.actualRate));
  assert.ok(Number.isFinite(after.averageRate));
  assert.equal(pathFor([
    { x: 1, y: 2, continuityIndex: before.continuityIndex },
    { x: 3, y: 4, continuityIndex: after.continuityIndex },
  ]), "M1.0 2.0 L3.0 4.0");
});

for (const [name, beforeUsed, afterUsed] of [
  ["increasing", 2, 3],
  ["equal", 2, 2],
]) {
  test(`${name} usage still recognizes a full weekly rollover`, () => {
    const points = calculate({
      id: "codex:secondary",
      window: "secondary",
      points: [
        { at: "2026-08-07T22:00:00.000Z", usedPercent: beforeUsed, resetsAt: "2026-08-08T00:00:00.000Z" },
        { at: "2026-08-08T02:00:00.000Z", usedPercent: afterUsed, resetsAt: "2026-08-15T00:00:00.000Z" },
      ],
    });

    const boundary = points.find((point) => point.resetBoundary);
    const latest = at(points, "2026-08-08T02:00:00.000Z");
    assert.ok(boundary);
    assert.equal(boundary.raw.at, "2026-08-08T00:00:00.000Z");
    assert.equal(latest.cumulativeUsed, afterUsed);
    assert.equal(latest.cycleIndex, 1);
  });
}

test("a reset forecast jitter does not create a rollover", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 2, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-01T01:00:00.000Z", usedPercent: 3, resetsAt: "2026-08-08T00:20:00.000Z" },
    ],
  });

  assert.equal(points.some((point) => point.resetBoundary), false);
  assert.equal(points.at(-1).cycleIndex, 0);
  assert.equal(points.at(-1).cumulativeUsed, 1);
});

test("the 24-hour average is visibly preliminary only while history is short", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, resetsAt: reset },
      { at: "2026-08-01T06:00:00.000Z", usedPercent: 4, resetsAt: reset },
      { at: "2026-08-02T06:00:00.000Z", usedPercent: 12, resetsAt: reset },
    ],
  });

  assert.equal(at(points, "2026-08-01T06:00:00.000Z").averagePreliminary, true);
  assert.equal(at(points, "2026-08-02T06:00:00.000Z").averagePreliminary, false);
});

test("the remaining safe pace still controls the status color", () => {
  const points = calculate({
    id: "claude:week",
    window: "week",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 0, resetsText: "Aug 8, 12am" },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 5, resetsText: "Aug 8, 12am" },
    ],
  });

  const latest = at(points, "2026-08-02T00:00:00.000Z");
  const expectedTarget = 95 / (latest.resetMs - latest.atMs) * (7 * 24 * 60 * 60_000);
  assert.ok(Math.abs(latest.targetRate - expectedTarget) < 1e-9);
  assert.equal(latest.overTarget, false);
});

test("a moving reset forecast does not fragment a monotonic cycle", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-01T23:30:00.000Z", usedPercent: 25, resetsAt: "2026-08-08T03:00:00.000Z" },
    ],
  });

  const latest = at(points, "2026-08-01T23:30:00.000Z");
  assert.equal(latest.cycleIndex, 0);
  assert.equal(latest.continuityIndex, 0);
  assert.ok(Number.isFinite(latest.actualRate));
});

test("rate corrections do not count the same consumption twice", () => {
  const hour = 60 * 60_000;
  const points = rateLimitSeries.smoothedRateLimitConsumption([
    { atMs: 0, usedPercent: 10, raw: {} },
    { atMs: hour, usedPercent: 12, raw: {} },
    { atMs: 2 * hour, usedPercent: 11, raw: {} },
    { atMs: 3 * hour, usedPercent: 12, raw: {} },
  ]);

  assert.equal(points.at(-1).cumulativeUsed, 2);
});

test("a downward provider correction is not mistaken for a reset", () => {
  const reset = "2026-08-08T00:00:00.000Z";
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 10, resetsAt: reset },
      { at: "2026-08-02T03:00:00.000Z", usedPercent: 12, resetsAt: reset },
      { at: "2026-08-02T06:00:00.000Z", usedPercent: 11, resetsAt: reset },
      { at: "2026-08-02T09:00:00.000Z", usedPercent: 12, resetsAt: reset },
    ],
  });

  assert.equal(points.some((point) => point.resetBoundary), false);
  assert.equal(points.at(-1).cumulativeUsed, 2);
});

test("speed paths break on account changes and missing values", () => {
  assert.equal(pathFor([
    { x: 1, y: 2, continuityIndex: 0 },
    { x: 3, y: 4, continuityIndex: 1 },
  ]), "M1.0 2.0 M3.0 4.0");

  const points = finitePoints([
    { actualRate: 160, continuityIndex: 0 },
    { actualRate: null, continuityIndex: 0 },
    { actualRate: 0, continuityIndex: 0 },
  ]).map((point, index) => ({ ...point, x: index + 1, y: index + 2 }));
  assert.equal(pathFor(points), "M1.0 2.0 M2.0 3.0");
});

test("weekly speed never spans two accounts", () => {
  const points = calculate({
    id: "codex:secondary",
    window: "secondary",
    points: [
      { at: "2026-08-01T00:00:00.000Z", usedPercent: 10, accountKey: "old", resetsAt: "2026-08-08T00:00:00.000Z" },
      { at: "2026-08-02T00:00:00.000Z", usedPercent: 30, accountKey: "new", resetsAt: "2026-08-08T00:00:00.000Z" },
    ],
  });

  assert.equal(points[1].actualRate, null);
  assert.notEqual(points[1].continuityIndex, points[0].continuityIndex);
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
