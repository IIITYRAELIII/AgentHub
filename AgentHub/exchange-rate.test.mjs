import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CBR_DAILY_RATES_URL,
  CREDITS_PER_USD,
  parseCbrDailyRatesXml,
  PTE_PER_CREDIT,
  UsdRubRateStore,
} from "./exchange-rate.mjs";

const xml = `<?xml version="1.0" encoding="windows-1251"?>
<ValCurs Date="30.07.2026" name="Foreign Currency Market">
  <Valute ID="R01010">
    <NumCode>036</NumCode><CharCode>AUD</CharCode><Nominal>1</Nominal>
    <Name>Australian Dollar</Name><Value>55,5088</Value><VunitRate>55,5088</VunitRate>
  </Valute>
  <Valute ID="R01235">
    <NumCode>840</NumCode><CharCode>USD</CharCode><Nominal>1</Nominal>
    <Name>US Dollar</Name><Value>78,4049</Value><VunitRate>78,4049</VunitRate>
  </Valute>
</ValCurs>`;

test("CBR daily XML yields a per-dollar RUB rate", () => {
  assert.deepEqual(parseCbrDailyRatesXml(xml), {
    usdRub: 78.4049,
    effectiveDate: "2026-07-30",
    source: "cbr",
    sourceUrl: CBR_DAILY_RATES_URL,
  });
  assert.equal(CREDITS_PER_USD, 25);
  assert.equal(PTE_PER_CREDIT, 16_000);
});

test("USD/RUB rate store refreshes and persists the startup cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rate-"));
  const cacheFile = path.join(root, "exchange-rates.json");
  try {
    const store = new UsdRubRateStore({
      cacheFile,
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.from(xml, "latin1"),
      }),
      now: () => new Date("2026-07-30T14:00:00Z"),
    });
    assert.equal(await store.load(), null);
    assert.equal((await store.refresh()).usdRub, 78.4049);
    const saved = JSON.parse(await readFile(cacheFile, "utf8"));
    assert.equal(saved.fetchedAt, "2026-07-30T14:00:00.000Z");

    const restored = new UsdRubRateStore({ cacheFile });
    assert.equal((await restored.load()).usdRub, 78.4049);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid cached rates are ignored without inventing a fallback", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-rate-invalid-"));
  const cacheFile = path.join(root, "exchange-rates.json");
  try {
    await writeFile(cacheFile, JSON.stringify({ usdRub: 0 }), "utf8");
    const store = new UsdRubRateStore({ cacheFile });
    assert.equal(await store.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
