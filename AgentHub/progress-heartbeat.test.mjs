import assert from "node:assert/strict";
import test from "node:test";
import {
  formatProgressHeartbeat,
  markProgressHeartbeat,
  PROGRESS_HEARTBEAT_INTERVAL_MS,
  retainProgressMessageAfterEditError,
} from "./src/runtime/progress-heartbeat.mjs";

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

test("progress heartbeat distinguishes a live connection from real stalled work", () => {
  const run = {
    progressHeartbeatAt: "2026-07-17T20:05:30.000Z",
    progressHeartbeatState: "stalled",
    lastMeaningfulProgressAt: "2026-07-17T20:00:00.000Z",
  };
  assert.equal(
    formatProgressHeartbeat(run, { locale: "ru-RU", timeZone: "UTC" }),
    "🟠 Нет новых событий 5 мин · проверено 20:05:30",
  );
});

test("temporary Telegram edit failures keep the progress message attached", () => {
  assert.equal(retainProgressMessageAfterEditError({ retryable: true, message: "fetch failed" }), true);
  assert.equal(retainProgressMessageAfterEditError(new Error("message is not modified")), true);
  assert.equal(retainProgressMessageAfterEditError(new Error("message to edit not found")), false);
});
