import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../../assets/mini-app/app.js", import.meta.url), "utf8");
const start = app.indexOf("function parseClaudeResetAt");
const end = app.indexOf("\nfunction formatResetCountdown", start);
assert.ok(start >= 0 && end > start, "weekly burn-rate policy must be present");
const policy = app.slice(start, end);

function calculate(series, options = {}) {
  const context = { series, options };
  vm.runInNewContext(
    `${policy}\nglobalThis.result = weeklyBurnRatePoints(series, options);`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
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

  assert.equal(points[0].actualRate, null);
  assert.equal(points[1].actualRate, 175);
  assert.equal(points[1].targetRate, 87.5);
  assert.equal(points[1].overTarget, true);
  assert.equal(points[2].actualRate, 175);
  assert.equal(points[2].targetRate, 70);
  assert.equal(points[2].deviationRate, 105);
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

  assert.equal(points[1].actualRate, 35);
  const expectedTarget = 95 / (points[1].resetMs - points[1].atMs) * (7 * 24 * 60 * 60_000);
  assert.ok(Math.abs(points[1].targetRate - expectedTarget) < 1e-9);
  assert.equal(points[1].overTarget, false);
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
