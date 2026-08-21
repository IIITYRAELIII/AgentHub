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

test("connection quality classifies Hub control latency", async () => {
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

test("model response quality follows live event silence and compaction", async () => {
  const { modelResponseMeasurement, modelResponseQuality } = await qualityApi();
  const requestedAt = "2026-08-21T10:00:00.000Z";
  const waiting = modelResponseMeasurement(
    { state: "accepted-awaiting-first-event", requestedAt },
    Date.parse(requestedAt) + 4_200,
    { running: true },
  );
  assert.equal(waiting.waiting, true);
  assert.equal(waiting.latencyMs, 4_200);

  const live = modelResponseMeasurement({
      state: "observed",
      requestedAt,
      acceptedAt: requestedAt,
      firstEventAt: "2026-08-21T10:00:06.500Z",
      lastEventAtMs: Date.parse(requestedAt) + 10_000,
      lastContentAtMs: Date.parse(requestedAt) + 8_000,
      maxEventGapMs: 6_500,
      phase: "reasoning",
    }, Date.parse(requestedAt) + 140_001, { running: true });
  assert.equal(live.firstEventMs, 6_500);
  assert.equal(live.eventSilenceMs, 130_001);
  assert.equal(modelResponseQuality(live).quality, "poor");

  const failed = modelResponseMeasurement({
      state: "unconfirmed",
      requestedAt,
      failedAt: "2026-08-21T10:00:30.000Z",
    }, Date.parse(requestedAt) + 30_000, { running: false });
  assert.equal(failed.failed, true);
  assert.equal(failed.latencyMs, 30_000);
  assert.equal(modelResponseQuality(failed).label, "Ошибка");

  const compaction = modelResponseMeasurement(null, Date.parse(requestedAt) + 301_000, {
    running: false,
    compaction: {
      status: "running",
      stage: "compacting",
      startedAt: requestedAt,
    },
  });
  assert.equal(compaction.compaction.elapsedMs, 301_000);
  assert.equal(modelResponseQuality(compaction).quality, "poor");
});

test("connection latency measures the lightweight Hub probe roundtrip", async () => {
  const { measureLatency } = await qualityApi();
  const timestamps = [1_000, 1_086];
  assert.equal(await measureLatency(async () => {}, () => timestamps.shift()), 86);
});

test("model link state exposes the three header states", async () => {
  const { modelLinkState } = await qualityApi();
  assert.deepEqual(
    { ...modelLinkState({ measurement: { latencyMs: 240 } }) },
    {
      bars: 3,
      label: "Связь нормальная",
      latencyMs: 240,
      quality: "good",
      retry: false,
      state: "normal",
    },
  );
  assert.deepEqual(
    { ...modelLinkState({ measurement: { latencyMs: 1_900 } }) },
    {
      bars: 2,
      label: "Плохая связь",
      latencyMs: 1_900,
      quality: "weak",
      retry: false,
      state: "weak",
    },
  );
  assert.deepEqual(
    { ...modelLinkState({ measurement: { latencyMs: 2_000, failed: true } }) },
    {
      bars: 0,
      label: "Нет связи",
      latencyMs: 2_000,
      quality: "offline",
      retry: true,
      state: "offline",
    },
  );
  assert.equal(modelLinkState({ status: "offline", latencyMs: 80 }).state, "offline");
  assert.equal(modelLinkState({ status: "online" }).retry, true);
});
