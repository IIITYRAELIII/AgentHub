import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function statisticsControlsApi() {
  const source = await readFile(
    new URL("../../assets/web-app/statistics-controls.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubStatisticsControls;
}

test("statistics ranges restore and persist every supported period", async () => {
  const {
    LIMITS_RANGE_STORAGE_KEY,
    RANGE_SEQUENCE,
    persistLimitsRange,
    persistRange,
    storedLimitsRange,
    storedRange,
  } = await statisticsControlsApi();
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };

  assert.equal(storedRange(storage, "limits"), "24h");
  for (const range of RANGE_SEQUENCE) {
    assert.equal(persistRange(storage, "limits", range), range);
    assert.equal(storedRange(storage, "limits"), range);
  }
  values.set("limits", "unsupported");
  assert.equal(storedRange(storage, "limits"), "24h");

  assert.equal(LIMITS_RANGE_STORAGE_KEY, "agent-hub:limits-range:v1");
  assert.equal(persistLimitsRange(storage, "30d"), "30d");
  assert.equal(storedLimitsRange(storage), "30d");
});

test("a delayed limits response cannot replace the selected range", async () => {
  const { payloadMatchesSelectedRange } = await statisticsControlsApi();

  assert.equal(payloadMatchesSelectedRange({ range: "24h" }, "7d"), false);
  assert.equal(payloadMatchesSelectedRange({ range: "7d" }, "7d"), true);
  assert.equal(payloadMatchesSelectedRange({ error: "offline" }, "7d"), true);
});

test("statistics ranges survive unavailable storage without breaking the session", async () => {
  const { persistRange, storedRange } = await statisticsControlsApi();
  const storage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
  };

  assert.equal(storedRange(storage, "limits"), "24h");
  assert.equal(persistRange(storage, "limits", "7d"), "7d");
});

test("dataset choice buttons invoke their selector from their own click", async () => {
  const { bindDatasetChoice } = await statisticsControlsApi();
  const listeners = new Map();
  const button = {
    dataset: { comparisonViewMode: "split" },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  const selected = [];

  const unbind = bindDatasetChoice([button], "comparisonViewMode", (value) => selected.push(value));
  listeners.get("click")();
  assert.deepEqual(selected, ["split"]);
  unbind();
  assert.equal(listeners.has("click"), false);
});
