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
const { selectCurrentLimitSeries } = context.AgentHubRateLimitSeries;

function selectCurrentLimits(payload) {
  return JSON.parse(JSON.stringify(selectCurrentLimitSeries(payload)));
}

test("current limits select Codex and Spark points for the current account", () => {
  const result = selectCurrentLimits({
    currentAccount: { key: "dark" },
    series: [
      {
        id: "codex:primary",
        name: "CODEX",
        window: "primary",
        points: [
          { accountKey: "sidor", remainingPercent: 70 },
          { accountKey: "dark", remainingPercent: 17, windowDurationMins: 10080 },
        ],
      },
      {
        id: "codex_bengalfox:primary",
        name: "Spark",
        window: "primary",
        points: [{ accountKey: "dark", remainingPercent: 99, windowDurationMins: 300 }],
      },
      {
        id: "codex_bengalfox:secondary",
        name: "Spark",
        window: "secondary",
        points: [{ accountKey: "dark", remainingPercent: 0, windowDurationMins: 10080 }],
      },
      {
        id: "claude:week",
        name: "CLAUDE",
        window: "week",
        points: [{ remainingPercent: 69 }],
      },
    ],
  });

  assert.deepEqual(result.map((item) => [item.label, item.windowLabel, item.point.remainingPercent]), [
    ["CODEX", "7 д.", 17],
    ["Spark", "5 ч.", 99],
    ["Spark", "7 д.", 0],
    ["Claude", "", 69],
  ]);
});

test("current limits preserve legacy series-level account metadata", () => {
  const result = selectCurrentLimits({
    currentAccount: { key: "dark" },
    series: [{
      id: "codex:primary@dark",
      name: "CODEX",
      window: "primary",
      accountKey: "dark",
      points: [{ remainingPercent: 42 }],
    }],
  });

  assert.equal(result[0].point.remainingPercent, 42);
});
