import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_HEARTBEAT_INTERVAL_MS,
} from "./progress-heartbeat.mjs";

test("progress heartbeat refreshes on state changes and then at a bounded interval", () => {
  const run = {};
  const startedAt = Date.parse("2026-07-17T20:00:00.000Z");

  assert.equal(markProgressHeartbeat(run, "active", startedAt), true);
  assert.equal(markProgressHeartbeat(run, "active", startedAt + 1_000), false);
  assert.equal(markProgressHeartbeat(run, "waiting", startedAt + 1_000), true);
  assert.equal(
    markProgressHeartbeat(run, "waiting", startedAt + PROGRESS_HEARTBEAT_INTERVAL_MS + 1_000),
    true,
  );
});

test("progress heartbeat renders explicit active, waiting and error states", () => {
  const run = {
    progressHeartbeatAt: "2026-07-17T20:00:00.000Z",
    progressHeartbeatState: "active",
  };
  const options = { locale: "ru-RU", timeZone: "UTC" };

  assert.equal(formatProgressHeartbeat(run, options), "🟢 Ход активен · проверено 20:00:00");
  run.progressHeartbeatState = "waiting";
  assert.equal(formatProgressHeartbeat(run, options), "🟡 Жду данные хода · проверено 20:00:00");
  run.progressHeartbeatState = "error";
  assert.equal(formatProgressHeartbeat(run, options), "🔴 Проверка хода не удалась · 20:00:00");
});
