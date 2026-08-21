import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function qualityApi() {
  const source = await readFile(new URL("../../assets/web-app/connection-quality.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubConnectionQuality;
}

test("connection quality classifies real snapshot latency", async () => {
  const { connectionQuality } = await qualityApi();
  assert.equal(connectionQuality({ status: "online", latencyMs: 120 }).quality, "excellent");
  assert.equal(connectionQuality({ status: "online", latencyMs: 121 }).quality, "good");
  assert.equal(connectionQuality({ status: "online", latencyMs: 301 }).quality, "weak");
  assert.equal(connectionQuality({ status: "online", latencyMs: 801 }).quality, "poor");
  assert.equal(connectionQuality({ status: "offline", latencyMs: 20 }).quality, "offline");
});

test("connection quality smooths jitter and exposes a compact tooltip", async () => {
  const { connectionQualityPresentation, smoothLatency } = await qualityApi();
  assert.equal(smoothLatency(null, 100), 100);
  assert.equal(smoothLatency(100, 200), 135);
  assert.deepEqual(
    { ...connectionQualityPresentation({ status: "online", latencyMs: 85 }) },
    { quality: "excellent", bars: 4, label: "Отличная", latencyMs: 85, title: "Связь: отличная · 85 мс" },
  );
});

test("model response quality uses first provider event timing", async () => {
  const { modelResponseMeasurement, modelResponseQuality } = await qualityApi();
  const requestedAt = "2026-08-21T10:00:00.000Z";
  assert.deepEqual(
    { ...modelResponseMeasurement({ state: "accepted-awaiting-first-event", requestedAt }, Date.parse(requestedAt) + 4_200) },
    { waiting: true, latencyMs: 4_200 },
  );
  assert.deepEqual(
    { ...modelResponseMeasurement({
      state: "observed",
      requestedAt,
      firstEventAt: "2026-08-21T10:00:06.500Z",
    }) },
    { waiting: false, latencyMs: 6_500 },
  );
  assert.deepEqual(
    { ...modelResponseMeasurement({
      state: "unconfirmed",
      requestedAt,
      failedAt: "2026-08-21T10:00:30.000Z",
    }) },
    { failed: true, waiting: false, latencyMs: 30_000 },
  );
  assert.equal(modelResponseQuality({ latencyMs: 3_000 }).quality, "excellent");
  assert.equal(modelResponseQuality({ latencyMs: 3_001 }).quality, "good");
  assert.equal(modelResponseQuality({ latencyMs: 8_001 }).quality, "weak");
  assert.equal(modelResponseQuality({ latencyMs: 20_001 }).quality, "poor");
  assert.equal(modelResponseQuality({ latencyMs: 100, failed: true }).label, "Ошибка");
});
