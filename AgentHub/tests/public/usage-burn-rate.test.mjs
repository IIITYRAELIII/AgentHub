import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../assets/web-app/usage-burn-rate.js", import.meta.url),
  "utf8",
);
const context = {};
vm.runInNewContext(source, context);
const { buildUsageBurnRate } = context.AgentHubUsageBurnRate;

function fixedPoint(at, credits = 0, extra = {}) {
  return { at, credits, ...extra };
}

function localIso(hour, minute = 0, dayOffset = 0) {
  return new Date(2026, 7, 11 + dayOffset, hour, minute, 0, 0).toISOString();
}

test("calendar EMA decays after a short usage spike", () => {
  const analysis = buildUsageBurnRate({
    from: localIso(0),
    to: localIso(2),
    axisTo: localIso(0, 0, 1),
    bucketMs: 30 * 60_000,
    totalCredits: 1_890,
    points: [
      fixedPoint(localIso(0), 1_890),
      fixedPoint(localIso(0, 30), 0),
      fixedPoint(localIso(1), 0),
      fixedPoint(localIso(1, 30), 0),
      fixedPoint(localIso(2), 0),
    ],
  });

  assert.equal(analysis.points[0].rawRate, 63);
  assert.equal(analysis.points[0].emaRate, 63);
  assert.ok(analysis.emaRate > 0);
  assert.ok(analysis.emaRate < 30);
});

test("whole current day payload receives day averages and EMA forecast", () => {
  const analysis = buildUsageBurnRate({
    from: localIso(0),
    to: localIso(12),
    axisTo: localIso(0, 0, 1),
    bucketMs: 60 * 60_000,
    totalCredits: 7_200,
    points: Array.from({ length: 13 }, (_, hour) => fixedPoint(
      localIso(hour),
      hour === 0 ? 0 : 600,
    )),
  });

  assert.equal(analysis.forecastAvailable, true);
  assert.equal(analysis.elapsedDayMinutes, 12 * 60);
  assert.equal(analysis.remainingDayMinutes, 12 * 60);
  assert.equal(analysis.calendarDayRate, 10);
  assert.equal(analysis.forecastDayAverage, 14_400);
  assert.equal(analysis.forecastDay, analysis.totalCredits + analysis.emaRate * analysis.remainingDayMinutes);
});

test("work intensity is independent from calendar EMA", () => {
  const analysis = buildUsageBurnRate({
    from: localIso(0),
    to: localIso(1),
    axisTo: localIso(0, 0, 1),
    bucketMs: 30 * 60_000,
    totalCredits: 100,
    totalTimedCredits: 90,
    totalDurationSeconds: 3 * 60,
    points: [
      fixedPoint(localIso(0), 50, { timedCredits: 40, durationSeconds: 60 }),
      fixedPoint(localIso(0, 30), 50, { timedCredits: 50, durationSeconds: 120 }),
    ],
  });

  assert.equal(analysis.workRate, 30);
  assert.notEqual(analysis.workRate, analysis.emaRate);
});

test("non-day ranges do not expose a daily forecast", () => {
  const analysis = buildUsageBurnRate({
    from: "2026-08-11T06:00:00.000Z",
    to: "2026-08-11T12:00:00.000Z",
    axisTo: "2026-08-11T12:00:00.000Z",
    bucketMs: 30 * 60_000,
    totalCredits: 120,
    points: [
      fixedPoint("2026-08-11T11:30:00.000Z", 60),
      fixedPoint("2026-08-11T12:00:00.000Z", 60),
    ],
  });

  assert.equal(analysis.forecastAvailable, false);
  assert.equal(analysis.forecastDay, null);
  assert.equal(analysis.calendarDayRate, null);
});
