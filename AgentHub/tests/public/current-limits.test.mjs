import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const app = await readFile(new URL("../../assets/mini-app/app.js", import.meta.url), "utf8");
const start = app.indexOf("function currentLimitSeries");
const end = app.indexOf("\nfunction renderCurrentLimits", start);
assert.ok(start >= 0 && end > start, "current limit selection policy must be present");

function selectCurrentLimits(payload) {
  const context = { payload };
  vm.runInNewContext(
    `${app.slice(start, end)}\nglobalThis.result = currentLimitSeries(payload);`,
    context,
  );
  return JSON.parse(JSON.stringify(context.result));
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
          { accountKey: "dark", remainingPercent: 17 },
        ],
      },
      {
        id: "codex_bengalfox:primary",
        name: "Spark",
        window: "primary",
        points: [{ accountKey: "dark", remainingPercent: 99 }],
      },
      {
        id: "claude:week",
        name: "CLAUDE",
        window: "week",
        points: [{ remainingPercent: 69 }],
      },
    ],
  });

  assert.deepEqual(result.map((item) => [item.label, item.point.remainingPercent]), [
    ["CODEX", 17],
    ["Spark", 99],
    ["Claude", 69],
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
