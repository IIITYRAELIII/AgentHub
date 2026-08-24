import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../assets/web-app/rate-limit-series.js", import.meta.url),
  "utf8",
);
const context = {};
vm.runInNewContext(source, context);
const {
  interpolateRateLimitGaps,
  limitPriceStatistics,
  meanSignedComparisonDeviation,
  rateLimitDeltasByBuckets,
  recoverRateLimitResetGaps,
  signedComparisonDeviations,
} = context.AgentHubRateLimitSeries;

const hour = 60 * 60_000;
const buckets = [
  { start: 0, end: hour },
  { start: hour, end: 2 * hour },
];

function point(atMs, usedPercent, extra = {}) {
  return { at: new Date(atMs).toISOString(), usedPercent, ...extra };
}

test("unchanged limit fills a missing interval with estimated zero usage", () => {
  const result = interpolateRateLimitGaps([
    point(0, 20),
    point(hour, 20),
  ]);

  assert.equal(result.length, 13);
  assert.equal(result.filter((item) => item.estimated).length, 11);
  assert.ok(result.every((item) => item.usedPercent === 20));
  assert.ok(result.slice(1, -1).every((item) => item.estimateKind === "unchanged-gap"));
});

test("changed limit is distributed uniformly through the missing interval", () => {
  const result = interpolateRateLimitGaps([
    point(0, 20, { remainingPercent: null }),
    point(hour, 26, { remainingPercent: null }),
  ]);
  const midpoint = result.find((item) => Date.parse(item.at) === 30 * 60_000);

  assert.equal(midpoint.usedPercent, 23);
  assert.equal(midpoint.remainingPercent, 77);
  assert.equal(midpoint.estimateKind, "distributed-gap");
});

test("reset and account changes remain explicit breaks", () => {
  assert.equal(interpolateRateLimitGaps([
    point(0, 95),
    point(hour, 5),
  ]).length, 2);
  assert.equal(interpolateRateLimitGaps([
    point(0, 20, { accountKey: "old" }),
    point(hour, 20, { accountKey: "new" }),
  ]).length, 2);
});

test("correlation buckets receive a uniform share of an inferred change", () => {
  assert.deepEqual(
    [...rateLimitDeltasByBuckets([point(0, 10), point(2 * hour, 30)], buckets)],
    [10, 10],
  );
  assert.deepEqual(
    [...rateLimitDeltasByBuckets([point(0, 10), point(2 * hour, 10)], buckets)],
    [0, 0],
  );
});

test("correlation leaves reset gaps unknown", () => {
  assert.deepEqual(
    [...rateLimitDeltasByBuckets([point(0, 95), point(2 * hour, 5)], buckets)],
    [null, null],
  );
});

test("correlation recovers reset gaps from accounting usage and neighboring prices", () => {
  const threeBuckets = [
    { start: 0, end: hour },
    { start: hour, end: 2 * hour },
    { start: 2 * hour, end: 3 * hour },
  ];
  const result = recoverRateLimitResetGaps([
    point(0, 5),
    point(hour, 15),
    point(2 * hour, 5),
    point(3 * hour, 15),
  ], threeBuckets, [1_000, 1_000, 1_000]);

  assert.deepEqual([...result.observedValues], [10, null, 10]);
  assert.deepEqual([...result.values], [10, 10, 10]);
  assert.deepEqual([...result.inferredValues], [0, 10, 0]);
  assert.equal(result.recoveredIntervals, 1);
  assert.equal(result.estimatedLimitPoints, 10);
});

test("correlation keeps reset gaps unknown without accounting usage", () => {
  const result = recoverRateLimitResetGaps([
    point(0, 95),
    point(2 * hour, 5),
  ], buckets, [0, 0]);

  assert.deepEqual([...result.values], [null, null]);
  assert.equal(result.recoveredIntervals, 0);
});

test("correlation does not recover a used-percent correction below ten points", () => {
  const result = recoverRateLimitResetGaps([
    point(0, 0),
    point(hour, 10),
    point(2 * hour, 5),
    point(3 * hour, 15),
  ], [
    { start: 0, end: hour },
    { start: hour, end: 2 * hour },
    { start: 2 * hour, end: 3 * hour },
  ], [1_000, 1_000, 1_000]);

  assert.deepEqual([...result.values], [10, null, 10]);
  assert.equal(result.recoveredIntervals, 0);
  assert.equal(result.estimatedLimitPoints, 0);
});

test("correlation uses fine accounting buckets inside a partial reset gap", () => {
  const result = recoverRateLimitResetGaps([
    point(-hour, 0),
    point(0, 10),
    point(hour, 20),
    point(3 * hour, 5),
    point(4 * hour, 15),
    point(5 * hour, 25),
  ], [
    { start: -hour, end: 0 },
    { start: 0, end: 2 * hour },
    { start: 2 * hour, end: 4 * hour },
    { start: 4 * hour, end: 5 * hour },
  ], [1_000, 2_000, 2_000, 1_000], [
    { start: hour, end: 2 * hour, credits: 1_000 },
    { start: 3 * hour, end: 4 * hour, credits: 1_000 },
  ]);

  assert.deepEqual([...result.inferredValues], [0, 10, 0, 0]);
  assert.equal(result.estimatedLimitPoints, 10);
});

test("limit price uses a volume-weighted mean and derives weekly capacity", () => {
  const result = limitPriceStatistics([1_000, 9_000], [5, 9], { splitIndex: 1 });

  assert.equal(result.overall.value, 1.4);
  assert.equal(result.early.value, 5);
  assert.equal(result.late.value, 1);
  assert.equal(result.changePercent, -80);
  assert.ok(Math.abs(result.weeklyCredits - 71_428.57142857143) < 1e-9);
});

test("signed comparison deviations cancel opposite differences in the mean", () => {
  assert.deepEqual(
    [...signedComparisonDeviations([80, 100], [100, 80])],
    [-20, 20],
  );
  assert.equal(meanSignedComparisonDeviation([80, 100], [100, 80]), 0);
});

test("signed comparison deviation excludes unknown interval pairs", () => {
  assert.deepEqual(
    [...signedComparisonDeviations([80, null, 70], [100, 10, 80])],
    [-20, null, -10],
  );
  assert.equal(meanSignedComparisonDeviation([80, null, 70], [100, 10, 80]), -15);
});
