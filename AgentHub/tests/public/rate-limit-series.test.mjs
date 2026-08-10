import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../assets/mini-app/rate-limit-series.js", import.meta.url),
  "utf8",
);
const context = {};
vm.runInNewContext(source, context);
const {
  interpolateRateLimitGaps,
  meanSignedComparisonDeviation,
  rateLimitDeltasByBuckets,
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
